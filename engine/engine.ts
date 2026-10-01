import crypto from "node:crypto";
import { accuracy, addReplay, emptyTally, histogram, verdictKinds, verdictSummary, type VerdictGroup } from "../lib/accuracy";
import type { SpotSide } from "../lib/carry";
import { discover, selectMarkets, type Listing } from "../lib/discovery";
import { batchVenues, fetchBatchBooks, fetchMarketBook } from "../lib/exchanges";
import { sendInParallel } from "../lib/execution";
import { feeKey, quoteFresh, supportedPair, symbols, type Quote, type Venue } from "../lib/market";
import { keyOf, usdMarket, type Market } from "../lib/markets";
import { barrierKey, blockReason, chooseTrade, indexRoutes, scanMarket, scanOpportunities, type Leg, type Opportunity, type Rate, type RouteIndex, type TradeMemory } from "../lib/opportunities";
import { checkLeg, normalizeLeg, normalizeCrossOpportunity, coinbaseCreateOrder, krakenAddOrder } from "../lib/orders";
import { fillLeg, LatencyTracker, settle, type LegFill } from "../lib/shadow";
import { coinbaseJwt, krakenSignature } from "../lib/signing";
import { connectStreams } from "../lib/streams";
import { judge, tokenMap, transferStatus, type TokenMap, type Transfer, type Verdict, type VerdictKind } from "../lib/verify";
import { Carry } from "./carry";
import { Connections } from "./connections";
import * as wallet from "../lib/portfolio";
import { normalizeConfig, Store, type EngineConfig, type HourlyRow, type SessionFile, type ShadowRecord, type TradeRecord } from "./store";

// A quote counts as streamed while its feed has updated within this window; otherwise REST fills in.
const STREAM_FRESH_MS = 4_500;
const REST_REFRESH_MS = 6_000;
const REST_BACKOFF_MS = 30_000;
const BATCH_INTERVAL_MS = 3_000;
const ROUTE_COOLDOWN_MS = 60_000;
// Every route is rescanned on this interval for the dashboard, the hourly stats and stablecoin rate changes;
// trading itself reacts to each price change as it arrives.
const FULL_SCAN_MS = 500;
const REDISCOVER_MS = 12 * 60 * 60 * 1000;
const QUOTE_TTL_MS = 12_000;
// Shadow mode: how often to re-measure each venue's round trip (the time to prepare orders is measured at start).
const REACTION_SAMPLES = 1000;
// Often enough that each exchange's connection never sits idle long enough to be closed.
const LATENCY_PROBE_MS = 15_000;
// Route verification: one route at a time, spaced for CoinGecko's keyless limit, results kept for hours.
// Suspect gaps are checked first, then routes that were paper-traded, to measure the max-gap rule both ways.
const VERIFY_SPACING_MS = 20_000;
const VERDICT_TTL_MS = 6 * 60 * 60 * 1000;
const VERDICT_RETRY_MS = 10 * 60 * 1000;
const TRADED_ROUTES_KEPT = 200;
// Replays kept for the estimate-error histogram.
const ERROR_SAMPLE = 500;
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const TRANSFER_TTL_MS = 60 * 60 * 1000;
const SUSPECT_FORGET_MS = 10 * 60 * 1000;
// CoinGecko's keyless API allows only a handful of requests a minute, and answers 429 beyond that.
const COINGECKO_SPACING_MS = 6_500;
const COINGECKO_BACKOFF_MS = 60_000;
const probeHeaders = { Accept: "application/json", "User-Agent": "arbiter-live/0.1" };
// Lightweight public requests used to time a round trip to each exchange's API.
const probes: Record<Venue, { url: string; init?: { method: string; body: string; headers: Record<string, string> }; everyMs?: number }> = {
  Coinbase: { url: "https://api.exchange.coinbase.com/time" },
  Kraken: { url: "https://api.kraken.com/0/public/Time" },
  Gemini: { url: "https://api.gemini.com/v2/ticker/btcusd" },
  Bitstamp: { url: "https://www.bitstamp.net/api/v2/ticker/btcusd/" },
  // CEX.IO counts every request against ~100 a minute, so it is timed less often.
  "CEX.IO": { url: "https://trade.cex.io/api/spot/rest-public/get_server_time", init: { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }, everyMs: 60_000 },
  "Binance.US": { url: "https://api.binance.us/api/v3/ping" },
  bitFlyer: { url: "https://api.bitflyer.com/v1/gethealth" },
  "OKX US": { url: "https://us.okx.com/api/v5/public/time" },
  "Crypto.com": { url: "https://api.crypto.com/exchange/v1/public/get-book?instrument_name=BTC_USD&depth=1" },
};
// Crypto.com's USD books are a USD bundle, so its routes are shown but never paper-traded.
const INDICATIVE: Venue[] = ["Crypto.com"];
// CEX.IO's public API allows about 100 requests a minute per IP, so only its highest-volume books are followed.
const MAX_BOOKS_PER_VENUE: Partial<Record<Venue, number>> = { "CEX.IO": 80 };

// Per-market REST budget per venue in requests per second, well under each exchange's public limit.
const restRate: Record<Venue, number> = {
  Coinbase: 4, Kraken: 1, Gemini: 1.5, Bitstamp: 4, "CEX.IO": 0.2, bitFlyer: 1, "OKX US": 4, "Crypto.com": 4, "Binance.US": 4,
};

type VenueStats = { streamQuotes: number; restQuotes: number; restErrors: number; lastStreamAt: number; lastQuoteAt: number };
type LoggedTrade = { time: number; kind: string; path: string; notional: number; grossPct: number; net: number; netPct: number };
type LoggedShadow = { time: number; kind: string; path: string; expectedNet: number; realizedNet: number | null; accountingComplete?: boolean; outcome: string; filledFraction: number; latencyMs: number; unwound: string };
type Coverage = { coins: string[]; markets: number; fetchedAt: number; source: "live" | "cache" | "built-in"; errors: string[] };

