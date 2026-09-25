import { discover, selectMarkets, type Listing } from "../lib/discovery";
import { batchVenues, fetchBatchBooks, fetchMarketBook } from "../lib/exchanges";
import { supportedPair, symbols, type Quote, type Venue } from "../lib/market";
import { keyOf, usdMarket, type Market } from "../lib/markets";
import { chooseTrade, scanOpportunities, type Opportunity, type Rate, type TradeMemory } from "../lib/opportunities";
import { connectStreams } from "../lib/streams";
import type { EngineConfig, HourlyRow, SessionFile, Store, TradeRecord } from "./store";

// A quote counts as streamed while its feed has updated within this window; otherwise REST fills in.
const STREAM_FRESH_MS = 4_500;
const REST_REFRESH_MS = 6_000;
const REST_BACKOFF_MS = 30_000;
const BATCH_INTERVAL_MS = 3_000;
const ROUTE_COOLDOWN_MS = 60_000;
const SCAN_SPACING_MS = 500;
const REDISCOVER_MS = 12 * 60 * 60 * 1000;
const QUOTE_TTL_MS = 12_000;
// Crypto.com's USD books are a USD bundle, so its routes are shown but never paper-traded.
const INDICATIVE: Venue[] = ["Crypto.com"];

// Per-market REST budget per venue in requests per second, well under each exchange's public limit.
const restRate: Record<Venue, number> = {
  Coinbase: 4, Kraken: 1, Gemini: 1.5, Bitstamp: 4, "CEX.IO": 0.5, bitFlyer: 1, "OKX US": 4, "Crypto.com": 4, "Binance.US": 4,
};

type VenueStats = { streamQuotes: number; restQuotes: number; restErrors: number; lastStreamAt: number; lastQuoteAt: number };
type LoggedTrade = { time: number; kind: string; path: string; notional: number; grossPct: number; net: number; netPct: number };
type Coverage = { coins: string[]; markets: number; fetchedAt: number; source: "live" | "cache" | "built-in"; errors: string[] };

export class Engine {
  running = true;
  ready = false;
  readonly startedAt = Date.now();
  session: SessionFile;
  private readonly config: EngineConfig;
  private readonly store: Store;
  private markets: Market[] = [];
  private coverage: Coverage = { coins: [], markets: 0, fetchedAt: 0, source: "built-in", errors: [] };
  private readonly quotes = new Map<string, Quote>();
  private readonly streamedAt = new Map<string, number>();
  private readonly unavailableUntil = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly tokens = new Map<Venue, number>();
  private readonly lastBatchAt = new Map<Venue, number>();
  private readonly venueStats = new Map<Venue, VenueStats>();
  private readonly memory: TradeMemory = { recent: new Map(), consumed: new Map() };
  private readonly tradeLog: LoggedTrade[];
  private top: Opportunity[] = [];
  private suspects: Opportunity[] = [];
  private rates: Record<string, Rate> = {};
  private lastScanAt = 0;
  private scanTimer: ReturnType<typeof setTimeout> | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopStreams: () => void = () => {};
  private hour = this.emptyHour();

  constructor(config: EngineConfig, store: Store) {
    this.config = config;
    this.store = store;
    this.session = store.loadSession(config.startingBalance);
    this.tradeLog = store.readRecentTrades(50).map((row) => ({
      time: Date.parse(row.time), kind: row.kind, path: row.path, notional: Number(row.notional_usd),
      grossPct: Number(row.gross_pct), net: Number(row.net_usd), netPct: Number(row.net_pct),
    }));
    for (const venue of config.venues) {
      this.tokens.set(venue, 1);
      this.venueStats.set(venue, { streamQuotes: 0, restQuotes: 0, restErrors: 0, lastStreamAt: 0, lastQuoteAt: 0 });
    }
  }

