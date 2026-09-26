import {
  coinsPerPriceUnit, fundingPayment, markCarry, openCarry, openingCost, parseFutures, quoteCarry, quoteDated, trailingApr,
  HOURS_PER_YEAR, type Book, type CarryPosition, type Dated, type Perp, type SpotSide,
} from "../lib/carry";
import type { CarryConfig, CarryState, Store } from "./store";

// Paper spot-vs-futures carry on Coinbase's US perpetual-style futures, from public data only.
//  - Every few minutes (and just after each hour) the futures list gives each contract's last settled hourly
//    funding rate; each new settlement is recorded in funding.csv and paid to open positions.
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

  constructor(private readonly config: () => CarryConfig, private readonly store: Store,
    private readonly spotSides: (coin: string) => SpotSide[], private readonly log: (line: string) => void) {
    this.state = store.loadCarry(config().capital);
    const since = Date.now() - HISTORY_KEPT_MS;
    for (const row of store.readFunding(24 * 8 * 40).reverse()) {
      const time = Date.parse(row.time), rate = Number(row.rate);
      if (time < since || !Number.isFinite(rate)) continue;
      (this.history.get(row.contract) || this.history.set(row.contract, []).get(row.contract)!).push({ time, rate });
    }
  }

  // Coins with a US perpetual, so the main engine follows their spot books too.
  get coins() { return this.state.coins; }

  reset() {
    const capital = this.config().capital;
    this.state = { startedAt: Date.now(), capital, cash: capital, positions: [], closed: [], lastFunding: this.state.lastFunding, coins: this.state.coins };
    this.save();
  }

  save() { this.store.saveCarry(this.state); }

  // Called every few seconds; each step runs on its own schedule and one at a time.
  async tick() {
    if (!this.config().enabled || this.busy) return;
    this.busy = true;
    try {
      const now = Date.now(), hour = Math.floor(now / 3_600_000);
      // Refresh the list on schedule, and once just after each hour when the new funding rate is out.
      if (now - this.productsAt > PRODUCTS_MS || (hour !== this.lastHourFetched && now % 3_600_000 > 45_000)) {
        this.lastHourFetched = hour;
        await this.refreshProducts();
      }
      await this.pollBooks(now);
      if (now - this.decidedAt > DECIDE_MS) { this.decidedAt = now; this.decide(now); }
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
    this.productsAt = Date.now();
    const { perps, dated } = parseFutures(await this.get(`${API}/products?product_type=FUTURE`));
    if (!perps.length) throw new Error("Coinbase listed no US perpetual futures");
    this.error = null;
    this.perps = new Map(perps.map((p) => [p.id, p]));
    this.dated = new Map(dated.map((d) => [d.id, d]));
    this.state.coins = [...new Set(perps.map((p) => p.coin))].sort();
    for (const perp of perps) this.settle(perp);
    this.save();
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
    for (const p of this.state.positions) {
      if (p.perpId !== perp.id || p.openedAt >= perp.fundingTime || p.lastFundingTime >= perp.fundingTime) continue;
      // Hours that settled while the engine was stopped can't be recovered from public data, so they aren't counted.
      const missed = Math.max(0, Math.round((perp.fundingTime - Math.max(p.lastFundingTime, p.openedAt)) / (perp.intervalHours * 3_600_000)) - 1);
      const amount = fundingPayment(p, perp.fundingRate, perp.index);
      p.funding += amount;
      p.fundingPayments++;
      p.lastFundingTime = perp.fundingTime;
      this.store.appendCarryEvent({ time: perp.fundingTime, event: "funding", position: p, futuresPrice: perp.index, rate: perp.fundingRate, amount,
        note: missed ? `${missed} earlier hour(s) missed while stopped` : undefined });
    }
  }

  private dueBooks(now: number) {
    const due: [string, number][] = [];
    for (const id of this.perps.keys()) due.push([id, PERP_BOOK_MS]);
    for (const d of this.frontDated()) due.push([d.id, DATED_BOOK_MS]);
    for (const p of this.state.positions) if (!this.perps.has(p.perpId)) due.push([p.perpId, PERP_BOOK_MS]);
    return due.filter(([id, every]) => now - (this.books.get(id)?.at || 0) >= every).map(([id]) => id);
  }

  private async pollBooks(now: number) {
    for (const id of this.dueBooks(now).slice(0, 20)) {
      try {
        const body = await this.get(`${API}/product_book?product_id=${encodeURIComponent(id)}&limit=1`) as { pricebook?: { bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] } };
        const bid = body.pricebook?.bids?.[0], ask = body.pricebook?.asks?.[0];
        const book = { bid: Number(bid?.price), bidSize: Number(bid?.size), ask: Number(ask?.price), askSize: Number(ask?.size), at: Date.now() };
        if ([book.bid, book.ask, book.bidSize, book.askSize].every((n) => Number.isFinite(n) && n > 0) && book.bid < book.ask) this.books.set(id, book);
      } catch { /* The next poll retries; a stale book is skipped by the TTL. */ }
      await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
    }
  }

  private spotMid(coin: string) {
    const mids = this.spotSides(coin).map((s) => (s.bid + s.ask) / 2).sort((a, b) => a - b);
    return mids.length ? mids[mids.length >> 1] : null;
  }

  private unit(perp: Pick<Perp, "coin" | "price">) {
    const spot = this.spotMid(perp.coin);
    return spot ? coinsPerPriceUnit(perp.price, spot) : null;
  }

  // Cheapest place to buy the coin, fee included.
  private bestSpot(coin: string) {
    return this.spotSides(coin).sort((a, b) => a.ask * (1 + a.fee) - b.ask * (1 + b.fee))[0] || null;
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
    return book && now - book.at <= BOOK_TTL_MS ? book : undefined;
  }

  private decide(now: number) {
    const c = this.config();
    this.reasons.clear();
    // Close first, so freed capital can be reused.
    for (const p of [...this.state.positions]) {
      const perp = this.perps.get(p.perpId), book = this.freshBook(p.perpId, now);
      const spot = this.spotSides(p.coin).find((s) => s.venue === p.spotVenue);
      if (!perp || !book || !spot) continue;
      const mark = markCarry(p, spot.bid, book.ask, perp.shortMargin);
      const recent = trailingApr(this.history.get(p.perpId) || [], now - EXIT_HOURS * 3_600_000, 3);
      const reason = mark.riseToMarginCall < MIN_RISE_TO_CALL ? "Too close to a margin call" :
        recent !== null && recent * 100 < c.exitApr && now - p.openedAt > EXIT_HOURS * 3_600_000 ? `Funding averaged ${(recent * 100).toFixed(1)}%/yr over ${EXIT_HOURS}h` : null;
      if (reason) this.close(p, spot.bid, book.ask, mark.value, reason, now);
    }
    const open = new Set(this.state.positions.map((p) => p.coin));
    const quotes = [...this.perps.values()].map((perp) => ({ perp, ...this.evaluate(perp, now) }))
      .filter((q) => q.quote).sort((a, b) => b.quote!.netAprOnCapital - a.quote!.netAprOnCapital);
    for (const q of quotes) {
      const quote = q.quote!;
      // Reasons that won't clear by waiting (collateral, capital, book size) come before waiting for history.
      const block = open.has(q.perp.coin) ? "Position open" : quote.reason ??
        (q.forecast.samples < MIN_HISTORY ? `Collecting funding history (${q.forecast.samples} of ${MIN_HISTORY} hours)` :
        q.perp.fundingRate < 0 ? "Funding is negative now" :
        quote.netAprOnCapital * 100 < c.minNetApr ? `Below your ${c.minNetApr}% minimum` :
        this.state.positions.length >= c.maxPositions ? "Position limit reached" : null);
      this.reasons.set(q.perp.id, block ?? "Opened");
      if (block) continue;
      const p = openCarry(`carry-${now.toString(36)}-${q.perp.coin}`, q.perp, q.book!, q.spot!, q.unit!, quote.contracts, this.options(0), now);
      this.state.cash -= openingCost(p);
      this.state.positions.push(p);
      open.add(p.coin);
      this.store.appendCarryEvent({ time: now, event: "open", position: p, spotPrice: p.entrySpot, futuresPrice: p.entryPerp, rate: q.perp.fundingRate, amount: -openingCost(p),
        note: `expected ${(quote.netAprOnCapital * 100).toFixed(1)}%/yr on capital` });
      this.log(`CARRY OPEN   ${p.coin}: buy ${p.spotQty} on ${p.spotVenue} @ ${p.entrySpot}, short ${p.contracts} × ${p.perpId} @ ${p.entryPerp}  (expected ${(quote.netAprOnCapital * 100).toFixed(1)}%/yr)`);
    }
    this.save();
  }

  private close(p: CarryPosition, spotBid: number, perpAsk: number, value: number, reason: string, now: number) {
    p.closedAt = now; p.exitSpot = spotBid; p.exitPerp = perpAsk; p.closeReason = reason; p.realized = value - openingCost(p);
    p.fees += p.spotQty * spotBid * p.spotFee + p.contracts * p.contractSize * perpAsk * p.futuresFee;
    this.state.cash += value;
    this.state.positions = this.state.positions.filter((x) => x !== p);
    this.state.closed = [p, ...this.state.closed].slice(0, 100);
    this.store.appendCarryEvent({ time: now, event: "close", position: p, spotPrice: spotBid, futuresPrice: perpAsk, amount: value, net: p.realized, note: reason });
    this.log(`CARRY CLOSE  ${p.coin}: ${reason}; net ${p.realized >= 0 ? "+" : "-"}$${Math.abs(p.realized).toFixed(2)} (funding $${p.funding.toFixed(2)})`);
  }

  // Sizing uses an even share of the account, or whatever is free if less.
  private evaluate(perp: Perp, now: number) {
    const c = this.config();
    const book = this.freshBook(perp.id, now), spot = this.bestSpot(perp.coin), unit = this.unit(perp);
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
    let openValue = 0;
    const positions = this.state.positions.map((p) => {
      const perp = this.perps.get(p.perpId), book = this.freshBook(p.perpId, now);
      const spot = this.spotSides(p.coin).find((s) => s.venue === p.spotVenue);
      const mark = perp && book && spot ? markCarry(p, spot.bid, book.ask, perp.shortMargin) : null;
      openValue += mark ? mark.value : openingCost(p) + p.funding;
      return { ...p, mark, hours: (now - p.openedAt) / 3_600_000 };
    });
    const equity = this.state.cash + openValue;
    const allFunding = [...this.state.positions, ...this.state.closed].reduce((sum, p) => sum + p.funding, 0);
    const allFees = [...this.state.positions, ...this.state.closed].reduce((sum, p) => sum + p.fees, 0);
    const years = (now - this.state.startedAt) / (365 * 86_400_000);
    return {
      enabled: c.enabled, error: this.error, updatedAt: this.productsAt, config: c,
      account: { startedAt: this.state.startedAt, capital: this.state.capital, cash: this.state.cash, equity, pnl: equity - this.state.capital,
        funding: allFunding, fees: allFees, apr: years > 1 / 365 ? (equity / this.state.capital - 1) / years : null },
      positions, closed: this.state.closed.slice(0, 30), perps, dated,
      events: this.store.readRecentCarryEvents(30),
    };
  }
}
