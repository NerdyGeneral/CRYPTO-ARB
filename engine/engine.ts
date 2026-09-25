import { fetchBook } from "../lib/exchanges";
import { emptyMarkets, routesFor, supportedPair, type Quote, type Route, type Snapshot, type SymbolName, type Trade, type Universe, type Venue } from "../lib/market";
import { connectMarketStreams } from "../lib/streams";
import type { EngineConfig, HourlyRow, SessionFile, Store } from "./store";

// Matches the dashboard: quotes older than 12s are dropped, REST fills in for missing streams,
// and a route is paper-traded at most once a minute.
const QUOTE_TTL_MS = 12_000;
const STREAM_FRESH_MS = 4_500;
const REST_REFRESH_MS = 6_000;
const REST_BACKOFF_MS = 30_000;
const ROUTE_COOLDOWN_MS = 60_000;
const SCAN_SPACING_MS = 250;

// Public REST budget per venue in requests per second, kept well under each exchange's published limit.
const restRate: Record<Venue, number> = {
  Coinbase: 4, Kraken: 1, Gemini: 1.5, Bitstamp: 4, "CEX.IO": 1, bitFlyer: 1, "OKX US": 4, "Crypto.com": 4,
};

type LoggedTrade = { time: number; symbol: string; buy: string; sell: string; notional: number; grossPct: number; net: number; netPct: number };
type VenueStats = { streamQuotes: number; restQuotes: number; restErrors: number; lastStreamAt: number; lastQuoteAt: number };

const pairKey = (symbol: SymbolName, venue: Venue) => `${symbol}:${venue}`;

