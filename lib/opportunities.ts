import { feeKey, quoteFresh, type Quote, type Settings, type Venue } from "./market";
import { dollarStablecoins, isDollarStable, keyOf, type Market } from "./markets";

// Route math for the background engine. Every opportunity is valued in USD, paying the taker fee on
// every leg and the price-movement buffer per leg, and is sized to the top of each order book.
//
// - cross:    buy a coin on one venue and sell it on another. Either side may be priced in USD, USDT or
//             USDC; a stablecoin leg requires that venue's fresh stablecoin/USD book, including conversion
//             fees and available conversion depth. Cross-venue median rates are reporting-only.
// - triangle: USD -> A -> B -> USD on a single venue, e.g. USD -> BTC -> ETH -> USD or USD -> USDT -> SOL -> USD.

export const QUOTE_TTL_MS = 12_000;
export const MAX_LEG_SKEW_MS = 4_000;
const MIN_NOTIONAL = 5;

// `market` and `size` identify the exact top-of-book quote a leg would trade against; `qty` is the order size
// in base units and `fee` the taker fee as a fraction, used to replay the order against later books.
export type Leg = {
  venue: Venue; pair: string; base: string; quote: string; side: "buy" | "sell"; price: number;
  market: string; size: number; qty: number; fee: number;
};
export type Opportunity = {
  key: string; kind: "cross" | "triangle"; coin: string; venues: Venue[]; path: string; legs: Leg[];
  notional: number; grossPct: number; net: number; netPct: number;
  fees: number; conversion: number; buffer: number; ageMs: number; suspect: boolean;
};
export type Rate = { mid: number; bid: number; ask: number; venues: number };
export type ScanInput = {
  markets: Market[]; quotes: Map<string, Quote>; settings: Settings; conversionFee: number;
  balance: number; now: number; triangular: boolean;
  // Which routes each market takes part in; built from `markets` when not given.
  index?: RouteIndex;
  // Normalize quantities and constrain funding before ranking execution candidates. Display values remain raw.
  prepare?: (opportunity: Opportunity) => Opportunity | null;
  // Execution selection is independent of the dashboard's top-20 display limit.
  eligible?: (opportunity: Opportunity) => boolean;
};
export type ScanResult = {
  top: Opportunity[]; suspects: Opportunity[]; best: Opportunity | null; bestEligible: Opportunity | null; rates: Record<string, Rate>;
  evaluated: { cross: number; triangle: number };
};

const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Keeps the n largest items by score without sorting everything.
class TopN {
  readonly items: Opportunity[] = [];
  constructor(private readonly n: number, private readonly score: (o: Opportunity) => number) {}
  floor() { return this.items.length < this.n ? -Infinity : this.score(this.items[this.items.length - 1]); }
  add(item: Opportunity) {
    const s = this.score(item);
    if (s <= this.floor()) return;
    let i = this.items.length;
    while (i > 0 && this.score(this.items[i - 1]) < s) i--;
    this.items.splice(i, 0, item);
    if (this.items.length > this.n) this.items.pop();
  }
}

// The shape of every route, worked out once per set of markets: a cross route is any two of a coin's
// dollar-priced books on different venues; a triangle is USD -> A -> B -> USD over three books on one venue.
type Step = { m: Market; side: "buy" | "sell"; to: string };
type Triangle = { venue: Venue; steps: [Step, Step, Step] };
export type RouteIndex = {
  stable: Market[];
  crossByCoin: Map<string, Market[]>;
  // Local stablecoin/USD books affect all coin books quoted in that currency on the same venue.
  crossByConversion: Map<string, Market[]>;
  triangles: Triangle[];
  trianglesByMarket: Map<string, Triangle[]>;
};