export class Engine {
  running = true;
  ready = false;
  readonly startedAt = Date.now();
  session: SessionFile;
  private config: EngineConfig;
  private readonly store: Store;
  private markets: Market[] = [];
  private coverage: Coverage = { coins: [], markets: 0, fetchedAt: 0, source: "built-in", errors: [] };
  private portfolio!: wallet.PortfolioState;
  private generation = 0;
  private pollEpoch = 0;
  private resetting = false;
  private resetPending: Promise<void> | null = null;
  private stopping = false;
  private readonly carryPending = new Set<Promise<void>>();
  private recovery: Promise<void> = Promise.resolve();
  private readonly activeSimulations = new Set<Promise<unknown>>();
  private readonly invalidatedAt = new Map<string, number>();
  private auditError: string | null = null;
  private readonly quotes = new Map<string, Quote>();
  private readonly streamedAt = new Map<string, number>();
  private readonly unavailableUntil = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly tokens = new Map<Venue, number>();
  private readonly lastBatchAt = new Map<Venue, number>();
  private readonly venueStats = new Map<Venue, VenueStats>();
  private readonly memory: TradeMemory = { recent: new Map(), consumed: new Map(), barriers: new Map() };
  private readonly tradeLog: LoggedTrade[];
  private readonly shadowLog: LoggedShadow[];
  private readonly shadowErrors: number[];
  private readonly latency = new LatencyTracker(300, 40);
  private readonly probedAt = new Map<Venue, number>();
  private readonly connections = new Connections();
  private readonly reconnects = new Map<Venue, number>();
  private marketByKey = new Map<string, Market>();
  // Time to build and sign one order, measured at start; added to the decision time in the replay.
  private readonly orderPrepMs = measureOrderPrep();
  private readonly suspectSeen = new Map<string, { first: number; last: number }>();
  private readonly verdicts = new Map<string, Verdict>();
  // Latest verdict per route and group ("suspect" or "traded"), for the accuracy figures and re-check timing.
  private readonly checked = new Map<string, { group: VerdictGroup; kind: VerdictKind; until: number }>();
  private readonly tradedRoutes = new Map<string, Opportunity>();
  private readonly tokenCache = new Map<string, { at: number; map: TokenMap | null }>();
  private readonly transferCache = new Map<string, { at: number; status: Transfer | null }>();
  private verifying = false;
  private coingeckoAt = 0;
  private lastVerifyAt = 0;
  private reasons = new Map<string, string>();
  private top: Opportunity[] = [];
  private suspects: Opportunity[] = [];
  private rates: Record<string, Rate> = {};
  private index: RouteIndex = indexRoutes([]);
  // How long each check took from a price change to a decision, most recent last.
  private readonly reactionMs: number[] = [];
  private eventTrades = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopStreams: () => void = () => {};
  private hour = this.emptyHour();
  private hours: Record<string, string>[] = [];
  private readonly carry: Carry;

  constructor(config: EngineConfig, store: Store) {
    this.config = config;
    this.store = store;
    const { hour, ...session } = store.loadSession(config.startingBalance);
    this.session = session;
    if (session.legacyEstimate) this.session.balance = session.startingBalance + session.shadow.realized;
    this.portfolio = session.portfolio || wallet.initialPortfolio(session.startingBalance, config.venues.filter(v => !INDICATIVE.includes(v)));
    const interrupted = Object.keys(this.portfolio.reservations);
    // No exchange orders exist. An interrupted, uncommitted paper simulation is abandoned, never inferred filled.
    for (const id of Object.keys(this.portfolio.reservations)) this.portfolio = wallet.cancel(this.portfolio, id).state;
    this.session.portfolio = this.portfolio;
    this.session.pendingTrades = {};

    // An hour saved by the last run carries on; if it has since ended, the first roll writes it out.
    if (hour) this.hour = { ...hour, suspectKeys: new Set(hour.suspectKeys), shadow: { ...hour.shadow } };
    this.hours = store.readRecentHours(48);
    this.tradeLog = store.readRecentTrades(50).map((row) => ({
      time: Date.parse(row.time), kind: row.kind, path: row.path, notional: Number(row.notional_usd),
      grossPct: Number(row.gross_pct), net: Number(row.net_usd), netPct: Number(row.net_pct),
    }));
    const shadowRows = store.readRecentShadow(ERROR_SAMPLE);
    this.shadowLog = shadowRows.slice(0, 50).map((row) => ({
      time: Date.parse(row.time), kind: row.kind, path: row.path, expectedNet: Number(row.expected_net_usd), realizedNet: row.realized_net_usd === "" ? null : Number(row.realized_net_usd),
      outcome: row.outcome, filledFraction: Number(row.filled_fraction), latencyMs: Number(row.latency_ms), unwound: row.unwound || "",
    }));
    this.shadowErrors = shadowRows.filter(row => row.realized_net_usd !== "").map((row) => Number(row.realized_net_usd) - Number(row.expected_net_usd)).filter(Number.isFinite);
    // Newest first, so the first row seen for a route is its latest verdict. Saved verdicts count toward the
    // accuracy figures; routes still around are checked again so their details can be shown.
    const seenRoutes = new Set<string>();
    for (const row of store.readRecentVerdicts(5000)) {
      const id = `${row.group}|${row.route_key}`, kind = row.kind as VerdictKind;
      if (!verdictKinds.includes(kind)) continue;
      // Recent barriers keep blocking their routes until the routes are checked again.
      if (!seenRoutes.has(row.route_key) && Date.now() - Date.parse(row.time) < VERDICT_TTL_MS) this.recordBarrier(row.route_key, kind);
      seenRoutes.add(row.route_key);
      if (this.checked.has(id) || (row.group !== "suspect" && row.group !== "traded")) continue;
      this.checked.set(id, { group: row.group, kind, until: 0 });
    }
    this.trackVenues();
    this.carry = new Carry(() => this.config.carry, store, (coin) => this.spotSides(coin),
      (line) => console.log(`${new Date().toLocaleTimeString()}  ${line}`));
    this.recovery = this.store.appendAudit({version:1,event:interrupted.length ? "simulation_recovery" : "session_open",
      sessionId:this.session.id,time:Date.now(),payload:{interrupted,action:"Uncommitted paper simulations cancelled; no fills inferred",legacyEstimate:this.session.legacyEstimate ?? null},checkpoint:this.checkpoint()});
    void this.recovery.catch(error => {this.auditError = String(error); this.running = false;});
  }

  async start() {
    await this.recovery;
    // The coins with US perpetual futures are followed on spot too, so the carry has prices for both legs.
    if (this.config.carry.enabled) await this.carry.refreshProducts().catch(() => { /* Retried by the carry's own schedule. */ });
    await this.loadMarkets();
    if (this.stopping) return;
    this.connect();
    this.ready = true;
    this.timers.push(setInterval(() => this.pollRest(), 250));
    this.timers.push(setInterval(() => this.scan(), FULL_SCAN_MS));
    this.timers.push(setInterval(() => this.saveSession(), 10_000));
    this.timers.push(setInterval(() => this.rollHour(), 30_000));
    this.rollHour();
    this.timers.push(setInterval(() => void this.refreshMarkets(), REDISCOVER_MS));
    this.timers.push(setInterval(() => this.probeLatency(), 5_000));
    this.timers.push(setInterval(() => void this.verifyNext(), 5_000));
    this.timers.push(setInterval(() => this.tickCarry(), 5_000));
    this.probeLatency();
  }

