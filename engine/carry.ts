import {
  coinsPerPriceUnit, markCarry, openCarry, openingCost, parseFutures, quoteCarry, quoteDated, trailingApr,
  HOURS_PER_YEAR, type Book, type CarryAccounting, type CarryPosition, type Dated, type Perp, type SpotSide,
} from "../lib/carry";
import type { CarryConfig, CarryState, Store } from "./store";

// Paper spot-vs-futures carry on Coinbase's US perpetual-style futures, from public data only.
//  - Every few minutes (and just after each hour) the futures list gives each contract's last settled hourly
//    funding rate. Rates are recorded, but payment amounts remain unresolved without the settlement futures mark.
//  - Each contract's best bid/ask is polled every 30s; the coin's spot side comes from the main engine's books.
//  - A position opens when the expected funding, net of both legs' fees and spreads spread over the expected
//    holding time, clears the minimum return on the capital it ties up; it closes when funding turns negative
//    or the short gets too close to a margin call.

const API = "https://api.coinbase.com/api/v3/brokerage/market";
const headers = { Accept: "application/json", "User-Agent": "arbiter-live/0.1" };
const PRODUCTS_MS = 5 * 60_000;
const PERP_BOOK_MS = 30_000;
const DATED_BOOK_MS = 60_000;
const BOOK_TTL_MS = 90_000;
const DECIDE_MS = 60_000;
const REQUEST_GAP_MS = 150;
const BOOK_CONCURRENCY = 3;
const SPOT_TTL_MS = 12_000;
// Funding history needed before opening, and the windows used to forecast and to exit.
const MIN_HISTORY = 6;
const FORECAST_HOURS = 24;
const EXIT_HOURS = 6;
const HISTORY_KEPT_MS = 8 * 86_400_000;
// A position closes before the futures price can rise this much more without a margin call.
const MIN_RISE_TO_CALL = 0.1;
const DATED_MIN_VOLUME = 100;

export class Carry {
  private perps = new Map<string, Perp>();
  private dated = new Map<string, Dated>();
  private readonly books = new Map<string, Book>();
  private readonly history = new Map<string, { time: number; rate: number }[]>();
  private state: CarryState;
  private productsAt = 0;
  private lastHourFetched = -1;
  private decidedAt = 0;
  private busy = false;
  private error: string | null = null;
  private readonly reasons = new Map<string, string>();
  private readonly exitBlocks = new Map<string, string>();
  private readonly bookAttempts = new Map<string, number>();

  constructor(private readonly config: () => CarryConfig, private readonly store: Store,
    private readonly spotSides: (coin: string) => SpotSide[], private readonly log: (line: string) => void) {
    this.state = store.loadCarry(config().capital);
    this.initializeAccounting();
    const since = Date.now() - HISTORY_KEPT_MS;
    for (const row of store.readFunding(24 * 8 * 40).reverse()) {
      const time = Date.parse(row.time), rate = Number(row.rate);
      if (time < since || !Number.isFinite(rate)) continue;
      (this.history.get(row.contract) || this.history.set(row.contract, []).get(row.contract)!).push({ time, rate });
    }
  }

  private freshAccounting(): CarryAccounting {
    return { version: 1, lifetimeFees: 0, confirmedFunding: 0, unresolvedFundingPayments: 0, historyComplete: true, legacyFundingEstimate: 0 };
  }

  private initializeAccounting() {
    if (this.state.accounting?.version === 1) return;
    const all = [...this.state.positions, ...this.state.closed];
    const accounting = this.freshAccounting();
    // Legacy logs omitted historical settlements and may have pruned closed positions.
    accounting.historyComplete = all.length === 0 && this.state.cash === this.state.capital;
    accounting.lifetimeFees = all.reduce((sum, p) => sum + p.fees, 0);
    for (const p of all) {
      const legacy = p.funding;
      p.legacyFundingEstimate = (p.legacyFundingEstimate || 0) + legacy;
      accounting.legacyFundingEstimate += legacy;
      p.unresolvedFundingPayments = Math.max(p.unresolvedFundingPayments || 0, p.fundingPayments);
      accounting.unresolvedFundingPayments += p.unresolvedFundingPayments;
      p.funding = 0;
      p.fundingPayments = 0;
      if (p.closedAt !== undefined) {
        this.state.cash -= legacy;
        if (p.realized !== undefined) p.realized -= legacy;
      }
      // Old marks, if present, include the unverified funding credit/debit.
      delete p.lastMark;
    }
    this.state.accounting = accounting;
    this.save();
  }