export function indexRoutes(markets: Market[]): RouteIndex {
  const stable = markets.filter((m) => isDollarStable(m.base) && m.quote === "USD");
  const crossByCoin = new Map<string, Market[]>();
  for (const m of markets) {
    if (!(m.quote === "USD" || isDollarStable(m.quote)) || isDollarStable(m.base)) continue;
    crossByCoin.set(m.base, [...(crossByCoin.get(m.base) || []), m]);
  }
  const crossByConversion = new Map<string, Market[]>();
  for (const books of crossByCoin.values()) for (const m of books) {
    if (!isDollarStable(m.quote)) continue;
    const key = `${m.venue}|${m.quote}/USD`;
    crossByConversion.set(key, [...(crossByConversion.get(key) || []), m]);
  }
  const triangles: Triangle[] = [];
  const byVenue = new Map<Venue, Market[]>();
  for (const m of markets) byVenue.set(m.venue, [...(byVenue.get(m.venue) || []), m]);
  for (const [venue, list] of byVenue) {
    const out = new Map<string, Step[]>();
    const add = (from: string, step: Step) => out.set(from, [...(out.get(from) || []), step]);
    for (const m of list) { add(m.quote, { m, side: "buy", to: m.base }); add(m.base, { m, side: "sell", to: m.quote }); }
    const toUsd = new Map<string, Step>();
    for (const [from, steps] of out) for (const step of steps) if (step.to === "USD" && from !== "USD") toUsd.set(from, step);
    for (const e1 of out.get("USD") || []) for (const e2 of out.get(e1.to) || []) {
      if (e2.to === "USD" || e2.to === e1.to) continue;
      const e3 = toUsd.get(e2.to);
      if (e3) triangles.push({ venue, steps: [e1, e2, e3] });
    }
  }
  const trianglesByMarket = new Map<string, Triangle[]>();
  for (const t of triangles) for (const key of new Set(t.steps.map((step) => keyOf(step.m))))
    trianglesByMarket.set(key, [...(trianglesByMarket.get(key) || []), t]);
  return { stable, crossByCoin, crossByConversion, triangles, trianglesByMarket };
}

type Entry = {
  m: Market; q: Quote; mid: number; cost: number; value: number; fee: number; at: number; latestAt: number;
  buyCapacity: number; sellCapacity: number;
};