  async stop() {
    this.stopping = true;
    this.running = false;
    this.generation++;
    this.pollEpoch++;
    this.stopStreams();
    for (const timer of this.timers) clearInterval(timer);
    this.connections.close();
    await this.resetPending;
    await Promise.allSettled([...this.activeSimulations]);
    await Promise.allSettled([...this.carryPending]);
    await this.saveSession();
    await this.carry.save();
    await this.store.flush();
  }

  setRunning(running: boolean) {
    this.running = running && !this.resetting && !this.stopping && !this.auditError && !this.store.writeError;
  }

  resetSession() {
    if (this.resetting || this.stopping) return Promise.reject(new Error("Session is changing"));
    const pending = this.performReset().finally(() => { this.resetPending = null; });
    this.resetPending = pending;
    return pending;
  }

  private async performReset() {
    this.resetting = true;
    const resume = this.running;
    this.running = false;
    this.generation++;
    this.pollEpoch++;
    await Promise.allSettled([...this.activeSimulations]);
    await Promise.allSettled([...this.carryPending]);
    await this.store.archiveLogs();
    this.session = Store.freshSession(this.config.startingBalance);
    this.portfolio = wallet.initialPortfolio(this.config.startingBalance, this.config.venues.filter(v => !INDICATIVE.includes(v)));
    this.session.portfolio = this.portfolio;
    this.session.pendingTrades = {};
    this.shadowLog.length = 0;
    this.shadowErrors.length = 0;
    this.verdicts.clear();
    this.checked.clear();
    this.tradedRoutes.clear();
    this.memory.recent.clear();
    this.memory.consumed.clear();
    this.memory.barriers?.clear();
    this.tradeLog.length = 0;
    this.hour = this.emptyHour();
    this.hours = [];
    await this.saveSession();
    await this.carry.reset();
    await this.store.flush();
    this.running = resume && !this.stopping && !this.auditError && !this.store.writeError;
    this.resetting = false;
  }