  async start() {
    await this.loadMarkets();
    this.connect();
    this.ready = true;
    this.timers.push(setInterval(() => this.pollRest(), 250));
    this.timers.push(setInterval(() => this.scan(), 1000));
    this.timers.push(setInterval(() => this.store.saveSession(this.session), 10_000));
    this.timers.push(setInterval(() => this.rollHour(), 30_000));
    this.timers.push(setInterval(() => void this.refreshMarkets(), REDISCOVER_MS));
  }

  stop() {
    this.stopStreams();
    for (const timer of this.timers) clearInterval(timer);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.store.saveSession(this.session);
  }

  setRunning(running: boolean) { this.running = running; }

  resetSession() {
    this.store.archiveLogs();
    this.session = { startedAt: Date.now(), balance: this.config.startingBalance, scans: 0, tradeCount: 0 };
    this.memory.recent.clear();
    this.memory.consumed.clear();
    this.tradeLog.length = 0;
    this.hour = this.emptyHour();
    this.store.saveSession(this.session);
  }

  get summary() { return { coins: this.coverage.coins.length, markets: this.markets.length, source: this.coverage.source, errors: this.coverage.errors }; }

  // Live listings when reachable, otherwise the last saved ones, otherwise the dashboard's built-in USD coins.
  private async loadMarkets() {
    let listing: Listing | null = null;
    let source: Coverage["source"] = "live";
    try {
      listing = await discover(this.config.venues);
      if (listing.markets.length) this.store.saveListing(listing); else listing = null;
    } catch { listing = null; }
    if (!listing) { listing = this.store.loadListing(); source = "cache"; }
    if (listing) {
      const selection = selectMarkets(listing, {
        tradableVenues: this.config.venues.filter((venue) => !INDICATIVE.includes(venue)), topCoins: this.config.topCoins,
        include: this.config.extraCoins, exclude: this.config.excludeCoins, triangular: this.config.triangular,
      });
      this.markets = selection.markets.filter((market) => this.config.venues.includes(market.venue));
      this.coverage = { coins: selection.coins, markets: this.markets.length, fetchedAt: listing.fetchedAt, source, errors: listing.errors };
    } else {
      this.markets = this.config.venues.flatMap((venue) => symbols.filter((symbol) => supportedPair(symbol, venue)).map((symbol) => usdMarket(symbol, venue)));
      this.coverage = { coins: [...symbols], markets: this.markets.length, fetchedAt: 0, source: "built-in", errors: ["Exchange listings unavailable; using the built-in USD coins"] };
    }
  }

  private async refreshMarkets() {
    await this.loadMarkets();
    this.stopStreams();
    this.connect();
    console.log(`${new Date().toLocaleTimeString()}  Refreshed listings: ${this.coverage.coins.length} coins, ${this.markets.length} markets`);
  }

  private connect() {
    this.stopStreams = connectStreams(this.markets, (market, quote) => {
      const key = keyOf(market);
      const previous = this.quotes.get(key);
      this.quotes.set(key, quote);
      this.streamedAt.set(key, quote.receivedAt);
      const stats = this.venueStats.get(market.venue);
      if (stats) { stats.streamQuotes++; stats.lastStreamAt = stats.lastQuoteAt = quote.receivedAt; }
      this.hour.quotes++;
      // Depth changes below the best level re-send the same top of book; only a new top needs a rescan.
      if (!previous || previous.bid !== quote.bid || previous.ask !== quote.ask || previous.bidSize !== quote.bidSize || previous.askSize !== quote.askSize) this.queueScan();
    }, (market) => { this.streamedAt.delete(keyOf(market)); });
  }

  private needsRest(market: Market, now: number) {
    const key = keyOf(market);
    return now - (this.streamedAt.get(key) || 0) > STREAM_FRESH_MS && (this.unavailableUntil.get(key) || 0) < now;
  }

  private storePolled(market: Market, quote: Quote) {
    const key = keyOf(market);
    const current = this.quotes.get(key);
    if (current && current.receivedAt >= quote.receivedAt) return;
    this.quotes.set(key, quote);
    const stats = this.venueStats.get(market.venue);
    if (stats) { stats.restQuotes++; stats.lastQuoteAt = quote.receivedAt; }
    this.hour.quotes++;
  }