// Everything a route's value depends on besides its own books: fees, the buffer, the budget and each
// stablecoin's live dollar value.
function valuation(input: ScanInput, index: RouteIndex) {
  const { quotes, settings, now } = input;
  const slip = settings.buffer / 100;
  const budget = Math.max(0, Math.min(settings.budget, input.balance));
  const taker = (venue: Venue) => (settings[feeKey[venue]] as number) / 100;
  // Stablecoin/USD and stablecoin/stablecoin books use the venue's stablecoin schedule when it is cheaper.
  const pairFee = (m: Market) => isDollarStable(m.base) && (m.quote === "USD" || isDollarStable(m.quote))
    ? Math.min(taker(m.venue), input.conversionFee / 100) : taker(m.venue);
  const fresh = (m: Market) => {
    const q = quotes.get(keyOf(m));
    return q && quoteFresh(q, now, QUOTE_TTL_MS)
      && [q.bid, q.bidSize, q.ask, q.askSize].every((n) => Number.isFinite(n) && n > 0) && q.ask >= q.bid ? q : undefined;
  };

  // Live dollar value of each stablecoin, per venue and as a cross-venue median.
  const stableBooks = new Map<string, { market: Market; quote: Quote }>();
  const rates: Record<string, Rate> = {};
  for (const coin of dollarStablecoins) {
    const books = index.stable.filter((m) => m.base === coin).flatMap((m) => { const q = fresh(m); return q ? [{ market: m, quote: q }] : []; });
    for (const book of books) stableBooks.set(`${book.market.venue}|${coin}`, book);
    if (books.length) rates[coin] = {
      mid: median(books.map((b) => (b.quote.bid + b.quote.ask) / 2)), bid: median(books.map((b) => b.quote.bid)),
      ask: median(books.map((b) => b.quote.ask)), venues: books.length,
    };
  }
  // USD value of one unit of `currency` on `venue`: mid for reporting, ask/bid after conversion cost.
  const dollar = (venue: Venue, currency: string) => {
    if (currency === "USD") return { mid: 1, buy: 1, sell: 1, at: null, buyCapacity: Infinity, sellCapacity: Infinity };
    const book = stableBooks.get(`${venue}|${currency}`);
    if (book) {
      const fee = pairFee(book.market);
      return { mid: (book.quote.bid + book.quote.ask) / 2, buy: book.quote.ask * (1 + fee), sell: book.quote.bid * (1 - fee),
        at: book.quote.receivedAt, buyCapacity: book.quote.askSize, sellCapacity: book.quote.bidSize };
    }
    // Another exchange's median cannot execute this venue's currency conversion.
    return null;
  };
  const entries = (coin: string): Entry[] => (index.crossByCoin.get(coin) || []).flatMap((m) => {
    const q = fresh(m);
    const d = q && dollar(m.venue, m.quote);
    return q && d ? [{ m, q, mid: d.mid, cost: d.buy, value: d.sell, fee: taker(m.venue),
      at: Math.min(q.receivedAt, d.at ?? q.receivedAt), latestAt: Math.max(q.receivedAt, d.at ?? q.receivedAt),
      buyCapacity: d.buyCapacity, sellCapacity: d.sellCapacity }] : [];
  });

  // Buy on a's book, sell on b's.
  const cross = (coin: string, a: Entry, b: Entry): Opportunity | null => {
    if (a.m.venue === b.m.venue || Math.max(a.latestAt, b.latestAt) - Math.min(a.at, b.at) > MAX_LEG_SKEW_MS) return null;
    const askMid = a.q.ask * a.mid, bidMid = b.q.bid * b.mid;
    const qty = Math.min(budget / (a.q.ask * a.cost * (1 + a.fee + slip)), a.q.askSize, b.q.bidSize,
      a.buyCapacity / (a.q.ask * (1 + a.fee)), b.sellCapacity / (b.q.bid * (1 - b.fee)));
    if (!Number.isFinite(qty) || qty <= 0 || qty * askMid < MIN_NOTIONAL) return null;
    const grossPct = (bidMid / askMid - 1) * 100;
    const fees = qty * askMid * a.fee + qty * bidMid * b.fee;
    // Convert the actual quote-currency spend/proceeds, including the trading fee on each leg.
    const conversion = qty * a.q.ask * (1 + a.fee) * (a.cost - a.mid) + qty * b.q.bid * (1 - b.fee) * (b.mid - b.value);
    const buffer = qty * (askMid + bidMid) * slip;
    const net = qty * (bidMid - askMid) - fees - conversion - buffer;
    const notional = qty * askMid;
    return {
      key: `cross|${coin}|${keyOf(a.m)}>${keyOf(b.m)}`, kind: "cross", coin, venues: [a.m.venue, b.m.venue],
      path: `${coin}: ${a.m.venue} (${a.m.quote}) → ${b.m.venue} (${b.m.quote})`,
      legs: [
        { venue: a.m.venue, pair: `${coin}/${a.m.quote}`, base: coin, quote: a.m.quote, side: "buy", price: a.q.ask, market: keyOf(a.m), size: a.q.askSize, qty, fee: a.fee },
        { venue: b.m.venue, pair: `${coin}/${b.m.quote}`, base: coin, quote: b.m.quote, side: "sell", price: b.q.bid, market: keyOf(b.m), size: b.q.bidSize, qty, fee: b.fee },
      ],
      notional, grossPct, net, netPct: net / notional * 100, fees, conversion, buffer,
      ageMs: now - Math.min(a.at, b.at), suspect: grossPct > settings.maxGap,
    };
  };

  const triangle = (t: Triangle): Opportunity | null => {
    const quotesOf = t.steps.map((step) => fresh(step.m));
    if (quotesOf.some((q) => !q)) return null;
    const qs = quotesOf as Quote[];
    const times = qs.map((q) => q.receivedAt);
    if (Math.max(...times) - Math.min(...times) > MAX_LEG_SKEW_MS) return null;
    // Spending the quote currency buys base at the ask (capacity in quote units); selling base gets the bid.
    const edges = t.steps.map((step, i) => {
      const q = qs[i], fee = pairFee(step.m);
      return step.side === "buy"
        ? { ...step, q, fee, rate: 1 / (q.ask * (1 + fee)), raw: 1 / q.ask, capacity: q.askSize * q.ask * (1 + fee) }
        : { ...step, q, fee, rate: q.bid * (1 - fee), raw: q.bid, capacity: q.bidSize };
    });
    const [e1, e2, e3] = edges;
    const raw = e1.raw * e2.raw * e3.raw;
    const factor = e1.rate * e2.rate * e3.rate;
    const size = Math.min(budget, e1.capacity, e2.capacity / e1.rate, e3.capacity / (e1.rate * e2.rate));
    if (!Number.isFinite(size) || size < MIN_NOTIONAL) return null;
    const grossPct = (raw - 1) * 100;
    const afterFees = size * factor;
    const fees = size * raw - afterFees;
    const buffer = afterFees * (1 - (1 - slip) ** 3);
    const net = afterFees - buffer - size;
    // Amounts along the path; a buy's order size is what it receives, a sell's is what it spends.
    const a1 = size * e1.rate, a2 = a1 * e2.rate;
    const legOf = (e: typeof e1, amountIn: number, amountOut: number): Leg => ({
      venue: t.venue, pair: `${e.m.base}/${e.m.quote}`, base: e.m.base, quote: e.m.quote, side: e.side, price: e.side === "buy" ? e.q.ask : e.q.bid,
      market: keyOf(e.m), size: e.side === "buy" ? e.q.askSize : e.q.bidSize, qty: e.side === "buy" ? amountOut : amountIn, fee: e.fee,
    });
    return {
      key: `tri|${t.venue}|USD>${e1.to}>${e2.to}|${e2.m.base}/${e2.m.quote}`, kind: "triangle", coin: [e1.to, e2.to].filter((c) => !isDollarStable(c)).join("/") || e1.to,
      venues: [t.venue], path: `${t.venue}: USD → ${e1.to} → ${e2.to} → USD`, legs: [legOf(e1, size, a1), legOf(e2, a1, a2), legOf(e3, a2, a2 * e3.rate)],
      notional: size, grossPct, net, netPct: net / size * 100, fees, conversion: 0, buffer,
      ageMs: now - Math.min(...times), suspect: grossPct > settings.maxGap,
    };
  };

  return { rates, entries, cross, triangle };
}

