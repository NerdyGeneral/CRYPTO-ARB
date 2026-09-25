import { feeKey, type Quote, type Settings, type Venue } from "./market";
import { dollarStablecoins, isDollarStable, keyOf, type Market } from "./markets";

// Route math for the background engine. Every opportunity is valued in USD, paying the taker fee on
// every leg and the price-movement buffer per leg, and is sized to the top of each order book.
//
// - cross:    buy a coin on one venue and sell it on another. Either side may be priced in USD, USDT or
//             USDC; a stablecoin leg is valued at that venue's live stablecoin/USD book (or the median
//             across venues) including the cost of converting.
// - triangle: USD -> A -> B -> USD on a single venue, e.g. USD -> BTC -> ETH -> USD or USD -> USDT -> SOL -> USD.

export const QUOTE_TTL_MS = 12_000;
export const MAX_LEG_SKEW_MS = 4_000;
const RATE_TTL_MS = 60_000;
const MIN_NOTIONAL = 5;

// `market` and `size` identify the exact top-of-book quote a leg would trade against.
export type Leg = { venue: Venue; pair: string; side: "buy" | "sell"; price: number; market: string; size: number };
export type Opportunity = {
  key: string; kind: "cross" | "triangle"; coin: string; venues: Venue[]; path: string; legs: Leg[];
  notional: number; grossPct: number; net: number; netPct: number;
  fees: number; conversion: number; buffer: number; ageMs: number; suspect: boolean;
};
export type Rate = { mid: number; bid: number; ask: number; venues: number };
export type ScanInput = {
  markets: Market[]; quotes: Map<string, Quote>; settings: Settings; conversionFee: number;
  balance: number; now: number; triangular: boolean;
};
export type ScanResult = {
  top: Opportunity[]; suspects: Opportunity[]; best: Opportunity | null; rates: Record<string, Rate>;
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

export function scanOpportunities(input: ScanInput): ScanResult {
  const { markets, quotes, settings, now } = input;
  const slip = settings.buffer / 100;
  const budget = Math.max(0, Math.min(settings.budget, input.balance));
  const taker = (venue: Venue) => (settings[feeKey[venue]] as number) / 100;
  // Stablecoin/USD and stablecoin/stablecoin books use the venue's stablecoin schedule when it is cheaper.
  const pairFee = (m: Market) => isDollarStable(m.base) && (m.quote === "USD" || isDollarStable(m.quote))
    ? Math.min(taker(m.venue), input.conversionFee / 100) : taker(m.venue);
  const fresh = (m: Market, ttl = QUOTE_TTL_MS) => { const q = quotes.get(keyOf(m)); return q && now - q.receivedAt <= ttl ? q : undefined; };

  // Live dollar value of each stablecoin, per venue and as a cross-venue median.
  const stableBooks = new Map<string, { market: Market; quote: Quote }>();
  const rates: Record<string, Rate> = {};
  for (const coin of dollarStablecoins) {
    const books = markets.filter((m) => m.base === coin && m.quote === "USD").flatMap((m) => { const q = fresh(m, RATE_TTL_MS); return q ? [{ market: m, quote: q }] : []; });
    for (const book of books) stableBooks.set(`${book.market.venue}|${coin}`, book);
    if (books.length) rates[coin] = {
      mid: median(books.map((b) => (b.quote.bid + b.quote.ask) / 2)), bid: median(books.map((b) => b.quote.bid)),
      ask: median(books.map((b) => b.quote.ask)), venues: books.length,
    };
  }
  // USD value of one unit of `currency` on `venue`: mid for reporting, ask/bid after conversion cost.
  const dollar = (venue: Venue, currency: string) => {
    if (currency === "USD") return { mid: 1, buy: 1, sell: 1, at: now };
    const book = stableBooks.get(`${venue}|${currency}`);
    if (book) {
      const fee = pairFee(book.market);
      return { mid: (book.quote.bid + book.quote.ask) / 2, buy: book.quote.ask * (1 + fee), sell: book.quote.bid * (1 - fee), at: book.quote.receivedAt };
    }
    const ref = rates[currency];
    return ref ? { mid: ref.mid, buy: ref.mid * (1 + input.conversionFee / 100), sell: ref.mid * (1 - input.conversionFee / 100), at: now } : null;
  };

  const top = new TopN(20, (o) => o.net);
  const suspects = new TopN(10, (o) => o.grossPct);
  let best: Opportunity | null = null;
  const evaluated = { cross: 0, triangle: 0 };
  const consider = (o: Opportunity) => {
    if (o.suspect) { suspects.add(o); return; }
    top.add(o);
    if (!best || o.net > best.net) best = o;
  };

  // Cross-venue routes, grouped by coin.
  type Entry = { m: Market; q: Quote; mid: number; cost: number; value: number; fee: number; at: number };
  const byCoin = new Map<string, Entry[]>();
  for (const m of markets) {
    if (!(m.quote === "USD" || isDollarStable(m.quote)) || isDollarStable(m.base)) continue;
    const q = fresh(m);
    const d = q && dollar(m.venue, m.quote);
    if (!q || !d) continue;
    const list = byCoin.get(m.base) || [];
    list.push({ m, q, mid: d.mid, cost: d.buy, value: d.sell, fee: taker(m.venue), at: Math.min(q.receivedAt, d.at) });
    byCoin.set(m.base, list);
  }
  for (const [coin, entries] of byCoin) {
    for (const a of entries) for (const b of entries) {
      if (a.m.venue === b.m.venue || Math.abs(a.q.receivedAt - b.q.receivedAt) > MAX_LEG_SKEW_MS) continue;
      evaluated.cross++;
      const askMid = a.q.ask * a.mid, bidMid = b.q.bid * b.mid;
      const qty = Math.min(budget / (a.q.ask * a.cost * (1 + a.fee + slip)), a.q.askSize, b.q.bidSize);
      if (!Number.isFinite(qty) || qty <= 0 || qty * askMid < MIN_NOTIONAL) continue;
      const grossPct = (bidMid / askMid - 1) * 100;
      const fees = qty * askMid * a.fee + qty * bidMid * b.fee;
      const conversion = qty * a.q.ask * (a.cost - a.mid) + qty * b.q.bid * (b.mid - b.value);
      const buffer = qty * (askMid + bidMid) * slip;
      const net = qty * (bidMid - askMid) - fees - conversion - buffer;
      const suspect = grossPct > settings.maxGap;
      // Build the object only when it could appear in a list or beat the best so far.
      if (!suspect && net <= top.floor() && best && net <= (best as Opportunity).net) continue;
      if (suspect && grossPct <= suspects.floor()) continue;
      const notional = qty * askMid;
      consider({
        key: `cross|${coin}|${keyOf(a.m)}>${keyOf(b.m)}`, kind: "cross", coin, venues: [a.m.venue, b.m.venue],
        path: `${coin}: ${a.m.venue} (${a.m.quote}) → ${b.m.venue} (${b.m.quote})`,
        legs: [
          { venue: a.m.venue, pair: `${coin}/${a.m.quote}`, side: "buy", price: a.q.ask, market: keyOf(a.m), size: a.q.askSize },
          { venue: b.m.venue, pair: `${coin}/${b.m.quote}`, side: "sell", price: b.q.bid, market: keyOf(b.m), size: b.q.bidSize },
        ],
        notional, grossPct, net, netPct: net / notional * 100, fees, conversion, buffer,
        ageMs: now - Math.min(a.at, b.at), suspect,
      });
    }
  }

  // Triangles: USD -> A -> C -> USD on one venue, over every book it lists.
  if (input.triangular) {
    type Edge = { to: string; rate: number; raw: number; capacity: number; m: Market; q: Quote; side: "buy" | "sell" };
    const graphs = new Map<Venue, Map<string, Edge[]>>();
    for (const m of markets) {
      const q = fresh(m);
      if (!q) continue;
      const fee = pairFee(m);
      const graph = graphs.get(m.venue) || new Map<string, Edge[]>();
      graphs.set(m.venue, graph);
      const out = (from: string, edge: Edge) => { const list = graph.get(from); if (list) list.push(edge); else graph.set(from, [edge]); };
      // Spending the quote currency buys base at the ask; capacity is in quote units.
      out(m.quote, { to: m.base, rate: (1 - fee) / q.ask, raw: 1 / q.ask, capacity: q.askSize * q.ask, m, q, side: "buy" });
      out(m.base, { to: m.quote, rate: q.bid * (1 - fee), raw: q.bid, capacity: q.bidSize, m, q, side: "sell" });
    }
    for (const [venue, graph] of graphs) {
      const toUsd = new Map<string, Edge>();
      for (const [from, edges] of graph) for (const edge of edges) if (edge.to === "USD" && from !== "USD") toUsd.set(from, edge);
      for (const e1 of graph.get("USD") || []) {
        for (const e2 of graph.get(e1.to) || []) {
          if (e2.to === "USD" || e2.to === e1.to) continue;
          const e3 = toUsd.get(e2.to);
          if (!e3) continue;
          const times = [e1.q.receivedAt, e2.q.receivedAt, e3.q.receivedAt];
          if (Math.max(...times) - Math.min(...times) > MAX_LEG_SKEW_MS) continue;
          evaluated.triangle++;
          const raw = e1.raw * e2.raw * e3.raw;
          const factor = e1.rate * e2.rate * e3.rate;
          const size = Math.min(budget, e1.capacity, e2.capacity / e1.rate, e3.capacity / (e1.rate * e2.rate));
          if (!Number.isFinite(size) || size < MIN_NOTIONAL) continue;
          const grossPct = (raw - 1) * 100;
          const afterFees = size * factor;
          const fees = size * raw - afterFees;
          const buffer = afterFees * (1 - (1 - slip) ** 3);
          const net = afterFees - buffer - size;
          const suspect = grossPct > settings.maxGap;
          if (!suspect && net <= top.floor() && best && net <= (best as Opportunity).net) continue;
          if (suspect && grossPct <= suspects.floor()) continue;
          const legOf = (e: Edge): Leg => ({ venue, pair: `${e.m.base}/${e.m.quote}`, side: e.side, price: e.side === "buy" ? e.q.ask : e.q.bid,
            market: keyOf(e.m), size: e.side === "buy" ? e.q.askSize : e.q.bidSize });
          consider({
            key: `tri|${venue}|USD>${e1.to}>${e2.to}|${e2.m.base}/${e2.m.quote}`, kind: "triangle", coin: [e1.to, e2.to].filter((c) => !isDollarStable(c)).join("/") || e1.to,
            venues: [venue], path: `${venue}: USD → ${e1.to} → ${e2.to} → USD`, legs: [legOf(e1), legOf(e2), legOf(e3)],
            notional: size, grossPct, net, netPct: net / size * 100, fees, conversion: 0, buffer,
            ageMs: now - Math.min(...times), suspect,
          });
        }
      }
    }
  }

  return { top: top.items, suspects: suspects.items, best, rates, evaluated };
}

export type TradeMemory = {
  // When each route key last traded.
  recent: Map<string, number>;
  // Top-of-book quotes already filled against, by `${market}|${side}`.
  consumed: Map<string, { price: number; size: number }>;
};

// Picks the first route (best net first) that clears the minimum, is off its cooldown, and does not
// trade against a quote a previous paper trade already filled: a real fill takes that liquidity, so a
// leg becomes available again only once the exchange shows a different price or size.
export function chooseTrade(candidates: Opportunity[], memory: TradeMemory, options: { minNet: number; now: number; cooldownMs: number }): Opportunity | null {
  const usedUp = (o: Opportunity) => o.legs.some((leg) => {
    const used = memory.consumed.get(`${leg.market}|${leg.side}`);
    return used !== undefined && used.price === leg.price && used.size === leg.size;
  });
  const chosen = candidates.find((o) => o.net > 0 && o.net >= options.minNet && options.now - (memory.recent.get(o.key) ?? -Infinity) >= options.cooldownMs && !usedUp(o)) || null;
  if (chosen) {
    memory.recent.set(chosen.key, options.now);
    for (const leg of chosen.legs) memory.consumed.set(`${leg.market}|${leg.side}`, { price: leg.price, size: leg.size });
  }
  return chosen;
}