  private tickCarry() {
    if (this.resetting || this.stopping) return;
    const pending = this.carry.tick().catch(error => {this.auditError = String(error); this.running = false;}).finally(() => {this.carryPending.delete(pending);});
    this.carryPending.add(pending);
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
        include: [...this.config.extraCoins, ...(this.config.carry.enabled ? this.carry.coins : [])], exclude: this.config.excludeCoins, triangular: this.config.triangular,
        maxPerVenue: MAX_BOOKS_PER_VENUE,
      });
      this.markets = selection.markets.filter((market) => this.config.venues.includes(market.venue));
      this.coverage = { coins: selection.coins, markets: this.markets.length, fetchedAt: listing.fetchedAt, source, errors: listing.errors };
    } else {
      this.markets = this.config.venues.flatMap((venue) => symbols.filter((symbol) => supportedPair(symbol, venue)).map((symbol) => usdMarket(symbol, venue)));
      this.coverage = { coins: [...symbols], markets: this.markets.length, fetchedAt: 0, source: "built-in", errors: ["Exchange listings unavailable; using the built-in USD coins"] };
    }
    this.index = indexRoutes(this.markets);
    this.marketByKey = new Map(this.markets.map((m) => [keyOf(m), m]));
  }

  private async refreshMarkets() {
    await this.loadMarkets();
    if (this.stopping) return;
    this.pollEpoch++;
    this.stopStreams();
    this.quotes.clear();
    this.streamedAt.clear();
    this.connect();
    console.log(`${new Date().toLocaleTimeString()}  Refreshed listings: ${this.coverage.coins.length} coins, ${this.markets.length} markets`);
  }

  private connect() {
    this.stopStreams = connectStreams(this.markets, (market, quote) => {
      if (!quoteFresh(quote)) return;
      const key = keyOf(market);
      const previous = this.quotes.get(key);
      this.quotes.set(key, quote);
      this.streamedAt.set(key, quote.receivedAt);
      const stats = this.venueStats.get(market.venue);
      if (stats) { stats.streamQuotes++; stats.lastStreamAt = stats.lastQuoteAt = quote.receivedAt; }
      this.hour.quotes++;
      // Depth changes below the best level re-send the same top of book; only a new top needs a check.
      if (!previous || previous.bid !== quote.bid || previous.ask !== quote.ask || previous.bidSize !== quote.bidSize || previous.askSize !== quote.askSize) this.react(market);
    }, (market) => {
      const key = keyOf(market);
      this.streamedAt.delete(key);
      this.quotes.delete(key);
      this.invalidatedAt.set(key, Date.now());
    });
  }

  private invalidatePoll(key: string, requestedAt: number) {
    const current = this.quotes.get(key);
    if (!current || current.receivedAt <= requestedAt) {
      this.quotes.delete(key);
      this.invalidatedAt.set(key, Date.now());
    }
  }

  private needsRest(market: Market, now: number) {
    const key = keyOf(market);
    return now - (this.streamedAt.get(key) || 0) > STREAM_FRESH_MS && (this.unavailableUntil.get(key) || 0) < now;
  }

  private storePolled(market: Market, quote: Quote) {
    const key = keyOf(market);
    const current = this.quotes.get(key);
    if (!quoteFresh(quote) || !this.marketByKey.has(key)) return;
    if ((this.invalidatedAt.get(key) || 0) >= (quote.requestStartedAt ?? quote.receivedAt)) return;
    if (current && (current.receivedAt >= (quote.requestStartedAt ?? quote.receivedAt)
      || (current.exchangeAt !== undefined && quote.exchangeAt !== undefined && current.exchangeAt > quote.exchangeAt))) return;
    this.quotes.set(key, quote);
    const stats = this.venueStats.get(market.venue);
    if (stats) { stats.restQuotes++; stats.lastQuoteAt = quote.receivedAt; }
    this.hour.quotes++;
    if (!current || current.bid !== quote.bid || current.ask !== quote.ask || current.bidSize !== quote.bidSize || current.askSize !== quote.askSize) this.react(market);
  }

  // Venues with an all-markets endpoint are refreshed in one request; the rest spend a per-venue
  // budget on their stalest market without a live stream.
  private pollRest() {
    const now = Date.now(), epoch = this.pollEpoch;
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
          if (epoch !== this.pollEpoch) return;
          for (const market of due) {
            const quote = books.get(keyOf(market));
            if (quote) this.storePolled(market, quote); else this.invalidatePoll(keyOf(market), now);
          }
        }).catch(() => { if (epoch === this.pollEpoch) { this.venueStats.get(venue)!.restErrors++; for (const m of due) this.invalidatePoll(keyOf(m), now); } }).finally(() => this.inFlight.delete(venue));
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
      void fetchMarketBook(market).then((quote) => { if (epoch === this.pollEpoch) this.storePolled(market, quote); })
        .catch(() => { if (epoch === this.pollEpoch) { this.invalidatePoll(key, now); this.venueStats.get(venue)!.restErrors++; this.unavailableUntil.set(key, Date.now() + REST_BACKOFF_MS); } })
        .finally(() => this.inFlight.delete(key));
    }
  }

  // Re-checks only the routes that use the book that just changed, and paper-trades at once if one qualifies.
  private react(market: Market) {
    if (!this.ready || !this.running || this.resetting || this.stopping || !this.config.reactToPrices) return;
    const started = performance.now(), now = Date.now();
    const { settings } = this.config;
    const found = scanMarket({
      markets: this.markets, index: this.index, quotes: this.quotes, settings, conversionFee: this.config.conversionFee,
      balance: this.config.settings.budget, now, triangular: this.config.triangular,
    }, market);
    const tradable = found.map(o => this.prepareTrade(o)).filter((o): o is Opportunity => o !== null).sort((a, b) => b.net - a.net);
    const chosen = chooseTrade(tradable, this.memory, { minNet: settings.minNet, now, cooldownMs: ROUTE_COOLDOWN_MS });
    const decisionMs = performance.now() - started;
    this.reactionMs.push(decisionMs);
    if (this.reactionMs.length > REACTION_SAMPLES) this.reactionMs.shift();
    if (chosen) { this.eventTrades++; this.executeTrade(chosen, now, decisionMs); }
  }

  private scan() {
    if (!this.ready || this.resetting || this.stopping) return;
    const now = Date.now(), started = performance.now();
    const { settings } = this.config;
    const result = scanOpportunities({
      markets: this.markets, index: this.index, quotes: this.quotes, settings, conversionFee: this.config.conversionFee,
      prepare: o => this.prepareTrade(o),
      eligible: o => blockReason(o, this.memory, {minNet: settings.minNet, now, cooldownMs: ROUTE_COOLDOWN_MS}) === null,
      balance: this.config.settings.budget, now, triangular: this.config.triangular,
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
    for (const o of result.suspects) {
      this.hour.suspectKeys.add(o.key);
      const seen = this.suspectSeen.get(o.key);
      this.suspectSeen.set(o.key, { first: seen?.first ?? now, last: now });
    }
    for (const [key, seen] of this.suspectSeen) if (now - seen.last > SUSPECT_FORGET_MS) this.suspectSeen.delete(key);
    const rules = { minNet: settings.minNet, now, cooldownMs: ROUTE_COOLDOWN_MS };
    const explain = (traded: Opportunity | null) => {
      this.reasons = new Map(result.top.map((o) => [o.key,
        o.key === traded?.key ? "Paper-traded" :
        o.venues.some((venue) => INDICATIVE.includes(venue)) ? "Indicative prices only (Crypto.com)" :
        !this.running ? "Bot paused" :
        blockReason(o, this.memory, rules) ?? this.executionProblem(o) ?? "Next in line (one trade per scan)"]));
    };
    if (!this.running) { explain(null); return; }
    this.session.scans++;
    this.hour.scans++;
    // Most trades happen in react(); a full scan still catches routes that opened up without a price change
    // on their own books, e.g. when a cooldown ends or a stablecoin's rate moves.
    const prepared = result.bestEligible;
    const chosen = chooseTrade(prepared ? [prepared] : [], this.memory, rules);
    explain(chosen);
    if (chosen) this.executeTrade(chosen, now, performance.now() - started);
  }

  private prepareTrade(o: Opportunity): Opportunity | null {
    if (o.suspect || o.net <= 0 || o.net < this.config.settings.minNet || o.venues.some(v => INDICATIVE.includes(v)) || this.auditError || this.store.writeError) return null;
    const inputs = o.kind === "triangle" ? o.legs.slice(0, 1) : o.legs;
    const fraction = Math.min(1, ...inputs.map(leg => wallet.available(this.portfolio, leg.venue, leg.side === "buy" ? leg.quote : leg.base)
      / (leg.side === "buy" ? leg.qty * leg.price * (1 + leg.fee) : leg.qty)));
    if (!Number.isFinite(fraction) || fraction <= 0) return null;
    let prepared = {...o, legs:o.legs.map(leg => ({...leg,qty:leg.qty*fraction})), notional:o.notional*fraction,
      net:o.net*fraction,fees:o.fees*fraction,conversion:o.conversion*fraction,buffer:o.buffer*fraction};
    if (prepared.notional < 5) return null;
    if (o.kind === "cross") {
      const normalized = normalizeCrossOpportunity(prepared, leg => this.marketByKey.get(leg.market)?.rules);
      if (!normalized.opportunity) return null;
      prepared = normalized.opportunity;
    } else {
      prepared = {...prepared, legs: prepared.legs.map(leg => normalizeLeg(leg, this.marketByKey.get(leg.market)?.rules))};
    }
    return this.executionProblem(prepared) ? null : prepared;
  }

  private executionProblem(o: Opportunity): string | null {
    if (this.auditError || this.store.writeError) return "Audit storage unavailable; trading paused";
    const rules = this.orderProblem(o);
    if (rules) return rules;
    const checked = wallet.canReserve(this.portfolio, o.kind === "triangle" ? o.legs.slice(0, 1) : o.legs);
    return checked.ok ? null : checked.reason || "Paper inventory unavailable";
  }

  private executeTrade(chosen: Opportunity, now: number, decisionMs: number) {
    if (this.resetting || this.stopping || !this.running || this.auditError || this.store.writeError) return;
    const id = crypto.randomUUID();
    const reservation = wallet.reserve(this.portfolio, id, chosen.kind === "triangle" ? chosen.legs.slice(0, 1) : chosen.legs);
    if (!reservation.ok) return;
    this.portfolio = reservation.state;
    (this.session.pendingTrades ??= {})[id] = chosen;
    const generation = this.generation;
    const pending = this.replayShadow(id, chosen, now, decisionMs, generation)
      .catch((error: unknown) => { this.auditError = error instanceof Error ? error.message : String(error); this.running = false; })
      .finally(() => {
        if (this.portfolio.reservations[id]) this.portfolio = wallet.cancel(this.portfolio, id).state;
        delete this.session.pendingTrades?.[id];
        this.activeSimulations.delete(pending);
      });
    this.activeSimulations.add(pending);
  }

  // Live USD books for a coin on every tradable exchange, with that exchange's taker fee, for the carry's spot leg.
  private spotSides(coin: string): SpotSide[] {
    const now = Date.now();
    return this.markets.filter((m) => m.base === coin && m.quote === "USD" && !INDICATIVE.includes(m.venue)).flatMap((m) => {
      const q = this.quotes.get(keyOf(m));
      return q && quoteFresh(q, now, QUOTE_TTL_MS)
        ? [{ venue: m.venue, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, fee: (this.config.settings[feeKey[m.venue]] as number) / 100, at: q.receivedAt }]
        : [];
    });
  }

  private trackVenues() {
    for (const venue of this.config.venues) {
      if (!this.tokens.has(venue)) this.tokens.set(venue, 1);
      if (!this.venueStats.has(venue)) this.venueStats.set(venue, { streamQuotes: 0, restQuotes: 0, restErrors: 0, lastStreamAt: 0, lastQuoteAt: 0 });
    }
  }

  get currentConfig() { return this.config; }

  // Applies settings from the dashboard: trading settings take effect on the next scan, coin or exchange
  // changes reload the markets, and the rest (port, browser, keep-awake) on the next start.
  updateConfig(patch: Record<string, unknown>) {
    const submitted = { ...this.config, ...patch, settings: { ...this.config.settings, ...(patch.settings as object || {}) },
      carry: { ...this.config.carry, ...(patch.carry as object || {}) } };
    const next = normalizeConfig(submitted);
    const adjusted = Object.entries(submitted.settings).filter(([key, value]) => next.settings[key as keyof typeof next.settings] !== value).map(([key]) => key);
    for (const [key, value] of Object.entries(submitted.carry)) if (next.carry[key as keyof typeof next.carry] !== value) adjusted.push(`carry ${key}`);
    for (const key of ["startingBalance", "topCoins", "conversionFee"] as const) if (submitted[key] !== next[key]) adjusted.push(key);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const marketsChanged = !same(next.venues, this.config.venues) || next.topCoins !== this.config.topCoins || next.triangular !== this.config.triangular ||
      !same(next.extraCoins, this.config.extraCoins) || !same(next.excludeCoins, this.config.excludeCoins) || next.carry.enabled !== this.config.carry.enabled;
    const onRestart = (["port", "openBrowser", "keepAwake"] as const).filter((key) => next[key] !== this.config[key]);
    this.config = next;
    this.store.saveConfig(next);
    this.trackVenues();
    if (marketsChanged) void this.refreshMarkets();
    return { config: next, adjusted, reloadingMarkets: marketsChanged, onRestart };
  }

  private async fetchJson(url: string, init?: RequestInit) {
    const response = await fetch(url, { ...init, headers: { ...probeHeaders, ...(init?.headers as object) }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  // CoinGecko requests are spaced out, and one that is throttled is retried once after a pause.
  private async coingecko(url: string) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.coingeckoAt + COINGECKO_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.coingeckoAt = Date.now();
      try { return await this.fetchJson(url); } catch (error) {
        if (attempt > 0 || !/HTTP 429/.test((error as Error).message)) throw error;
        this.coingeckoAt = Date.now() + COINGECKO_BACKOFF_MS - COINGECKO_SPACING_MS;
      }
    }
  }

  // Verifies the widest unchecked suspect gap, or else the latest unchecked paper-traded route, one at a
  // time, reusing cached token and transfer lookups.
  private async verifyNext(force?: Opportunity) {
    const generation = this.generation;
    const now = Date.now();
    if (this.verifying || (!force && now - this.lastVerifyAt < VERIFY_SPACING_MS)) return null;
    const due = (group: VerdictGroup) => (o: Opportunity) => (this.checked.get(`${group}|${o.key}`)?.until ?? 0) < now;
    let group: VerdictGroup = "suspect";
    let target = force || this.suspects.find(due("suspect"));
    if (!target) { group = "traded"; target = [...this.tradedRoutes.values()].reverse().find(due("traded")); }
    if (!target) return null;
    this.verifying = true;
    this.lastVerifyAt = now;
    try {
      const get = (url: string, init?: RequestInit) => url.startsWith("https://api.coingecko.com/") ? this.coingecko(url) : this.fetchJson(url, init);
      let verdict: Verdict, retrySoon = false;
      if (target.kind === "triangle") {
        verdict = { kind: "unverified", summary: "A loop this wide on one exchange usually means one of its markets is stale or nearly empty", checkedAt: now,
          checks: [{ level: "unknown", text: "Triangles stay on one exchange, so transfers don't apply. Check each market's recent trades on the exchange before trusting it." }] };
      } else {
        const [buy, sell] = target.legs;
        const coin = target.coin;
        let cached = this.tokenCache.get(coin);
        if (force || !cached || now - cached.at > TOKEN_TTL_MS) {
          const map = await tokenMap(coin, get).catch(() => null);
          // A failed lookup (often CoinGecko's rate limit) is retried after a few minutes, not hours.
          cached = { at: map ? now : now - TOKEN_TTL_MS + VERDICT_RETRY_MS, map };
          this.tokenCache.set(coin, cached);
        }
        retrySoon = !cached.map;
        const transfer = async (venue: Venue) => {
          const key = `${venue}|${coin}`, hit = this.transferCache.get(key);
          if (!force && hit && now - hit.at < TRANSFER_TTL_MS) return hit.status;
          const status = await transferStatus(venue, coin, get).catch(() => null);
          this.transferCache.set(key, { at: now, status });
          return status;
        };
        // How long a gap has lasted only means something for suspects, which are followed while they last.
        const age = group === "suspect" ? now - (this.suspectSeen.get(target.key)?.first ?? now) : null;
        verdict = judge({ coin, buy: { venue: buy.venue, quote: buy.quote }, sell: { venue: sell.venue, quote: sell.quote }, tokens: cached.map,
          buyTransfer: await transfer(buy.venue), sellTransfer: await transfer(sell.venue), ageMs: age, now });
      }
      if (generation !== this.generation || this.stopping) return null;
      this.verdicts.set(target.key, verdict);
      this.recordBarrier(target.key, verdict.kind);
      this.checked.set(`${group}|${target.key}`, { group, kind: verdict.kind, until: now + (retrySoon ? VERDICT_RETRY_MS : VERDICT_TTL_MS) });
      this.store.appendVerdict({ time: now, group, key: target.key, path: target.path, kind: verdict.kind, grossPct: target.grossPct });
      return verdict;
    } finally {
      this.verifying = false;
    }
  }

  // A check that finds a barrier blocks paper trades of that coin between those two exchanges, whatever the
  // gap and quote currencies; different tokens and outlier prices block both directions. A later check that
  // finds no barrier lifts it. `routeKey` is a cross route's key: cross|COIN|Venue|BASE/QUOTE>Venue|BASE/QUOTE.
  private recordBarrier(routeKey: string, kind: VerdictKind) {
    const [type, coin, rest] = [routeKey.split("|")[0], routeKey.split("|")[1], routeKey.split("|").slice(2).join("|")];
    if (type !== "cross" || !rest?.includes(">")) return;
    const [buy, sell] = rest.split(">").map((side) => side.split("|")[0] as Venue);
    const label = ({ "different-tokens": "Known barrier: different tokens", "transfers-blocked": "Known barrier: transfers closed",
      "price-anomaly": "Known barrier: price outlier" } as Partial<Record<VerdictKind, string>>)[kind];
    const barriers = this.memory.barriers!;
    if (label) {
      barriers.set(barrierKey(coin, buy, sell), label);
      if (kind !== "transfers-blocked") barriers.set(barrierKey(coin, sell, buy), label);
    } else if (kind === "no-barrier-found") barriers.delete(barrierKey(coin, buy, sell));
  }

  // Runs the check for one suspect route now, bypassing the caches.
  async verifyRoute(key: string) {
    const target = this.suspects.find((o) => o.key === key);
    if (!target) return null;
    return this.verifyNext(target);
  }

  // Times a light request to each venue over its kept-open connection. Only requests that reused an open
  // connection count, providing a public-request round-trip assumption, not order acknowledgement latency; a request that had
  // to reconnect is retried at once to reopen it.
  private probeLatency() {
    const now = Date.now();
    for (const venue of this.config.venues) {
      const probe = probes[venue];
      if (this.inFlight.has(`probe|${venue}`) || now - (this.probedAt.get(venue) || 0) < (probe.everyMs || LATENCY_PROBE_MS)) continue;
      this.probedAt.set(venue, now);
      this.inFlight.add(`probe|${venue}`);
      void this.connections.request(probe.url, probe.init)
        .then((timed) => {
          if (timed.status < 200 || timed.status >= 300) return;
          if (timed.reused) this.latency.record(venue, timed.ms);
          else { this.reconnects.set(venue, (this.reconnects.get(venue) || 0) + 1); this.probedAt.set(venue, 0); }
        })
        .catch(() => { /* A failed probe keeps the last measurement. */ })
        .finally(() => this.inFlight.delete(`probe|${venue}`));
    }
  }

  private freshQuote(key: string) {
    const quote = this.quotes.get(key);
    return quote && quoteFresh(quote, Date.now(), QUOTE_TTL_MS) ? quote : undefined;
  }

  // Models a paper trade with assumed delays: each leg is checked against its book one
  // round trip (plus decision time) after the decision, and anything left over is unwound one round trip later.
  // A leg the exchange would reject, judged from its published order rules (Coinbase and Kraken).
  private orderProblem(o: Opportunity): string | null {
    for (const leg of o.legs) {
      const problem = checkLeg(leg, this.marketByKey.get(leg.market)?.rules).problem;
      if (problem) return problem;
    }
    return null;
  }

  // Public probe latency is a simulation assumption, not a measured order acknowledgement.
  // Audit intent is durable before the replay starts; no synchronous I/O blocks a quote callback.
  private async replayShadow(id: string, trade: Opportunity, decidedAt: number, decisionMs: number, generation: number) {
    const conversionFees = Object.fromEntries(trade.venues.map(venue => [venue,
      Math.min(this.config.conversionFee, this.config.settings[feeKey[venue]] as number) / 100]));
    const delayMs = Object.fromEntries(trade.venues.map(venue => [venue, this.latency.percentile(venue, 0.95) + this.orderPrepMs]));
    await this.store.appendAudit({version: 1, event: "simulation_intent", sessionId: this.session.id, tradeId: id, time: decidedAt,
      payload: {trade, settings: this.config.settings, conversionFee: this.config.conversionFee, conversionFees, decisionMs,
        latencyModel: "public-probe-p95", delayMs, orderPrepMs:this.orderPrepMs,
        books: trade.legs.map(l => ({market:l.market, book:this.freshQuote(l.market)}))}, checkpoint: this.checkpoint()});
    const delay = (leg: Leg) => delayMs[leg.venue];
    const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));
    const fills: LegFill[] = [];
    if (trade.kind === "triangle") {
      // Each leg is funded only by the preceding simulated fills, in an isolated wallet.
      const first = trade.legs[0];
      let temporary = wallet.initialPortfolio(first.qty * first.price * (1 + first.fee), [first.venue]);
      for (const [index, planned] of trade.legs.entries()) {
        await wait(delay(planned));
        if (generation !== this.generation) return;
        const funds = wallet.available(temporary, planned.venue, planned.side === "buy" ? planned.quote : planned.base);
        const leg = normalizeLeg({...planned, qty: Math.min(planned.qty, planned.side === "buy" ? funds / (planned.price * (1 + planned.fee)) : funds)}, this.marketByKey.get(planned.market)?.rules);
        const checked = checkLeg(leg, this.marketByKey.get(leg.market)?.rules);
        const fill = checked.problem || leg.qty <= 0 ? fillLeg(planned, undefined) : fillLeg(leg, this.freshQuote(leg.market));
        if (fill.filledQty > 0) {
          const applied = wallet.applyFills(temporary, `${id}-${index}`, [fill]);
          if (!applied.ok) throw new Error(applied.reason);
          temporary = applied.state;
        }
        fills.push(fill);
      }
    } else {
      const sent = await sendInParallel(trade.legs, async leg => {
        await wait(delay(leg));
        return fillLeg(leg, generation === this.generation ? this.freshQuote(leg.market) : undefined);
      });
      fills.push(...sent.map(s => s.result ?? fillLeg(s.leg, undefined)));
    }
    if (generation !== this.generation) return;
    await wait(Math.max(...trade.legs.map(delay)));
    if (generation !== this.generation) return;
    await this.finishShadow(id, trade, fills, decidedAt, Date.now() - decidedAt, conversionFees);
  }

  private async finishShadow(id: string, trade: Opportunity, fills: LegFill[], decidedAt: number, latencyMs: number, conversionFees: Record<string, number>) {
    const primary = trade.kind === "triangle" ? wallet.settleSequence(this.portfolio, id, fills) : wallet.settle(this.portfolio, id, fills);
    if (!primary.ok) throw new Error(primary.reason);
    let next = primary.state;
    const affordableBook = (market: string, fee: number) => {
      const m = this.marketByKey.get(market), q = this.freshQuote(market);
      if (!m || !q) return undefined;
      return {...q, bidSize: Math.min(q.bidSize, wallet.available(next, m.venue, m.base)),
        askSize: Math.min(q.askSize, wallet.available(next, m.venue, m.quote) / (q.ask * (1 + fee)))};
    };
    const result = settle(trade, fills, market => affordableBook(market, trade.legs.find(l => l.market === market)?.fee ?? 0), (venue, currency) => {
      const market = `${venue}|${currency}/USD`;
      const fee = conversionFees[venue];
      const quote = affordableBook(market, fee);
      return quote ? {market, quote, fee} : undefined;
    });
    for (const [index, fill] of [...result.unwindFills, ...result.conversionFills].entries()) {
      const applied = wallet.applyFills(next, `${id}-close-${index}`, [fill]);
      if (!applied.ok) throw new Error(applied.reason);
      next = applied.state;
    }
    this.portfolio = next;
    delete this.session.pendingTrades?.[id];
    const record: ShadowRecord = {...result, id, time: decidedAt, path: trade.path, kind: trade.kind, latencyMs};
    const logged: TradeRecord = {...trade, id, time:decidedAt};
    this.session.tradeCount++;
    this.session.balance += result.realizedNet ?? 0;
    this.hour.trades++;
    this.hour.pnl += trade.net;
    addReplay(this.session.shadow, result.outcome, trade.net, result.realizedNet);
    addReplay(this.hour.shadow, result.outcome, trade.net, result.realizedNet);
    await this.store.appendAudit({version:1, event:"simulation_result", sessionId:this.session.id, tradeId:id, time:Date.now(),
      payload:{trade:logged, result:record, portfolio:next}, checkpoint:this.checkpoint()});
    await this.store.appendTrade(logged);
    await this.store.appendShadow(record);
    this.tradeLog.unshift({time:decidedAt, kind:trade.kind, path:trade.path, notional:trade.notional, grossPct:trade.grossPct, net:trade.net, netPct:trade.netPct});
    this.tradeLog.length = Math.min(50, this.tradeLog.length);
    if (result.realizedNet !== null) this.shadowErrors.unshift(result.realizedNet - trade.net);
    this.shadowErrors.length = Math.min(this.shadowErrors.length, ERROR_SAMPLE);
    this.shadowLog.unshift({time:decidedAt,kind:trade.kind,path:trade.path,expectedNet:trade.net,realizedNet:result.realizedNet,
      accountingComplete:result.accountingComplete,outcome:result.outcome,filledFraction:result.filledFraction,latencyMs,unwound:result.unwound.join("; ")});
    this.shadowLog.length = Math.min(this.shadowLog.length, 50);
    if (trade.kind === "cross") {
      this.tradedRoutes.delete(trade.key); this.tradedRoutes.set(trade.key, trade);
      if (this.tradedRoutes.size > TRADED_ROUTES_KEPT) this.tradedRoutes.delete(this.tradedRoutes.keys().next().value!);
    }
  }

  // Explicit paper inventory preparation uses existing cash/coins and observed prices, including fees.
  tradeInventory(marketKey: string, side: "buy" | "sell", quantity: number) {
    const pending = this.executeInventory(marketKey, side, quantity);
    this.activeSimulations.add(pending);
    void pending.finally(() => this.activeSimulations.delete(pending)).catch(() => {});
    return pending;
  }

  private async executeInventory(marketKey: string, side: "buy" | "sell", quantity: number) {
    if (this.resetting || this.stopping) throw new Error("Session is changing");
    if (this.auditError || this.store.writeError) throw new Error("Audit storage is unavailable");
    const market = this.marketByKey.get(marketKey), q = this.freshQuote(marketKey);
    if (!market || market.quote !== "USD" || !q || INDICATIVE.includes(market.venue)) throw new Error("A fresh direct USD market is required");
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Quantity must be positive");
    const fee = (this.config.settings[feeKey[market.venue]] as number) / 100;
    const leg = normalizeLeg({venue:market.venue,pair:`${market.base}/USD`,base:market.base,quote:"USD",side,
      price:side === "buy" ? q.ask : q.bid,market:marketKey,size:side === "buy" ? q.askSize:q.bidSize,qty:quantity,fee}, market.rules);
    const problem = checkLeg(leg, market.rules).problem;
    if (problem) throw new Error(problem);
    const consumedKey = `${marketKey}|${side}`, used = this.memory.consumed.get(consumedKey);
    if (used && used.price === leg.price && used.size === leg.size) throw new Error("Quote already used by a paper trade; wait for the displayed price or size to change");
    const id = crypto.randomUUID(), reservation = wallet.reserve(this.portfolio,id,[leg]);
    if (!reservation.ok) throw new Error(reservation.reason);
    this.memory.consumed.set(consumedKey, {price:leg.price,size:leg.size});
    this.portfolio = reservation.state;
    const generation = this.generation;
    try {
      await this.store.appendAudit({version:1,event:"inventory_intent",sessionId:this.session.id,tradeId:id,time:Date.now(),payload:{leg},checkpoint:this.checkpoint()});
      if (generation !== this.generation) throw new Error("Session changed");
      const fill = fillLeg(leg,this.freshQuote(marketKey));
      const settled = wallet.settle(this.portfolio,id,[fill]);
      if (!settled.ok) throw new Error(settled.reason);
      this.portfolio = settled.state;
      await this.store.appendAudit({version:1,event:"inventory_result",sessionId:this.session.id,tradeId:id,time:Date.now(),payload:{fill,portfolio:this.portfolio},checkpoint:this.checkpoint()});
      return {id,fill};
    } finally {
      if (this.portfolio.reservations[id]) this.portfolio = wallet.cancel(this.portfolio,id).state;
    }
  }

  private portfolioValuation() {
    let equity = 0;
    const missing: string[] = [];
    for (const [venue, assets] of Object.entries(this.portfolio.balances)) for (const [asset, amount] of Object.entries(assets)) {
      if (amount <= 0) continue;
      if (asset === "USD") { equity += amount; continue; }
      const quote = this.freshQuote(`${venue}|${asset}/USD`);
      if (!quote) { missing.push(`${venue}: ${asset} has no fresh USD mark`); continue; }
      const fee = (this.config.settings[feeKey[venue as Venue]] as number) / 100;
      equity += amount * quote.bid * (1 - fee);
    }
    return {equity:missing.length ? null : equity,pnl:missing.length ? null : equity-this.session.startingBalance,
      valuationComplete:missing.length === 0,missing,valuedAt:Date.now(),basis:"Fresh local USD bids less assumed taker fees; valuation, not liquidation fills"};
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
        latencyMs: Math.round(this.latency.get(venue)), latencyP95Ms: Math.round(this.latency.percentile(venue, 0.95)),
        latencyMeasured: this.latency.measured(venue), reconnects: this.reconnects.get(venue) || 0,
      };
    });
    const ses = this.session;
    return {
      now, startedAt: this.startedAt, ready: this.ready, running: this.running, dataDir: this.store.dir,
      session: { ...ses, pnl: ses.balance - ses.startingBalance },
      portfolio: {...this.portfolioValuation(),balances:this.portfolio.balances, available:Object.fromEntries(Object.entries(this.portfolio.balances).map(([venue,assets]) =>
        [venue,Object.fromEntries(Object.keys(assets).map(asset => [asset,wallet.available(this.portfolio,venue,asset)]))])), pending:Object.keys(this.portfolio.reservations).length,
        markets:this.markets.flatMap(m => {
          const quote = m.quote === "USD" && !INDICATIVE.includes(m.venue) ? this.freshQuote(keyOf(m)) : undefined;
          return quote ? [{key:keyOf(m),venue:m.venue,coin:m.base,ask:quote.ask,bid:quote.bid}] : [];
        })},
      auditError: this.auditError || this.store.writeError,
      settings: this.config.settings, conversionFee: this.config.conversionFee, triangular: this.config.triangular,
      coverage: { ...this.coverage, coins: this.coverage.coins.length, topCoins: this.coverage.coins.slice(0, 12) },
      rates: this.rates, feeds,
      routes: this.top.slice(0, 15).map((o) => ({ ...o, reason: this.reasons.get(o.key) ?? null })),
      suspectRoutes: this.suspects.map((o) => ({ ...o, since: this.suspectSeen.get(o.key)?.first ?? now, verdict: this.verdicts.get(o.key) ?? null })),
      currentHour: this.hourRow(), trades: this.tradeLog, hours: this.hours, carry: this.carry.snapshot(now),
      orderPrepMs: this.orderPrepMs,
      reaction: (() => {
        const sorted = [...this.reactionMs].sort((a, b) => a - b);
        return { samples: sorted.length, medianMs: sorted[sorted.length >> 1] ?? null, p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null, eventTrades: this.eventTrades };
      })(),
      shadow: {
        since: ses.shadowSince, balance: ses.shadow.unresolved ? null : ses.startingBalance + ses.shadow.realized,
        pnl: ses.shadow.unresolved ? null : ses.shadow.realized, settledPnl:ses.shadow.realized, unresolved:ses.shadow.unresolved,
        execution:"simulated",
        filled: ses.shadow.filled, partial: ses.shadow.partial, missed: ses.shadow.missed, recent: this.shadowLog,
      },
      accuracy: {
        ...accuracy(ses.shadow), errorBins: histogram(this.shadowErrors), errorSample: this.shadowErrors.length,
        verdicts: verdictSummary(this.checked.values()),
        tradedRoutes: this.tradedRoutes.size,
        barriers: [...this.memory.barriers!].map(([key, reason]) => {
          const [coin, venues] = key.split("|");
          const [buy, sell] = venues.split(">");
          return { coin, buy, sell, reason: reason.replace(/^Known barrier: /, "") };
        }).sort((a, b) => a.coin.localeCompare(b.coin) || a.buy.localeCompare(b.buy)),
        tradedPending: [...this.tradedRoutes.keys()].filter((key) => !this.checked.has(`traded|${key}`)).length,
      },
    };
  }

  private checkpoint(): SessionFile {
    // Historical IDs and fill evidence live in audit.jsonl. Keep a small replay window here;
    // parent settlement still requires a live reservation, so evicted IDs cannot be settled again.
    const completed = Object.entries(this.portfolio.completed);
    if (completed.length > 128) this.portfolio = {...this.portfolio,completed:Object.fromEntries(completed.slice(-128))};
    return {...this.session,portfolio:this.portfolio,hour:{...this.hour,suspectKeys:[...this.hour.suspectKeys]}};
  }

  private saveSession() {
    return this.store.saveSession(this.checkpoint());
  }

  private emptyHour() {
    const start = new Date(); start.setMinutes(0, 0, 0);
    return {
      start: start.getTime(), scans: 0, trades: 0, pnl: 0, quotes: 0, scanMs: 0, scanCount: 0,
      bestNetPct: null as number | null, bestTriangleNetPct: null as number | null, bestGrossPct: null as number | null, suspectKeys: new Set<string>(),
      shadow: emptyTally(),
    };
  }

  private hourRow(): HourlyRow {
    const h = this.hour;
    return {
      hour: new Date(h.start).toISOString(), scans: h.scans, trades: h.trades, pnl: h.pnl, quotes: h.quotes,
      bestNetPct: h.bestNetPct, bestTriangleNetPct: h.bestTriangleNetPct, bestGrossPct: h.bestGrossPct,
      suspectRoutes: h.suspectKeys.size, avgScanMs: h.scanCount ? h.scanMs / h.scanCount : 0, shadow: { ...h.shadow },
    };
  }

  // Write one summary line per clock hour so a day away can be reviewed at a glance.
  private rollHour() {
    const current = new Date(); current.setMinutes(0, 0, 0);
    if (current.getTime() === this.hour.start) return;
    const row = this.hourRow();
    const generation = this.generation;
    void this.store.appendHourly(row).then(() => {
      if (generation === this.generation) this.hours = this.store.readRecentHours(48);
    }).catch(error => {this.auditError = String(error); this.running = false;});
    const pct = (n: number | null) => n === null ? "—" : `${n.toFixed(2)}%`;
    console.log(`${new Date().toLocaleTimeString()}  HOUR ${new Date(this.hour.start).toLocaleTimeString([], { hour: "numeric" })}  trades ${row.trades}  paper pnl $${row.pnl.toFixed(2)}  settled simulated subtotal $${row.shadow.realized.toFixed(2)} (unresolved ${row.shadow.unresolved})  best cross ${pct(row.bestNetPct)}  best triangle ${pct(row.bestTriangleNetPct)}  suspect ${row.suspectRoutes}`);
    this.hour = this.emptyHour();
  }
}