// Every route across every market.
export function scanOpportunities(input: ScanInput): ScanResult {
  const index = input.index || indexRoutes(input.markets);
  const v = valuation(input, index);
  const top = new TopN(20, (o) => o.net);
  const suspects = new TopN(10, (o) => o.grossPct);
  let best: Opportunity | null = null;
  let bestEligible: Opportunity | null = null;
  const evaluated = { cross: 0, triangle: 0 };
  const consider = (o: Opportunity | null) => {
    if (!o) return;
    if (o.suspect) { suspects.add(o); return; }
    top.add(o);
    if (!best || o.net > best.net) best = o;
    // Funding, order increments, or repricing can change a route's rank. Prepare every candidate before
    // comparing executable net profit, including candidates whose raw net is below the current leader.
    const prepared = input.prepare ? input.prepare(o) : o;
    if (prepared && !prepared.suspect && (!bestEligible || prepared.net > bestEligible.net)
      && (!input.eligible || input.eligible(prepared))) bestEligible = prepared;
  };
  for (const coin of index.crossByCoin.keys()) {
    const entries = v.entries(coin);
    for (const a of entries) for (const b of entries) {
      if (a.m.venue === b.m.venue || Math.abs(a.q.receivedAt - b.q.receivedAt) > MAX_LEG_SKEW_MS) continue;
      evaluated.cross++;
      consider(v.cross(coin, a, b));
    }
  }
  if (input.triangular) for (const t of index.triangles) {
    const o = v.triangle(t);
    if (o) evaluated.triangle++;
    consider(o);
  }
  return { top: top.items, suspects: suspects.items, best, bestEligible, rates: v.rates, evaluated };
}