export class Engine {
  running = true;
  readonly startedAt = Date.now();
  session: SessionFile;
  private readonly config: EngineConfig;
  private readonly store: Store;
  private readonly universe: Universe;
  private readonly pairs: { symbol: SymbolName; venue: Venue; key: string }[];
  private readonly streamed = new Map<string, Quote>();
  private readonly polled = new Map<string, Quote>();
  private readonly unavailableUntil = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly tokens = new Map<Venue, number>();
  private readonly venueStats = new Map<Venue, VenueStats>();
  private readonly recentTrades: Trade[] = [];
  private readonly tradeLog: LoggedTrade[];
  private routes: Route[] = [];
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
      time: Date.parse(row.time), symbol: row.symbol, buy: row.buy, sell: row.sell, notional: Number(row.notional_usd),
      grossPct: Number(row.gross_pct), net: Number(row.net_usd), netPct: Number(row.net_pct),
    }));
    this.universe = { assets: config.assets, venues: config.venues };
    this.pairs = config.assets.flatMap((symbol) => config.venues.filter((venue) => supportedPair(symbol, venue))
      .map((venue) => ({ symbol, venue, key: pairKey(symbol, venue) })));
    for (const venue of config.venues) {
      this.tokens.set(venue, 1);
      this.venueStats.set(venue, { streamQuotes: 0, restQuotes: 0, restErrors: 0, lastStreamAt: 0, lastQuoteAt: 0 });
    }
  }

  start() {
    this.stopStreams = connectMarketStreams(this.universe, (symbol, venue, quote) => {
      this.streamed.set(pairKey(symbol, venue), quote);
      const stats = this.venueStats.get(venue);
      if (stats) { stats.streamQuotes++; stats.lastStreamAt = stats.lastQuoteAt = quote.receivedAt; }
      this.hour.quotes++;
      this.queueScan();
    }, (symbol, venue) => { this.streamed.delete(pairKey(symbol, venue)); });
    this.timers.push(setInterval(() => this.pollRest(), 250));
    this.timers.push(setInterval(() => this.scan(), 1000));
    this.timers.push(setInterval(() => this.store.saveSession(this.session), 10_000));
    this.timers.push(setInterval(() => this.rollHour(), 30_000));
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
    this.recentTrades.length = 0;
    this.tradeLog.length = 0;
    this.hour = this.emptyHour();
    this.store.saveSession(this.session);
  }

  state() {
    const now = Date.now();
    const snapshot = this.snapshot(now);
    const feeds = this.config.venues.map((venue) => {
      const venuePairs = this.pairs.filter((pair) => pair.venue === venue);
      const live = venuePairs.filter(({ symbol }) => snapshot.markets[symbol][venue]).length;
      const stats = this.venueStats.get(venue)!;
      return {
        venue, live, pairs: venuePairs.length, streaming: now - stats.lastStreamAt < 15_000,
        lastQuoteAgoMs: stats.lastQuoteAt ? now - stats.lastQuoteAt : null,
        streamQuotes: stats.streamQuotes, restQuotes: stats.restQuotes, restErrors: stats.restErrors,
      };
    });
    return {
      now, startedAt: this.startedAt, running: this.running, dataDir: this.store.dir,
      session: { ...this.session, startingBalance: this.config.startingBalance, pnl: this.session.balance - this.config.startingBalance },
      settings: this.config.settings, universe: this.universe, feeds,
      routes: this.routes.filter((route) => !route.indicative).slice(0, 15),
      suspectRoutes: this.routes.filter((route) => route.suspect).slice(0, 10),
      currentHour: this.hourRow(),
      trades: this.tradeLog,
      hours: this.store.readRecentHours(24),
    };
  }

  private snapshot(now: number): Snapshot {
    const markets = emptyMarkets();
    for (const { symbol, venue, key } of this.pairs) {
      const streamed = this.streamed.get(key), polled = this.polled.get(key);
      const quote = streamed && streamed.receivedAt > (polled?.receivedAt || 0) ? streamed : polled;
      if (quote && now - quote.receivedAt <= QUOTE_TTL_MS) markets[symbol][venue] = quote;
    }
    return { generatedAt: now, markets, errors: [] };
  }

  // Poll only pairs whose stream is missing or quiet, spending each venue's REST budget on the stalest one.
  private pollRest() {
    const now = Date.now();
    for (const venue of this.config.venues) {
      const tokens = Math.min(2, (this.tokens.get(venue) || 0) + restRate[venue] / 4);
      this.tokens.set(venue, tokens);
      if (tokens < 1) continue;
      const due = this.pairs.filter(({ venue: v, key }) => v === venue && !this.inFlight.has(key) &&
        now - (this.streamed.get(key)?.receivedAt || 0) > STREAM_FRESH_MS &&
        now - (this.polled.get(key)?.receivedAt || 0) > REST_REFRESH_MS &&
        (this.unavailableUntil.get(key) || 0) < now);
      if (!due.length) continue;
      const next = due.reduce((a, b) => (this.polled.get(a.key)?.receivedAt || 0) <= (this.polled.get(b.key)?.receivedAt || 0) ? a : b);
      this.tokens.set(venue, tokens - 1);
      this.inFlight.add(next.key);
      void fetchBook(next.symbol, next.venue).then((result) => {
        const stats = this.venueStats.get(venue)!;
        if (result.book) {
          this.polled.set(next.key, result.book);
          stats.restQuotes++;
          stats.lastQuoteAt = result.book.receivedAt;
          this.hour.quotes++;
          this.queueScan();
        } else {
          stats.restErrors++;
          this.unavailableUntil.set(next.key, Date.now() + REST_BACKOFF_MS);
        }
      }).finally(() => this.inFlight.delete(next.key));
    }
  }

  private queueScan() {
    if (this.scanTimer) return;
    const delay = Math.max(0, SCAN_SPACING_MS - (Date.now() - this.lastScanAt));
    this.scanTimer = setTimeout(() => { this.scanTimer = undefined; this.scan(); }, delay);
  }

  private scan() {
    const now = Date.now();
    this.lastScanAt = now;
    const { settings } = this.config;
    this.routes = routesFor(this.snapshot(now), settings, this.session.balance, this.universe, now);
    const tradable = this.routes.filter((route) => !route.indicative && !route.suspect);
    for (const route of tradable) {
      if (this.hour.bestNetPct === null || route.netPct > this.hour.bestNetPct) this.hour.bestNetPct = route.netPct;
      if (this.hour.bestGrossPct === null || route.grossPct > this.hour.bestGrossPct) this.hour.bestGrossPct = route.grossPct;
    }
    for (const route of this.routes) if (route.suspect) this.hour.suspectKeys.add(route.key);
    if (!this.running) return;
    this.session.scans++;
    this.hour.scans++;
    const chosen = tradable.find((route) => route.net > 0 && route.net >= settings.minNet &&
      !this.recentTrades.some((trade) => trade.key === route.key && now - trade.time < ROUTE_COOLDOWN_MS));
    if (!chosen) return;
    const trade: Trade = { ...chosen, id: `${now}-${chosen.key}`, time: now };
    this.session.balance += trade.net;
    this.session.tradeCount++;
    this.hour.trades++;
    this.hour.pnl += trade.net;
    this.recentTrades.unshift(trade);
    this.recentTrades.length = Math.min(this.recentTrades.length, 100);
    this.tradeLog.unshift({ time: now, symbol: trade.symbol, buy: trade.buy, sell: trade.sell, notional: trade.notional, grossPct: trade.grossPct, net: trade.net, netPct: trade.netPct });
    this.tradeLog.length = Math.min(this.tradeLog.length, 50);
    this.store.appendTrade(trade);
    console.log(`${new Date(now).toLocaleTimeString()}  PAPER TRADE  ${trade.symbol} ${trade.buy} -> ${trade.sell}  net ${trade.net >= 0 ? "+" : ""}$${trade.net.toFixed(2)} (${trade.netPct.toFixed(2)}%)  balance $${this.session.balance.toFixed(2)}`);
  }

  private emptyHour() {
    const start = new Date(); start.setMinutes(0, 0, 0);
    return { start: start.getTime(), scans: 0, trades: 0, pnl: 0, quotes: 0, bestNetPct: null as number | null, bestGrossPct: null as number | null, suspectKeys: new Set<string>() };
  }

  private hourRow(): HourlyRow {
    const { start, scans, trades, pnl, quotes, bestNetPct, bestGrossPct, suspectKeys } = this.hour;
    return { hour: new Date(start).toISOString(), scans, trades, pnl, quotes, bestNetPct, bestGrossPct, suspectRoutes: suspectKeys.size };
  }

  // Write one summary line per clock hour so a day away can be reviewed at a glance.
  private rollHour() {
    const current = new Date(); current.setMinutes(0, 0, 0);
    if (current.getTime() === this.hour.start) return;
    const row = this.hourRow();
    this.store.appendHourly(row);
    console.log(`${new Date().toLocaleTimeString()}  HOUR ${new Date(this.hour.start).toLocaleTimeString([], { hour: "numeric" })}  scans ${row.scans}  trades ${row.trades}  pnl $${row.pnl.toFixed(2)}  best net ${row.bestNetPct?.toFixed(2) ?? "—"}%  suspect routes ${row.suspectRoutes}`);
    this.hour = this.emptyHour();
  }
}