  // Venues with an all-markets endpoint are refreshed in one request; the rest spend a per-venue
  // budget on their stalest market without a live stream.
  private pollRest() {
    const now = Date.now();
    for (const venue of this.config.venues) {
      const venueMarkets = this.markets.filter((market) => market.venue === venue);
      if (!venueMarkets.length) continue;
      if (batchVenues.includes(venue)) {
        if (this.inFlight.has(venue) || now - (this.lastBatchAt.get(venue) || 0) < BATCH_INTERVAL_MS) continue;
        const due = venueMarkets.filter((market) => this.needsRest(market, now));
        if (!due.length) continue;
        this.inFlight.add(venue);
        this.lastBatchAt.set(venue, now);
        void fetchBatchBooks(venue, due).then((books) => {
          for (const market of due) { const quote = books.get(keyOf(market)); if (quote) this.storePolled(market, quote); }
          if (books.size) this.queueScan();
        }).catch(() => { this.venueStats.get(venue)!.restErrors++; }).finally(() => this.inFlight.delete(venue));
        continue;
      }
      const tokens = Math.min(2, (this.tokens.get(venue) || 0) + restRate[venue] / 4);
      this.tokens.set(venue, tokens);
      if (tokens < 1) continue;
      let next: Market | undefined;
      let oldest = Infinity;
      for (const market of venueMarkets) {
        const key = keyOf(market);
        const age = this.quotes.get(key)?.receivedAt || 0;
        if (this.inFlight.has(key) || now - age <= REST_REFRESH_MS || !this.needsRest(market, now)) continue;
        if (age < oldest) { oldest = age; next = market; }
      }
      if (!next) continue;
      const market = next, key = keyOf(market);
      this.tokens.set(venue, tokens - 1);
      this.inFlight.add(key);
      void fetchMarketBook(market).then((quote) => { this.storePolled(market, quote); this.queueScan(); })
        .catch(() => { this.venueStats.get(venue)!.restErrors++; this.unavailableUntil.set(key, Date.now() + REST_BACKOFF_MS); })
        .finally(() => this.inFlight.delete(key));
    }
  }

  private queueScan() {
    if (this.scanTimer) return;
    const delay = Math.max(0, SCAN_SPACING_MS - (Date.now() - this.lastScanAt));
    this.scanTimer = setTimeout(() => { this.scanTimer = undefined; this.scan(); }, delay);
  }

  private scan() {
    if (!this.ready) return;
    const now = Date.now();
    this.lastScanAt = now;
    const { settings } = this.config;
    const result = scanOpportunities({
      markets: this.markets, quotes: this.quotes, settings, conversionFee: this.config.conversionFee,
      balance: this.session.balance, now, triangular: this.config.triangular,
    });
    this.hour.scanMs += Date.now() - now;
    this.hour.scanCount++;
    this.top = result.top;
    this.suspects = result.suspects;
    this.rates = result.rates;
    const tradable = result.top.filter((o) => !o.venues.some((venue) => INDICATIVE.includes(venue)));
    for (const o of tradable) {
      const field = o.kind === "triangle" ? "bestTriangleNetPct" : "bestNetPct";
      if (this.hour[field] === null || o.netPct > this.hour[field]!) this.hour[field] = o.netPct;
    }
    for (const o of result.top) if (this.hour.bestGrossPct === null || o.grossPct > this.hour.bestGrossPct) this.hour.bestGrossPct = o.grossPct;
    for (const o of result.suspects) this.hour.suspectKeys.add(o.key);
    if (!this.running) return;
    this.session.scans++;
    this.hour.scans++;
    const chosen = chooseTrade(tradable, this.memory, { minNet: settings.minNet, now, cooldownMs: ROUTE_COOLDOWN_MS });
    if (!chosen) return;
    const trade: TradeRecord = { ...chosen, time: now };
    this.session.balance += trade.net;
    this.session.tradeCount++;
    this.hour.trades++;
    this.hour.pnl += trade.net;
    this.tradeLog.unshift({ time: now, kind: trade.kind, path: trade.path, notional: trade.notional, grossPct: trade.grossPct, net: trade.net, netPct: trade.netPct });
    this.tradeLog.length = Math.min(this.tradeLog.length, 50);
    this.store.appendTrade(trade);
    console.log(`${new Date(now).toLocaleTimeString()}  PAPER TRADE  ${trade.path}  net ${trade.net >= 0 ? "+" : ""}$${trade.net.toFixed(2)} (${trade.netPct.toFixed(2)}%)  balance $${this.session.balance.toFixed(2)}`);
  }

