import { accuracy, addReplay, emptyTally, histogram, verdictKinds, verdictSummary, type VerdictGroup } from "../lib/accuracy";
import { discover, selectMarkets, type Listing } from "../lib/discovery";
import { batchVenues, fetchBatchBooks, fetchMarketBook } from "../lib/exchanges";
import { supportedPair, symbols, type Quote, type Venue } from "../lib/market";
import { keyOf, usdMarket, type Market } from "../lib/markets";
import { blockReason, chooseTrade, scanOpportunities, type Opportunity, type Rate, type TradeMemory } from "../lib/opportunities";
import { fillLeg, LatencyTracker, settle, type LegFill } from "../lib/shadow";
import { connectStreams } from "../lib/streams";
import { judge, tokenMap, transferStatus, type TokenMap, type Transfer, type Verdict, type VerdictKind } from "../lib/verify";
import { normalizeConfig, Store, type EngineConfig, type HourlyRow, type SessionFile, type ShadowRecord, type TradeRecord } from "./store";

// A quote counts as streamed while its feed has updated within this window; otherwise REST fills in.
const STREAM_FRESH_MS = 4_500;
const REST_REFRESH_MS = 6_000;
const REST_BACKOFF_MS = 30_000;
const BATCH_INTERVAL_MS = 3_000;
const ROUTE_COOLDOWN_MS = 60_000;
const SCAN_SPACING_MS = 500;
const REDISCOVER_MS = 12 * 60 * 60 * 1000;
const QUOTE_TTL_MS = 12_000;
// Shadow mode: time from seeing a quote to sending orders, and how often to re-measure each venue's round trip.
const DECISION_MS = 30;
const LATENCY_PROBE_MS = 30_000;
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
const probes: Record<Venue, { url: string; init?: RequestInit; everyMs?: number }> = {
  Coinbase: { url: "https://api.exchange.coinbase.com/time" },
  Kraken: { url: "https://api.kraken.com/0/public/Time" },
  Gemini: { url: "https://api.gemini.com/v2/ticker/btcusd" },
  Bitstamp: { url: "https://www.bitstamp.net/api/v2/ticker/btcusd/" },
  // CEX.IO counts every request against ~100 a minute, so it is timed less often.
  "CEX.IO": { url: "https://trade.cex.io/api/spot/rest-public/get_server_time", init: { method: "POST", body: "{}", headers: { ...probeHeaders, "Content-Type": "application/json" } }, everyMs: 60_000 },
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
type LoggedShadow = { time: number; kind: string; path: string; expectedNet: number; realizedNet: number; outcome: string; filledFraction: number; latencyMs: number; unwound: string };
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
  private readonly quotes = new Map<string, Quote>();
  private readonly streamedAt = new Map<string, number>();
  private readonly unavailableUntil = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly tokens = new Map<Venue, number>();
  private readonly lastBatchAt = new Map<Venue, number>();
  private readonly venueStats = new Map<Venue, VenueStats>();
  private readonly memory: TradeMemory = { recent: new Map(), consumed: new Map() };
  private readonly tradeLog: LoggedTrade[];
  private readonly shadowLog: LoggedShadow[];
  private readonly shadowErrors: number[];
  private readonly latency = new LatencyTracker(300, 15);
  private readonly probedAt = new Map<Venue, number>();
  private readonly warmed = new Set<Venue>();
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
    const shadowRows = store.readRecentShadow(ERROR_SAMPLE);
    this.shadowLog = shadowRows.slice(0, 50).map((row) => ({
      time: Date.parse(row.time), kind: row.kind, path: row.path, expectedNet: Number(row.expected_net_usd), realizedNet: Number(row.realized_net_usd),
      outcome: row.outcome, filledFraction: Number(row.filled_fraction), latencyMs: Number(row.latency_ms), unwound: row.unwound || "",
    }));
    this.shadowErrors = shadowRows.map((row) => Number(row.realized_net_usd) - Number(row.expected_net_usd)).filter(Number.isFinite);
    // Newest first, so the first row seen for a route is its latest verdict. Saved verdicts count toward the
    // accuracy figures; routes still around are checked again so their details can be shown.
    for (const row of store.readRecentVerdicts(5000)) {
      const id = `${row.group}|${row.route_key}`, kind = row.kind as VerdictKind;
      if (this.checked.has(id) || (row.group !== "suspect" && row.group !== "traded") || !verdictKinds.includes(kind)) continue;
      this.checked.set(id, { group: row.group, kind, until: 0 });
    }
    this.trackVenues();
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
    this.timers.push(setInterval(() => this.probeLatency(), 5_000));
    this.timers.push(setInterval(() => void this.verifyNext(), 5_000));
    this.probeLatency();
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
    this.session = Store.freshSession(this.config.startingBalance);
    this.shadowLog.length = 0;
    this.shadowErrors.length = 0;
    this.verdicts.clear();
    this.checked.clear();
    this.tradedRoutes.clear();
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
        maxPerVenue: MAX_BOOKS_PER_VENUE,
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
    for (const o of result.suspects) {
      this.hour.suspectKeys.add(o.key);
      const seen = this.suspectSeen.get(o.key);
      this.suspectSeen.set(o.key, { first: seen?.first ?? now, last: now });
    }
    for (const [key, seen] of this.suspectSeen) if (now - seen.last > SUSPECT_FORGET_MS) this.suspectSeen.delete(key);
    const rules = { minNet: settings.minNet, now, cooldownMs: ROUTE_COOLDOWN_MS };
    const explain = (traded: Opportunity | null) => {
      this.reasons = new Map(result.top.map((o) => [o.key,
        o === traded ? "Paper-traded" :
        o.venues.some((venue) => INDICATIVE.includes(venue)) ? "Indicative prices only (Crypto.com)" :
        !this.running ? "Bot paused" :
        blockReason(o, this.memory, rules) ?? "Next in line (one trade per scan)"]));
    };
    if (!this.running) { explain(null); return; }
    this.session.scans++;
    this.hour.scans++;
    const chosen = chooseTrade(tradable, this.memory, rules);
    explain(chosen);
    if (!chosen) return;
    const trade: TradeRecord = { ...chosen, time: now };
    this.session.balance += trade.net;
    this.session.tradeCount++;
    this.hour.trades++;
    this.hour.pnl += trade.net;
    this.tradeLog.unshift({ time: now, kind: trade.kind, path: trade.path, notional: trade.notional, grossPct: trade.grossPct, net: trade.net, netPct: trade.netPct });
    this.tradeLog.length = Math.min(this.tradeLog.length, 50);
    this.store.appendTrade(trade);
    this.replayShadow(chosen, now);
    if (chosen.kind === "cross") {
      this.tradedRoutes.delete(chosen.key);
      this.tradedRoutes.set(chosen.key, chosen);
      if (this.tradedRoutes.size > TRADED_ROUTES_KEPT) this.tradedRoutes.delete(this.tradedRoutes.keys().next().value!);
    }
    console.log(`${new Date(now).toLocaleTimeString()}  PAPER TRADE  ${trade.path}  net ${trade.net >= 0 ? "+" : ""}$${trade.net.toFixed(2)} (${trade.netPct.toFixed(2)}%)  balance $${this.session.balance.toFixed(2)}`);
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
    const submitted = { ...this.config, ...patch, settings: { ...this.config.settings, ...(patch.settings as object || {}) } };
    const next = normalizeConfig(submitted);
    const adjusted = Object.entries(submitted.settings).filter(([key, value]) => next.settings[key as keyof typeof next.settings] !== value).map(([key]) => key);
    for (const key of ["startingBalance", "topCoins", "conversionFee"] as const) if (submitted[key] !== next[key]) adjusted.push(key);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const marketsChanged = !same(next.venues, this.config.venues) || next.topCoins !== this.config.topCoins || next.triangular !== this.config.triangular ||
      !same(next.extraCoins, this.config.extraCoins) || !same(next.excludeCoins, this.config.excludeCoins);
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
      this.verdicts.set(target.key, verdict);
      this.checked.set(`${group}|${target.key}`, { group, kind: verdict.kind, until: now + (retrySoon ? VERDICT_RETRY_MS : VERDICT_TTL_MS) });
      this.store.appendVerdict({ time: now, group, key: target.key, path: target.path, kind: verdict.kind, grossPct: target.grossPct });
      return verdict;
    } finally {
      this.verifying = false;
    }
  }

  // Runs the check for one suspect route now, bypassing the caches.
  async verifyRoute(key: string) {
    const target = this.suspects.find((o) => o.key === key);
    if (!target) return null;
    return this.verifyNext(target);
  }

  // Times a light request to each venue on a schedule; the first request per venue only opens the
  // connection, so it is not counted.
  private probeLatency() {
    const now = Date.now();
    for (const venue of this.config.venues) {
      const probe = probes[venue];
      if (this.inFlight.has(`probe|${venue}`) || now - (this.probedAt.get(venue) || 0) < (probe.everyMs || LATENCY_PROBE_MS)) continue;
      this.probedAt.set(venue, now);
      this.inFlight.add(`probe|${venue}`);
      const started = performance.now();
      void fetch(probe.url, { headers: probeHeaders, cache: "no-store", signal: AbortSignal.timeout(5000), ...probe.init })
        .then(async (response) => {
          await response.text();
          if (!response.ok) return;
          if (this.warmed.has(venue)) this.latency.record(venue, performance.now() - started);
          else { this.warmed.add(venue); this.probedAt.set(venue, 0); }
        })
        .catch(() => { /* A failed probe keeps the last measurement. */ })
        .finally(() => this.inFlight.delete(`probe|${venue}`));
    }
  }

  private freshQuote(key: string) {
    const quote = this.quotes.get(key);
    return quote && Date.now() - quote.receivedAt <= QUOTE_TTL_MS ? quote : undefined;
  }

  // Replays a paper trade as the real orders would have landed: each leg is checked against its book one
  // round trip (plus decision time) after the decision, and anything left over is unwound one round trip later.
  private replayShadow(trade: Opportunity, decidedAt: number) {
    const fills: LegFill[] = new Array(trade.legs.length);
    const delays = trade.legs.map((leg) => this.latency.get(leg.venue) + DECISION_MS);
    let pending = trade.legs.length;
    trade.legs.forEach((leg, index) => {
      setTimeout(() => {
        fills[index] = fillLeg(leg, this.freshQuote(leg.market));
        if (--pending) return;
        setTimeout(() => this.finishShadow(trade, fills, decidedAt, Math.max(...delays)), Math.max(...trade.legs.map((l) => this.latency.get(l.venue))));
      }, delays[index]);
    });
  }

  private finishShadow(trade: Opportunity, fills: LegFill[], decidedAt: number, latencyMs: number) {
    const fee = this.config.conversionFee / 100;
    const dollar = (currency: string, amount: number) => {
      if (currency === "USD") return 1;
      const mid = this.rates[currency]?.mid ?? 1;
      return amount >= 0 ? mid * (1 - fee) : mid * (1 + fee);
    };
    const result = settle(trade, fills, (key) => this.freshQuote(key), dollar);
    const record: ShadowRecord = { ...result, time: decidedAt, path: trade.path, kind: trade.kind, latencyMs };
    this.store.appendShadow(record);
    addReplay(this.session.shadow, result.outcome, trade.net, result.realizedNet);
    addReplay(this.hour.shadow, result.outcome, trade.net, result.realizedNet);
    this.shadowErrors.unshift(result.realizedNet - trade.net);
    this.shadowErrors.length = Math.min(this.shadowErrors.length, ERROR_SAMPLE);
    this.shadowLog.unshift({ time: decidedAt, kind: trade.kind, path: trade.path, expectedNet: trade.net, realizedNet: result.realizedNet,
      outcome: result.outcome, filledFraction: result.filledFraction, latencyMs, unwound: result.unwound.join("; ") });
    this.shadowLog.length = Math.min(this.shadowLog.length, 50);
    const sign = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
    console.log(`${new Date().toLocaleTimeString()}  SHADOW       ${trade.path}  ${result.outcome.toUpperCase()}  paper ${sign(trade.net)} -> realistic ${sign(result.realizedNet)}${result.unwound.length ? `  (${result.unwound.join("; ")})` : ""}`);
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
        latencyMs: Math.round(this.latency.get(venue)), latencyMeasured: this.latency.measured(venue),
      };
    });
    const ses = this.session;
    return {
      now, startedAt: this.startedAt, ready: this.ready, running: this.running, dataDir: this.store.dir,
      session: { ...ses, pnl: ses.balance - ses.startingBalance },
      settings: this.config.settings, conversionFee: this.config.conversionFee, triangular: this.config.triangular,
      coverage: { ...this.coverage, coins: this.coverage.coins.length, topCoins: this.coverage.coins.slice(0, 12) },
      rates: this.rates, feeds,
      routes: this.top.slice(0, 15).map((o) => ({ ...o, reason: this.reasons.get(o.key) ?? null })),
      suspectRoutes: this.suspects.map((o) => ({ ...o, since: this.suspectSeen.get(o.key)?.first ?? now, verdict: this.verdicts.get(o.key) ?? null })),
      currentHour: this.hourRow(), trades: this.tradeLog, hours: this.store.readRecentHours(48),
      shadow: {
        since: ses.shadowSince, balance: ses.startingBalance + ses.shadow.realized, pnl: ses.shadow.realized,
        filled: ses.shadow.filled, partial: ses.shadow.partial, missed: ses.shadow.missed, recent: this.shadowLog,
      },
      accuracy: {
        ...accuracy(ses.shadow), errorBins: histogram(this.shadowErrors), errorSample: this.shadowErrors.length,
        verdicts: verdictSummary(this.checked.values()),
        tradedRoutes: this.tradedRoutes.size,
        tradedPending: [...this.tradedRoutes.keys()].filter((key) => !this.checked.has(`traded|${key}`)).length,
      },
    };
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
    this.store.appendHourly(row);
    const pct = (n: number | null) => n === null ? "—" : `${n.toFixed(2)}%`;
    console.log(`${new Date().toLocaleTimeString()}  HOUR ${new Date(this.hour.start).toLocaleTimeString([], { hour: "numeric" })}  trades ${row.trades}  paper pnl $${row.pnl.toFixed(2)}  realistic pnl $${row.shadow.realized.toFixed(2)}  best cross ${pct(row.bestNetPct)}  best triangle ${pct(row.bestTriangleNetPct)}  suspect ${row.suspectRoutes}`);
    this.hour = this.emptyHour();
  }
}