// Only routes affected by this book, including local stablecoin conversion dependencies.
export function scanMarket(input: ScanInput, market: Market): Opportunity[] {
  const index = input.index || indexRoutes(input.markets);
  const v = valuation(input, index);
  const found = new Map<string, Opportunity>();
  const key = keyOf(market);
  const affected = [...(index.crossByConversion.get(key) || [])];
  if (!isDollarStable(market.base) && (market.quote === "USD" || isDollarStable(market.quote))) affected.push(market);
  // Cache each coin's valuation once, even if a conversion affects multiple books for that coin.
  const byCoin = new Map<string, Entry[]>();
  for (const changed of affected) {
    let entries = byCoin.get(changed.base);
    if (!entries) { entries = v.entries(changed.base); byCoin.set(changed.base, entries); }
    const own = entries.find((e) => keyOf(e.m) === keyOf(changed));
    if (own) for (const other of entries) {
      for (const o of [v.cross(changed.base, own, other), v.cross(changed.base, other, own)]) if (o) found.set(o.key, o);
    }
  }
  if (input.triangular) for (const t of index.trianglesByMarket.get(key) || []) { const o = v.triangle(t); if (o) found.set(o.key, o); }
  return [...found.values()].sort((a, b) => b.net - a.net);
}

export type TradeMemory = {
  // When each route key last traded.
  recent: Map<string, number>;
  // Top-of-book quotes already filled against, by `${market}|${side}`.
  consumed: Map<string, { price: number; size: number }>;
  // Barriers found by the route checks, by barrierKey(): a coin moving from one exchange to another that
  // can't be arbitraged whatever the gap, e.g. two different tokens or closed transfers.
  barriers?: Map<string, string>;
};

// Checks apply to a coin between two exchanges, whichever currency each side is priced in.
export const barrierKey = (coin: string, buyVenue: Venue, sellVenue: Venue) => `${coin}|${buyVenue}>${sellVenue}`;

export type TradeRules = { minNet: number; now: number; cooldownMs: number };

// Why a route would not be paper-traded right now, or null if it would. The dashboard shows the same
// reasons the bot applies.
export function blockReason(o: Opportunity, memory: TradeMemory, rules: TradeRules): string | null {
  if (o.suspect) return "Suspect gap";
  const barrier = o.kind === "cross" ? memory.barriers?.get(barrierKey(o.coin, o.venues[0], o.venues[1])) : undefined;
  if (barrier) return barrier;
  if (o.net <= 0) return "Loses money after costs";
  if (o.net < rules.minNet) return `Below your $${rules.minNet.toFixed(2)} minimum`;
  if (rules.now - (memory.recent.get(o.key) ?? -Infinity) < rules.cooldownMs) return "Traded in the last minute";
  // A real fill takes the quoted liquidity, so a leg cannot trade again against the same unchanged quote;
  // it becomes available once the exchange shows a different price or size.
  const used = o.legs.some((leg) => {
    const entry = memory.consumed.get(`${leg.market}|${leg.side}`);
    return entry !== undefined && entry.price === leg.price && entry.size === leg.size;
  });
  return used ? "Quote already used by a paper trade" : null;
}

// Picks the first route (best net first) that passes every rule, and records what it used.
export function chooseTrade(candidates: Opportunity[], memory: TradeMemory, rules: TradeRules): Opportunity | null {
  const chosen = candidates.find((o) => blockReason(o, memory, rules) === null) || null;
  if (chosen) {
    memory.recent.set(chosen.key, rules.now);
    for (const leg of chosen.legs) memory.consumed.set(`${leg.market}|${leg.side}`, { price: leg.price, size: leg.size });
  }
  return chosen;
}