  state() {
    const now = Date.now();
    const feeds = this.config.venues.map((venue) => {
      const venueMarkets = this.markets.filter((market) => market.venue === venue);
      const live = venueMarkets.filter((market) => now - (this.quotes.get(keyOf(market))?.receivedAt || 0) <= QUOTE_TTL_MS).length;
      const stats = this.venueStats.get(venue)!;
      return {
        venue, live, markets: venueMarkets.length, streaming: now - stats.lastStreamAt < 15_000, indicative: INDICATIVE.includes(venue),
        lastQuoteAgoMs: stats.lastQuoteAt ? now - stats.lastQuoteAt : null,
        streamQuotes: stats.streamQuotes, restQuotes: stats.restQuotes, restErrors: stats.restErrors,
      };
    });
    return {
      now, startedAt: this.startedAt, ready: this.ready, running: this.running, dataDir: this.store.dir,
      session: { ...this.session, startingBalance: this.config.startingBalance, pnl: this.session.balance - this.config.startingBalance },
      settings: this.config.settings, conversionFee: this.config.conversionFee, triangular: this.config.triangular,
      coverage: { ...this.coverage, coins: this.coverage.coins.length, topCoins: this.coverage.coins.slice(0, 12) },
      rates: this.rates, feeds, routes: this.top.slice(0, 15), suspectRoutes: this.suspects,
      currentHour: this.hourRow(), trades: this.tradeLog, hours: this.store.readRecentHours(24),
    };
  }

  private emptyHour() {
    const start = new Date(); start.setMinutes(0, 0, 0);
    return {
      start: start.getTime(), scans: 0, trades: 0, pnl: 0, quotes: 0, scanMs: 0, scanCount: 0,
      bestNetPct: null as number | null, bestTriangleNetPct: null as number | null, bestGrossPct: null as number | null, suspectKeys: new Set<string>(),
    };
  }

  private hourRow(): HourlyRow {
    const h = this.hour;
    return {
      hour: new Date(h.start).toISOString(), scans: h.scans, trades: h.trades, pnl: h.pnl, quotes: h.quotes,
      bestNetPct: h.bestNetPct, bestTriangleNetPct: h.bestTriangleNetPct, bestGrossPct: h.bestGrossPct,
      suspectRoutes: h.suspectKeys.size, avgScanMs: h.scanCount ? h.scanMs / h.scanCount : 0,
    };
  }

  // Write one summary line per clock hour so a day away can be reviewed at a glance.
  private rollHour() {
    const current = new Date(); current.setMinutes(0, 0, 0);
    if (current.getTime() === this.hour.start) return;
    const row = this.hourRow();
    this.store.appendHourly(row);
    const pct = (n: number | null) => n === null ? "—" : `${n.toFixed(2)}%`;
    console.log(`${new Date().toLocaleTimeString()}  HOUR ${new Date(this.hour.start).toLocaleTimeString([], { hour: "numeric" })}  trades ${row.trades}  pnl $${row.pnl.toFixed(2)}  best cross ${pct(row.bestNetPct)}  best triangle ${pct(row.bestTriangleNetPct)}  suspect ${row.suspectRoutes}`);
    this.hour = this.emptyHour();
  }
}