// Builds and signs sample orders with throwaway keys (never real credentials) to time what preparing an order
// costs on this PC: the median of Kraken's HMAC signature and Coinbase's ES256 JWT, each with its payload.
function measureOrderPrep(): number {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
  const secret = crypto.randomBytes(64).toString("base64");
  const leg = { venue: "Kraken" as Venue, pair: "BTC/USD", base: "BTC", quote: "USD", side: "buy" as const, price: 84000, market: "", size: 1, qty: 0.0006, fee: 0 };
  const market = { venue: "Kraken" as Venue, base: "BTC", quote: "USD", rest: "BTC-USD", ws: "BTC/USD", rules: { lot: 1e-8, tick: 0.01, minQty: 0, minNotional: 0 } };
  const samples: number[] = [];
  for (let i = 0; i < 50; i++) {
    const started = performance.now();
    const kraken = JSON.stringify(krakenAddOrder(leg, market, { token: "sample", reqId: i }));
    krakenSignature("/0/private/AddOrder", String(i), kraken, secret);
    const coinbase = coinbaseCreateOrder(leg, market, `sample-${i}`);
    coinbaseJwt({ keyName: "sample", privateKeyPem: pem, method: coinbase.method, host: coinbase.host, path: coinbase.path });
    JSON.stringify(coinbase.body);
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[25];
}