  private get accounting() { return this.state.accounting!; }

  // Coins with a US perpetual, so the main engine follows their spot books too.
  get coins() { return this.state.coins; }

  reset() {
    const capital = this.config().capital;
    this.state = { startedAt: Date.now(), capital, cash: capital, positions: [], closed: [], lastFunding: this.state.lastFunding, coins: this.state.coins, accounting: this.freshAccounting() };
    this.exitBlocks.clear();
    this.save();
  }

  save() { return this.store.saveCarry(this.state); }

  // Called every few seconds; each step runs on its own schedule and one at a time.
  async tick() {
    if (!this.config().enabled) return;
    // Risk checks continue on incoming ticks even while discovery requests are pending.
    try { if (this.closePositions(Date.now())) await this.save(); }
    catch (error) { this.error = (error as Error).message; return; }
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now(), hour = Math.floor(now / 3_600_000);
      // Refresh the list on schedule, and once just after each hour when the new funding rate is out.
      if (now - this.productsAt > PRODUCTS_MS || (hour !== this.lastHourFetched && now % 3_600_000 > 45_000)) {
        this.lastHourFetched = hour;
        await this.refreshProducts();
      }
      await this.pollBooks(Date.now());
      const decisionAt = Date.now();
      if (decisionAt - this.decidedAt > DECIDE_MS) { this.decidedAt = decisionAt; this.decide(decisionAt); }
      await this.save();
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private async get(url: string) {
    const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Coinbase futures HTTP ${response.status}`);
    return response.json();
  }

  async refreshProducts() {
    const { perps, dated } = parseFutures(await this.get(`${API}/products?product_type=FUTURE`));
    if (!perps.length) throw new Error("Coinbase listed no US perpetual futures");
    this.productsAt = Date.now();
    this.error = null;
    this.perps = new Map(perps.map((p) => [p.id, p]));
    this.dated = new Map(dated.map((d) => [d.id, d]));
    this.state.coins = [...new Set(perps.map((p) => p.coin))].sort();
    for (const perp of perps) this.settle(perp);
    await this.save();
  }

  // A contract whose last funding time moved on has settled a new hourly rate.
  private settle(perp: Perp) {
    const previous = this.state.lastFunding[perp.id] ?? 0;
    if (perp.fundingTime <= previous) return;
    this.state.lastFunding[perp.id] = perp.fundingTime;
    const list = this.history.get(perp.id) || this.history.set(perp.id, []).get(perp.id)!;
    if (!list.some((h) => h.time === perp.fundingTime)) {
      list.push({ time: perp.fundingTime, rate: perp.fundingRate });
      while (list.length && list[0].time < perp.fundingTime - HISTORY_KEPT_MS) list.shift();
      this.store.appendFunding({ time: perp.fundingTime, contract: perp.id, coin: perp.coin, rate: perp.fundingRate, index: perp.index });
    }
    for (const p of [...this.state.positions, ...this.state.closed]) {
      if (p.perpId !== perp.id || p.openedAt >= perp.fundingTime || p.lastFundingTime >= perp.fundingTime ||
        (p.closedAt !== undefined && p.closedAt < perp.fundingTime)) continue;
      const intervals = Math.max(1, Math.ceil((perp.fundingTime - Math.max(p.lastFundingTime, p.openedAt)) / (perp.intervalHours * 3_600_000)));
      // The public product's current index is not the futures mark for this funding event.
      // Missing intervals can include market closures; flag them for reconciliation, never invent zero payments.
      p.unresolvedFundingPayments = (p.unresolvedFundingPayments || 0) + intervals;
      this.accounting.unresolvedFundingPayments += intervals;
      p.lastFundingTime = perp.fundingTime;
      this.store.appendCarryEvent({ time: perp.fundingTime, event: "funding_unresolved", position: p, rate: perp.fundingRate,
        note: `Settlement futures mark unavailable; ${intervals} interval(s) unresolved${intervals > 1 ? ` (${intervals - 1} earlier interval(s) unobserved)` : ""}` });
    }
  }

  private dueBooks(now: number) {
    const due: [string, number][] = [];
    for (const id of this.perps.keys()) due.push([id, PERP_BOOK_MS]);
    for (const d of this.frontDated()) due.push([d.id, DATED_BOOK_MS]);
    for (const p of this.state.positions) if (!this.perps.has(p.perpId)) due.push([p.perpId, PERP_BOOK_MS]);
    const open = new Set(this.state.positions.map((p) => p.perpId));
    return due.filter(([id, every]) => now - (this.books.get(id)?.at || 0) >= every)
      .sort(([a], [b]) => Number(open.has(b)) - Number(open.has(a)) || (this.bookAttempts.get(a) || 0) - (this.bookAttempts.get(b) || 0))
      .map(([id]) => id);
  }

  private async pollBooks(now: number) {
    const queue = this.dueBooks(now).slice(0, 20);
    let cursor = 0, nextStartAt = Date.now();
    const worker = async () => {
      while (cursor < queue.length) {
        const id = queue[cursor++];
        const waitMs = Math.max(0, nextStartAt - Date.now());
        nextStartAt = Math.max(Date.now(), nextStartAt) + REQUEST_GAP_MS;
        if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
        this.bookAttempts.set(id, Date.now());
        try {
          const body = await this.get(`${API}/product_book?product_id=${encodeURIComponent(id)}&limit=1`) as { pricebook?: { bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] } };
          const bid = body.pricebook?.bids?.[0], ask = body.pricebook?.asks?.[0];
          const book = { bid: Number(bid?.price), bidSize: Number(bid?.size), ask: Number(ask?.price), askSize: Number(ask?.size), at: Date.now() };
          if ([book.bid, book.ask, book.bidSize, book.askSize].every((n) => Number.isFinite(n) && n > 0) && book.bid < book.ask) this.books.set(id, book);
        } catch { /* The next poll retries; a stale book is skipped by the TTL. */ }
        if (this.closePositions(Date.now())) await this.save();
      }
    };
    await Promise.all(Array.from({ length: Math.min(BOOK_CONCURRENCY, queue.length) }, worker));
  }

  private liveSpots(coin: string, now = Date.now()) {
    return this.spotSides(coin).filter((s) => now >= s.at && now - s.at <= SPOT_TTL_MS &&
      [s.bid, s.ask, s.bidSize, s.askSize].every((n) => Number.isFinite(n) && n > 0) && s.bid < s.ask);
  }

  private spotMid(coin: string) {
    const mids = this.liveSpots(coin).map((s) => (s.bid + s.ask) / 2).sort((a, b) => a - b);
    return mids.length ? mids[mids.length >> 1] : null;
  }

  private unit(perp: Pick<Perp, "coin" | "price">) {
    const spot = this.spotMid(perp.coin);
    return spot ? coinsPerPriceUnit(perp.price, spot) : null;
  }

  // Cheapest place to buy the coin, fee included.
  private bestSpot(coin: string) {
    return this.liveSpots(coin).sort((a, b) => a.ask * (1 + a.fee) - b.ask * (1 + b.fee))[0] || null;
  }

  // Nearest expiry per coin with some trading.
  private frontDated() {
    const now = Date.now(), front = new Map<string, Dated>();
    for (const d of this.dated.values()) {
      if (d.expiry - now < 2 * 86_400_000 || d.volume24h < DATED_MIN_VOLUME) continue;
      const current = front.get(d.coin);
      if (!current || d.expiry < current.expiry) front.set(d.coin, d);
    }
    return [...front.values()];
  }

  private options(capital: number) {
    const c = this.config();
    return { futuresFee: c.futuresFee / 100, marginBuffer: c.marginBuffer / 100, holdDays: c.holdDays, capital };
  }

  // Only settled rates are used: Coinbase computes funding from its own futures and spot marks, which the public
  // book and index don't reproduce, so the hour in progress can't be predicted reliably.
  private forecast(perp: Perp, now: number) {
    const history = this.history.get(perp.id) || [];
    const trailing = trailingApr(history, now - FORECAST_HOURS * 3_600_000, MIN_HISTORY);
    return { trailing, samples: history.filter((h) => h.time >= now - FORECAST_HOURS * 3_600_000).length };
  }

  private freshBook(id: string, now: number) {
    const book = this.books.get(id);
    return book && now >= book.at && now - book.at <= BOOK_TTL_MS ? book : undefined;
  }

  private closePositions(now: number) {
    const c = this.config();
    let changed = false;
    for (const p of [...this.state.positions]) {
      const perp = this.perps.get(p.perpId), book = this.freshBook(p.perpId, now);
      const spot = this.liveSpots(p.coin, now).find((s) => s.venue === p.spotVenue);
      if (!perp || !book || !spot) {
        this.exitBlocks.set(p.id, "Exit unresolved: waiting for fresh spot/futures prices and contract margin");
        continue;
      }
      const mark = markCarry(p, spot.bid, book.ask, perp.shortMargin);
      p.lastMark = { at: Math.min(spot.at, book.at), mark };
      const recent = trailingApr(this.history.get(p.perpId) || [], now - EXIT_HOURS * 3_600_000, 3);
      const reason = mark.riseToMarginCall < MIN_RISE_TO_CALL ? "Too close to a margin call" :
        recent !== null && recent * 100 < c.exitApr && now - p.openedAt > EXIT_HOURS * 3_600_000 ? `Funding averaged ${(recent * 100).toFixed(1)}%/yr over ${EXIT_HOURS}h` : null;
      const enoughDepth = book.askSize >= p.contracts && spot.bidSize >= p.spotQty;
      if (!enoughDepth) {
        this.exitBlocks.set(p.id, `${reason ? `${reason}; ` : ""}exit unresolved: insufficient top-of-book size for both legs`);
        continue;
      }
      this.exitBlocks.delete(p.id);
      if (reason) { this.close(p, spot.bid, book.ask, mark.value, reason, now); changed = true; }
    }
    return changed;
  }

  private decide(now: number) {
    const c = this.config();
    this.reasons.clear();
    this.closePositions(now);
    const open = new Set(this.state.positions.map((p) => p.coin));
    const quotes = [...this.perps.values()].map((perp) => ({ perp, ...this.evaluate(perp, now) }))
      .filter((q) => q.quote).sort((a, b) => b.quote!.netAprOnCapital - a.quote!.netAprOnCapital);
    for (const candidate of quotes) {
      // Earlier entries reserve cash synchronously; size the next entry against the remaining balance.
      const q = { perp: candidate.perp, ...this.evaluate(candidate.perp, now) };
      if (!q.quote) continue;
      const quote = q.quote;
      // Reasons that won't clear by waiting (collateral, capital, book size) come before waiting for history.
      const block = open.has(q.perp.coin) ? "Position open" : quote.reason ??
        (q.forecast.samples < MIN_HISTORY ? `Collecting funding history (${q.forecast.samples} of ${MIN_HISTORY} hours)` :
        q.perp.fundingRate < 0 ? "Funding is negative now" :
        quote.netAprOnCapital * 100 < c.minNetApr ? `Below your ${c.minNetApr}% minimum` :
        this.state.positions.length >= c.maxPositions ? "Position limit reached" : null);
      this.reasons.set(q.perp.id, block ?? "Opened");
      if (block) continue;
      const p = openCarry(`carry-${now.toString(36)}-${q.perp.coin}`, q.perp, q.book!, q.spot!, q.unit!, quote.contracts, this.options(0), now);
      const cost = openingCost(p);
      if (!Number.isFinite(cost) || cost > this.state.cash || cost <= 0) {
        this.reasons.set(q.perp.id, "Insufficient available cash");
        continue;
      }
      this.state.cash -= cost;
      this.accounting.lifetimeFees += p.fees;
      p.lastMark = { at: Math.min(q.spot!.at, q.book!.at), mark: markCarry(p, q.spot!.bid, q.book!.ask, q.perp.shortMargin) };
      this.state.positions.push(p);
      open.add(p.coin);
      this.store.appendCarryEvent({ time: now, event: "open", position: p, spotPrice: p.entrySpot, futuresPrice: p.entryPerp, rate: q.perp.fundingRate, amount: -openingCost(p),
        note: `expected ${(quote.netAprOnCapital * 100).toFixed(1)}%/yr on capital` });
      this.log(`CARRY OPEN   ${p.coin}: buy ${p.spotQty} on ${p.spotVenue} @ ${p.entrySpot}, short ${p.contracts} × ${p.perpId} @ ${p.entryPerp}  (expected ${(quote.netAprOnCapital * 100).toFixed(1)}%/yr)`);
    }
    this.save();
  }

  private close(p: CarryPosition, spotBid: number, perpAsk: number, value: number, reason: string, now: number) {
    // Closing before the next product refresh does not erase funding hours already crossed.
    const intervalMs = (this.perps.get(p.perpId)?.intervalHours || 1) * 3_600_000;
    const intervals = Math.max(0, Math.floor(now / intervalMs) - Math.floor(p.lastFundingTime / intervalMs));
    if (intervals) {
      p.unresolvedFundingPayments = (p.unresolvedFundingPayments || 0) + intervals;
      this.accounting.unresolvedFundingPayments += intervals;
      p.lastFundingTime = Math.floor(now / intervalMs) * intervalMs;
      this.store.appendCarryEvent({ time: now, event: "funding_unresolved", position: p,
        note: `${intervals} funding interval(s) unresolved at close; settlement rate/mark not observed` });
    }
    p.closedAt = now; p.exitSpot = spotBid; p.exitPerp = perpAsk; p.closeReason = reason; p.realized = value - openingCost(p);
    const exitFees = p.spotQty * spotBid * p.spotFee + p.contracts * p.contractSize * perpAsk * p.futuresFee;
    p.fees += exitFees;
    this.accounting.lifetimeFees += exitFees;
    this.state.cash += value;
    this.state.positions = this.state.positions.filter((x) => x !== p);
    this.state.closed = [p, ...this.state.closed].slice(0, 100);
    this.exitBlocks.delete(p.id);
    this.store.appendCarryEvent({ time: now, event: "close", position: p, spotPrice: spotBid, futuresPrice: perpAsk, amount: value, net: p.realized, note: `${reason}${p.unresolvedFundingPayments ? "; funding incomplete: excluded from paper P&L" : ""}` });
    this.log(`CARRY CLOSE  ${p.coin}: ${reason}; net ${p.realized >= 0 ? "+" : "-"}$${Math.abs(p.realized).toFixed(2)} (funding $${p.funding.toFixed(2)})`);
  }

  // Sizing uses an even share of the account, or whatever is free if less.
  private evaluate(perp: Perp, now: number) {
    const c = this.config();
    const book = this.freshBook(perp.id, now), unit = this.unit(perp);
    const spots = this.liveSpots(perp.coin, now).sort((a, b) => a.ask * (1 + a.fee) - b.ask * (1 + b.fee));
    const spot = spots.find((s) => unit && s.askSize >= perp.contractSize * unit) || spots[0] || null;
    const forecast = this.forecast(perp, now);
    // The lower of the day's average and the latest hour, so fading funding isn't overrated.
    const latest = perp.fundingRate * HOURS_PER_YEAR;
    const expected = forecast.trailing === null ? latest : Math.min(forecast.trailing, latest);
    const capital = Math.min(this.state.cash, this.state.capital / c.maxPositions);
    const quote = book && spot && unit ? quoteCarry(perp, book, spot, unit, expected, this.options(capital)) : null;
    return { book, spot, unit, forecast, expected, quote };
  }

  snapshot(now: number) {
    const c = this.config();
    const perps = [...this.perps.values()].map((perp) => {
      const e = this.evaluate(perp, now);
      return {
        id: perp.id, coin: perp.coin, contractSize: perp.contractSize, shortMargin: perp.shortMargin, fundingTime: perp.fundingTime,
        lastApr: perp.fundingRate * HOURS_PER_YEAR, trailingApr: e.forecast.trailing, samples: e.forecast.samples,
        bid: e.book?.bid ?? null, ask: e.book?.ask ?? null, spotVenue: e.spot?.venue ?? null, spotAsk: e.spot?.ask ?? null, unit: e.unit,
        quote: e.quote, reason: this.reasons.get(perp.id) ?? (!e.spot ? "No live spot price" : !e.book ? "Waiting for the futures book" : e.quote?.reason ?? null),
      };
    }).sort((a, b) => (b.quote?.netAprOnCapital ?? -Infinity) - (a.quote?.netAprOnCapital ?? -Infinity));
    const dated = this.frontDated().map((d) => {
      const book = this.freshBook(d.id, now), spot = this.bestSpot(d.coin), unit = this.unit(d);
      return { id: d.id, coin: d.coin, expiry: d.expiry, volume24h: d.volume24h, spotVenue: spot?.venue ?? null,
        ...(book && spot && unit ? quoteDated(d, book, spot, unit, now, this.options(0)) : { days: (d.expiry - now) / 86_400_000, basisPct: null, netPct: null, netApr: null, netAprOnCapital: null }) };
    }).sort((a, b) => (b.netAprOnCapital ?? -Infinity) - (a.netAprOnCapital ?? -Infinity));
    let openValue = 0, hasUnknownValue = false, valuationComplete = true;
    const positions = this.state.positions.map((p) => {
      const perp = this.perps.get(p.perpId), book = this.freshBook(p.perpId, now);
      const spot = this.liveSpots(p.coin, now).find((s) => s.venue === p.spotVenue);
      const fresh = perp && book && spot ? markCarry(p, spot.bid, book.ask, perp.shortMargin) : null;
      if (fresh) p.lastMark = { at: Math.min(spot!.at, book!.at), mark: fresh };
      const mark = fresh || p.lastMark?.mark || null;
      const depthComplete = !!book && !!spot && book.askSize >= p.contracts && spot.bidSize >= p.spotQty;
      const complete = !!fresh && depthComplete;
      valuationComplete = valuationComplete && complete;
      if (mark) openValue += mark.value; else hasUnknownValue = true;
      const exitBlocked = !fresh ? "Exit unresolved: waiting for fresh prices" : !depthComplete ? "Exit unresolved: insufficient top-of-book size for both legs" : this.exitBlocks.get(p.id) || null;
      return { ...p, mark, markAt: p.lastMark?.at ?? null, markStale: !fresh, valuationComplete: complete,
        exitBlocked, hours: (now - p.openedAt) / 3_600_000 };
    });
    const equity = hasUnknownValue ? null : this.state.cash + openValue;
    const pnl = equity === null ? null : equity - this.state.capital;
    const a = this.accounting;
    const fundingAwaitingObservation = [...this.state.positions, ...this.state.closed].some((p) => {
      const intervalMs = (this.perps.get(p.perpId)?.intervalHours || 1) * 3_600_000;
      return Math.floor((p.closedAt ?? now) / intervalMs) > Math.floor(p.lastFundingTime / intervalMs);
    });
    const fundingComplete = a.historyComplete && a.unresolvedFundingPayments === 0 && !fundingAwaitingObservation;
    const years = (now - this.state.startedAt) / (365 * 86_400_000);
    return {
      enabled: c.enabled, error: this.error, updatedAt: this.productsAt, config: c,
      account: { startedAt: this.state.startedAt, capital: this.state.capital, cash: this.state.cash, equity, pnl,
        valuationComplete, fundingComplete, historyComplete: a.historyComplete, fundingAwaitingObservation,
        unresolvedFundingPayments: a.unresolvedFundingPayments, confirmedFunding: a.confirmedFunding,
        legacyFundingEstimate: a.legacyFundingEstimate, funding: a.confirmedFunding, fees: a.lifetimeFees,
        apr: equity !== null && valuationComplete && fundingComplete && years > 1 / 365 ? (equity / this.state.capital - 1) / years : null },
      positions, closed: this.state.closed.slice(0, 30), perps, dated,
      events: this.store.readRecentCarryEvents(30),
    };
  }
}
