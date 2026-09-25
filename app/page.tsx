"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Activity, ArrowRight, ArrowUpRight, Pause, Play, RefreshCw, RotateCcw } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  defaultUniverse, defaults, emptyMarkets, feeKey, money, newSession, pct, price, routesFor, settingRange, signedMoney, supportedPair, symbols, venues,
  type PublicFeesResponse, type Quote, type Session, type Settings, type Snapshot, type SymbolName, type Universe, type Venue,
} from "@/lib/market";
import { connectMarketStreams } from "@/lib/streams";
import { feeScheduleLinks, publicFeeSources } from "@/lib/public-fees";

function loadSettings(manualFees: Venue[]): Settings {
  try {
    const current = localStorage.getItem("arbiter-settings-v2");
    const saved = JSON.parse(current || localStorage.getItem("arbiter-settings-v1") || "null");
    if (!saved) return defaults;
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
      // Only manual overrides keep a saved fee, so corrected default estimates reach returning visitors.
      const venue = venues.find((item) => feeKey[item] === key);
      if (venue && !manualFees.includes(venue)) return [key, value];
      const n = Number(saved[key]);
      const [min, max] = settingRange(key as keyof Settings);
      return [key, Number.isFinite(n) && n >= min && n <= max ? n : value];
    })) as Settings;
  } catch { return defaults; }
}
function parseSetting(key: keyof Settings, raw: string): number | null {
  const value = Number(raw);
  const [min, max] = settingRange(key);
  return raw.trim() !== "" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}
function loadFeeOverrides(): Venue[] {
  try {
    const saved = localStorage.getItem("arbiter-fee-overrides-v1");
    if (saved) { const list = JSON.parse(saved); return Array.isArray(list) ? venues.filter((venue) => list.includes(venue)) : []; }
    const legacy = JSON.parse(localStorage.getItem("arbiter-settings-v1") || "null");
    if (!legacy) return [];
    return venues.filter((venue) => {
      const key = feeKey[venue];
      const oldBaseline = venue === "Kraken" ? 0.4 : venue === "bitFlyer" ? 0.5 : defaults[key];
      return Number.isFinite(Number(legacy[key])) && Math.abs(Number(legacy[key]) - oldBaseline) > 0.00001;
    });
  } catch { return []; }
}
function loadSession(): Session {
  try {
    const saved = JSON.parse(localStorage.getItem("arbiter-session-v1") || "null");
    if (!saved || !Number.isFinite(saved.balance) || !Array.isArray(saved.trades)) return newSession;
    return { balance: saved.balance, scans: Number.isFinite(saved.scans) ? saved.scans : 0, tradeCount: Number.isFinite(saved.tradeCount) ? saved.tradeCount : saved.trades.length, trades: saved.trades.slice(0, 100) };
  } catch { return newSession; }
}
function loadUniverse(): Universe {
  try {
    const current = localStorage.getItem("arbiter-universe-v5");
    const v4 = localStorage.getItem("arbiter-universe-v4");
    const saved = JSON.parse(current || v4 || localStorage.getItem("arbiter-universe-v3") || "null");
    if (!saved || !Array.isArray(saved.assets) || !Array.isArray(saved.venues)) return defaultUniverse;
    const assets = symbols.filter((asset) => saved.assets.includes(asset) || (!current && !v4 && defaultUniverse.assets.includes(asset) && !symbols.slice(0, 12).includes(asset)));
    const selectedVenues = venues.filter((venue) => saved.venues.includes(venue) || (!current && venue === "CEX.IO") || (!current && !v4 && (venue === "bitFlyer" || venue === "OKX US")));
    return assets.length && selectedVenues.length >= 2 ? { assets, venues: selectedVenues } : defaultUniverse;
  } catch { return defaultUniverse; }
}

export default function Home() {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [universe, setUniverse] = useState<Universe>(defaultUniverse);
  const [session, setSession] = useState<Session>(newSession);
  const [hydrated, setHydrated] = useState(false);
  const [running, setRunning] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  const [clock, setClock] = useState(0);
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  const [feeSnapshot, setFeeSnapshot] = useState<PublicFeesResponse | null>(null);
  const [feeError, setFeeError] = useState("");
  const [feeLoading, setFeeLoading] = useState(false);
  const [manualFees, setManualFees] = useState<Venue[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<keyof Settings, string>>>({});
  const inFlight = useRef(false);
  const runningRef = useRef(false);
  const settingsRef = useRef(settings);
  const universeRef = useRef(universe);
  const availableRef = useRef(false);
  const restRef = useRef<Snapshot | null>(null);
  const streamRef = useRef<Partial<Record<SymbolName, Partial<Record<Venue, Quote>>>>>({});
  const snapshotRef = useRef<Snapshot | null>(null);
  const generationRef = useRef(0);
  const pollCursorRef = useRef(0);
  const unavailableRef = useRef(new Map<string, number>());
  const lastScanRef = useRef(0);
  const scanTimerRef = useRef<number | undefined>(undefined);

  const appliedSettings = useMemo(() => {
    const next = { ...settings };
    for (const venue of venues) {
      const rate = feeSnapshot?.rates[venue]?.rate;
      if (!manualFees.includes(venue) && rate !== undefined && Number.isFinite(rate) && rate >= 0 && rate <= 2)
        next[feeKey[venue]] = rate;
    }
    return next;
  }, [settings, feeSnapshot, manualFees]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is read after hydration so server and client markup match.
  useEffect(() => { const manual = loadFeeOverrides(); setSettings(loadSettings(manual)); setUniverse(loadUniverse()); setSession(loadSession()); setManualFees(manual); setHydrated(true); }, []);
  useEffect(() => { if (hydrated) localStorage.setItem("arbiter-settings-v2", JSON.stringify(settings)); }, [settings, hydrated]);
  useEffect(() => { if (hydrated) localStorage.setItem("arbiter-universe-v5", JSON.stringify(universe)); }, [universe, hydrated]);
  useEffect(() => { if (hydrated) localStorage.setItem("arbiter-session-v1", JSON.stringify(session)); }, [session, hydrated]);
  useEffect(() => { if (hydrated) localStorage.setItem("arbiter-fee-overrides-v1", JSON.stringify(manualFees)); }, [manualFees, hydrated]);
  useEffect(() => { settingsRef.current = appliedSettings; }, [appliedSettings]);
  useEffect(() => { universeRef.current = universe; }, [universe]);
  useEffect(() => { runningRef.current = running; }, [running]);

  const refreshFees = useCallback(async (force = false) => {
    setFeeLoading(true);
    try {
      const response = await fetch(force ? "/api/fees?force=1" : "/api/fees", { cache: "no-store" });
      if (!response.ok) throw new Error("Fee schedule request failed");
      setFeeSnapshot(await response.json() as PublicFeesResponse);
      setFeeError("");
    } catch { setFeeError("Public fee schedules are unavailable. Editable estimates remain in use."); }
    finally { setFeeLoading(false); }
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch; refreshFees only flags loading before it awaits.
    void refreshFees();
    const timer = window.setInterval(() => { if (!document.hidden) void refreshFees(); }, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [hydrated, refreshFees]);

  const scanMarket = useCallback(() => {
    if (!runningRef.current || document.hidden || !snapshotRef.current) return;
    lastScanRef.current = Date.now();
    setSession((previous) => {
      const now = Date.now();
      const candidates = routesFor(snapshotRef.current, settingsRef.current, previous.balance, universeRef.current, now);
      const chosen = candidates.find((candidate) => !candidate.indicative && candidate.net > 0 && candidate.net >= settingsRef.current.minNet &&
        !previous.trades.some((trade) => trade.key === candidate.key && now - trade.time < 60000));
      return { balance: previous.balance + (chosen?.net || 0), scans: previous.scans + 1,
        tradeCount: previous.tradeCount + (chosen ? 1 : 0),
        trades: chosen ? [{ ...chosen, id: `${now}-${chosen.key}`, time: now }, ...previous.trades].slice(0, 100) : previous.trades };
    });
  }, []);

  const publishSnapshot = useCallback((newQuotes = false) => {
    const markets = emptyMarkets();
    const now = Date.now();
    for (const asset of universe.assets) for (const venue of universe.venues) {
      const polled = restRef.current?.markets[asset]?.[venue];
      const streamed = streamRef.current[asset]?.[venue];
      const quote = streamed && streamed.receivedAt > (polled?.receivedAt || 0) ? streamed : polled;
      if (quote && now - quote.receivedAt <= 12000) markets[asset][venue] = quote;
    }
    const combined: Snapshot = { generatedAt: now, markets, errors: restRef.current?.errors || [] };
    snapshotRef.current = combined;
    setSnapshot(combined);
    if (newQuotes && runningRef.current && !document.hidden && scanTimerRef.current === undefined) {
      const delay = Math.max(0, 250 - (now - lastScanRef.current));
      scanTimerRef.current = window.setTimeout(() => { scanTimerRef.current = undefined; scanMarket(); }, delay);
    }
  }, [universe, scanMarket]);

  const refresh = useCallback(async (force = false) => {
    if (inFlight.current) return;
    const now = Date.now();
    const candidates = universe.assets.flatMap((asset) => universe.venues.filter((venue) => supportedPair(asset, venue))
      .map((venue) => ({ asset, venue, key: `${asset}:${venue}` })))
      .filter(({ asset, venue, key }) => force || (
        now - (streamRef.current[asset]?.[venue]?.receivedAt || 0) > 4500 &&
        now - (restRef.current?.markets[asset]?.[venue]?.receivedAt || 0) > 6000 &&
        (unavailableRef.current.get(key) || 0) < now));
    if (!candidates.length) { setLoading(false); return; }
    const start = pollCursorRef.current % candidates.length;
    let cexRequests = 0;
    const requested = [...candidates.slice(start), ...candidates.slice(0, start)]
      .filter(({ venue }) => venue !== "CEX.IO" || ++cexRequests <= 4).slice(0, 36);
    pollCursorRef.current += requested.length;
    inFlight.current = true;
    const generation = generationRef.current;
    try {
      const params = new URLSearchParams({ assets: universe.assets.join(","), venues: universe.venues.join(","), pairs: requested.map(({ key }) => key).join(",") });
      const response = await fetch(`/api/market?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Market request failed (${response.status})`);
      const data = (await response.json()) as Snapshot;
      if (generation !== generationRef.current) return;
      // Polled quotes carry the server's clock; shift them onto this device's clock so
      // age checks and comparisons with streamed quotes hold when the two clocks differ.
      const clockOffset = Number.isFinite(data.generatedAt) ? Date.now() - data.generatedAt : 0;
      const merged = { ...(restRef.current?.markets || emptyMarkets()) };
      for (const asset of universe.assets) for (const venue of universe.venues) {
        const quote = data.markets[asset]?.[venue];
        if (quote) merged[asset] = { ...merged[asset], [venue]: { ...quote, receivedAt: quote.receivedAt + clockOffset } };
      }
      restRef.current = { ...data, markets: merged };
      for (const key of data.failedPairs || []) unavailableRef.current.set(key, Date.now() + 30000);
      publishSnapshot(true);
      setLastCheck(Date.now());
      setFetchError("");
    } catch (error) {
      if (generation !== generationRef.current) return;
      publishSnapshot();
      setFetchError(error instanceof Error ? error.message : "Market feeds are unavailable");
      setLastCheck(Date.now());
    } finally { if (generation === generationRef.current) { inFlight.current = false; setLoading(false); } }
  }, [universe, publishSnapshot]);

  useEffect(() => {
    if (!hydrated) return;
    generationRef.current++;
    inFlight.current = false;
    restRef.current = null;
    streamRef.current = {};
    unavailableRef.current.clear();
    pollCursorRef.current = 0;
    if (scanTimerRef.current !== undefined) window.clearTimeout(scanTimerRef.current);
    scanTimerRef.current = undefined;
    snapshotRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale quotes when the scanned universe changes.
    setSnapshot(null);
    setLoading(true);
    let updateTimer: number | undefined;
    const feedGeneration = generationRef.current;
    const stopStreams = connectMarketStreams(universe, (asset, venue, quote) => {
      if (feedGeneration !== generationRef.current) return;
      streamRef.current[asset] = { ...streamRef.current[asset], [venue]: quote };
      if (!updateTimer) updateTimer = window.setTimeout(() => { updateTimer = undefined; publishSnapshot(true); setLastCheck(Date.now()); }, 75);
    }, (asset, venue) => {
      if (feedGeneration !== generationRef.current) return;
      delete streamRef.current[asset]?.[venue];
      publishSnapshot();
    });
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    const resumed = () => { if (!document.hidden) { publishSnapshot(); void refresh(); } };
    document.addEventListener("visibilitychange", resumed);
    return () => { generationRef.current++; window.clearInterval(timer); if (updateTimer) window.clearTimeout(updateTimer); if (scanTimerRef.current !== undefined) window.clearTimeout(scanTimerRef.current); scanTimerRef.current = undefined; stopStreams(); document.removeEventListener("visibilitychange", resumed); };
  }, [refresh, universe, publishSnapshot, hydrated]);

  useEffect(() => { const timer = window.setInterval(() => { setClock((value) => value + 1); publishSnapshot(); }, 1000); return () => window.clearInterval(timer); }, [publishSnapshot]);
  useEffect(() => { if (running) scanMarket(); }, [running, scanMarket]);

  const routes = useMemo(() => routesFor(snapshot, appliedSettings, session.balance, universe), [snapshot, appliedSettings, session.balance, universe, clock]);
  const visibleRoutes = showAllRoutes ? routes : universe.venues.includes("Crypto.com")
    ? [...routes.filter((route) => !route.indicative).slice(0, 12), ...routes.filter((route) => route.indicative).slice(0, 4)]
    : routes.slice(0, 16);
  const best = routes.find((route) => !route.indicative);
  const pnl = session.balance - 500;
  const available = !!best;
  useEffect(() => { availableRef.current = available; }, [available]);
  const quoteCount = universe.assets.reduce((count, asset) => count + universe.venues.filter((venue) => !!snapshot?.markets[asset]?.[venue]).length, 0);
  const streamCount = universe.assets.reduce((count, asset) => count + universe.venues.filter((venue) => snapshot?.markets[asset]?.[venue]?.source === "stream").length, 0);
  const totalQuotes = universe.assets.reduce((count, asset) => count + universe.venues.filter((venue) => supportedPair(asset, venue)).length, 0);
  const routeCapacity = universe.assets.reduce((count, asset) => { const n = universe.venues.filter((venue) => supportedPair(asset, venue)).length; return count + n * (n - 1); }, 0);
  const allFeeds = quoteCount > 0 && quoteCount === totalQuotes;
  const dataState = quoteCount ? `${quoteCount}/${totalQuotes} quotes · ${streamCount} streaming` : fetchError || snapshot?.errors.length ? "Feeds unavailable" : "Connecting to exchanges";
  const toggleAsset = (asset: SymbolName) => setUniverse((previous) => {
    const next = previous.assets.includes(asset) ? previous.assets.filter((item) => item !== asset) : symbols.filter((item) => item === asset || previous.assets.includes(item));
    return next.length ? { ...previous, assets: next } : previous;
  });
  const toggleVenue = (venue: Venue) => setUniverse((previous) => {
    const next = previous.venues.includes(venue) ? previous.venues.filter((item) => item !== venue) : venues.filter((item) => item === venue || previous.venues.includes(item));
    return next.length >= 2 ? { ...previous, venues: next } : previous;
  });
  const updateSetting = (key: keyof Settings, raw: string) => {
    // Keep the typed text so a field can be cleared or pass through an out-of-range value mid-edit.
    setDrafts((prev) => ({ ...prev, [key]: raw }));
    const value = parseSetting(key, raw);
    if (value === null) return;
    setSettings((prev) => ({ ...prev, [key]: value }));
    const venue = venues.find((item) => feeKey[item] === key);
    if (venue) setManualFees((prev) => prev.includes(venue) ? prev : [...prev, venue]);
  };
  const endEdit = (key: keyof Settings) => setDrafts((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const fieldProps = (key: keyof Settings, value: number) => ({
    value: drafts[key] ?? value,
    onChange: (e: ChangeEvent<HTMLInputElement>) => updateSetting(key, e.target.value),
    onBlur: () => endEdit(key),
    "aria-invalid": drafts[key] !== undefined && parseSetting(key, drafts[key]) === null ? true : undefined,
  });

  useEffect(() => {
    if (!hydrated) return;
    type Tool = { name: string; title: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => unknown };
    const modelContext = (document as Document & { modelContext?: { registerTool: (tool: Tool, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!modelContext?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: Tool) => {
      try { void Promise.resolve(modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); }
      catch { /* Browser does not support this optional API. */ }
    };
    register({
      name: "configure_paper_bot", title: "Configure paper bot",
      description: "Set the visible per-trade budget and minimum estimated net profit in this device's paper session.",
      inputSchema: { type: "object", properties: { budget: { type: "number", minimum: 5, maximum: 100000 }, minNet: { type: "number", minimum: 0, maximum: 10000 } }, minProperties: 1, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected settings object");
        const data = input as Record<string, unknown>;
        if (!Object.keys(data).length || Object.keys(data).some((key) => !["budget", "minNet"].includes(key))) throw new Error("Provide budget or minNet");
        if (data.budget !== undefined && (typeof data.budget !== "number" || !Number.isFinite(data.budget) || data.budget < 5 || data.budget > 100000)) throw new Error("Budget must be between $5 and $100,000");
        if (data.minNet !== undefined && (typeof data.minNet !== "number" || !Number.isFinite(data.minNet) || data.minNet < 0 || data.minNet > 10000)) throw new Error("Minimum profit must be between $0 and $10,000");
        const next = { ...settingsRef.current, ...data };
        settingsRef.current = next;
        setSettings(next);
        return { budget: next.budget, minNet: next.minNet };
      },
    });
    register({
      name: "set_paper_bot_running", title: "Start or pause paper bot",
      description: "Start or pause the visible paper bot. Starting requires comparable live exchange quotes.",
      inputSchema: { type: "object", properties: { running: { type: "boolean" } }, required: ["running"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        const data = input as Record<string, unknown>;
        if (!data || typeof data.running !== "boolean" || Object.keys(data).length !== 1) throw new Error("Provide running as a boolean");
        if (data.running && !availableRef.current) throw new Error("Comparable live quotes are unavailable");
        runningRef.current = data.running;
        setRunning(data.running);
        return { running: data.running };
      },
    });
    return () => lifecycle.abort();
  }, [hydrated]);

  return <main className="site-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">↔</span><span>ARBITER<span className="brand-light"> / LIVE</span></span></div>
      <div className="topbar-right"><span className="market-status"><span className={`status-light ${allFeeds ? "online" : "offline"}`} />{dataState}</span><span className="top-divider" /><span className="mode-tag">PAPER TRADING</span></div>
    </header>
    <div className="dashboard">
      <div className="intro-row">
        <div><div className="eyebrow">CROSS-EXCHANGE MONITOR <span className="eyebrow-slash">/</span> {venues.length} VENUES · {symbols.length} USD ASSETS</div><h1>Arbitrage desk</h1><p>Quote-driven paper scanning across USD spot books.</p></div>
        <div className="update-chip"><Activity size={16} aria-hidden="true" /><span>{lastCheck ? `Updated ${new Date(lastCheck).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "Awaiting first quote"}</span><button type="button" className="icon-button" aria-label="Refresh market data" title="Refresh market data" onClick={() => void refresh(true)}><RefreshCw size={16} className={loading ? "spin" : ""} /></button></div>
      </div>
      <section className="stat-grid" aria-label="Paper session summary">
        <div className="stat stat-primary"><span className="stat-label">PAPER BALANCE</span><strong>{money(session.balance)}</strong><span className="stat-foot">Starting capital {money(500)}</span></div>
        <div className="stat"><span className="stat-label">PAPER P&L</span><strong className={pnl > 0 ? "positive" : pnl < 0 ? "negative" : ""}>{signedMoney(pnl)}</strong><span className="stat-foot">Estimated after fees + buffer</span></div>
        <div className="stat"><span className="stat-label">SIMULATED TRADES</span><strong>{session.tradeCount}</strong><span className="stat-foot">{session.scans} bot scans completed</span></div>
        <div className="stat"><span className="stat-label">BEST CURRENT ROUTE</span><strong className={best && best.net > 0 ? "positive" : ""}>{best ? signedMoney(best.net) : "—"}</strong><span className="stat-foot">{best ? `${best.symbol} · ${best.buy} → ${best.sell}` : "Waiting for both books"}</span></div>
      </section>
      <section className="universe-panel" aria-label="Market coverage">
        <div className="universe-title"><span className="section-index">MARKET COVERAGE</span><strong>Choose where to look</strong><small>{universe.assets.length} assets · {universe.venues.length} venues · up to {routeCapacity} potential routes</small></div>
        <div className="universe-groups"><div className="universe-group"><span>EXCHANGES</span><div className="choice-list">{venues.map((venue) => <label className="choice" key={venue}><Checkbox checked={universe.venues.includes(venue)} onCheckedChange={() => toggleVenue(venue)} disabled={universe.venues.includes(venue) && universe.venues.length === 2} /><span>{venue}{venue === "Crypto.com" ? "*" : ""}</span></label>)}</div></div>
          <div className="universe-group"><div className="universe-group-head"><span>ASSETS / USD</span><button type="button" onClick={() => setUniverse((previous) => ({ ...previous, assets: symbols }))} disabled={universe.assets.length === symbols.length}>Scan all {symbols.length}</button><button type="button" onClick={() => setUniverse((previous) => ({ ...previous, assets: symbols.slice(0, 16) }))}>Core 16</button></div><div className="choice-list">{symbols.map((asset) => <label className="choice" key={asset}><Checkbox checked={universe.assets.includes(asset)} onCheckedChange={() => toggleAsset(asset)} disabled={universe.assets.includes(asset) && universe.assets.length === 1} /><span>{asset}</span></label>)}</div></div></div>
        <p className="universe-note">bitFlyer supports BTC and ETH in USD; OKX US currently scans BTC, ETH, and SOL in USD. CEX.IO and other exchanges appear only for supported USD pairs with a valid live book. * Crypto.com uses a USD bundle; those routes are indicative and excluded from paper trades.</p>
      </section>
      <div className="main-grid">
        <section className="panel opportunities" aria-labelledby="opportunity-title">
          <div className="panel-heading"><div><span className="section-index">01 / MARKET SCAN</span><h2 id="opportunity-title">Live opportunities</h2></div><span className="refresh-label">QUOTE DRIVEN · 4 SEC FALLBACK</span></div>
          <div className="panel-subline">Compare fresh best-level prices and size from seven cash USD venues. Coinbase, Kraken, Gemini, Bitstamp, CEX.IO, and OKX US stream; bitFlyer and missing streams use rotating REST fallback. Paper scans run on new quotes, at most once every 250 ms.</div>
          {fetchError && <div className="feed-warning" role="status">Unable to reach market feeds. {fetchError} <button type="button" onClick={() => void refresh()}>Try again</button></div>}
          {!!snapshot?.errors.length && <div className="feed-warning" role="status"><details><summary>{snapshot.errors.length} selected REST pair feeds unavailable. Streaming quotes may still be available.</summary><div className="warning-details">{snapshot.errors.join(" · ")}</div></details></div>}
          <Table className="market-table">
            <TableHeader><TableRow><TableHead>PAIR / ROUTE</TableHead><TableHead>BUY ASK</TableHead><TableHead>SELL BID</TableHead><TableHead>RAW GAP</TableHead><TableHead className="align-right">EST. NET / TRADE</TableHead></TableRow></TableHeader>
            <TableBody>
              {visibleRoutes.map((route) => <TableRow key={route.key}>
                <TableCell><div className="pair-cell"><span className={`coin-icon coin-${route.symbol.toLowerCase()}`}>{({ BTC: "₿", ETH: "Ξ", SOL: "◎", XRP: "✕", DOGE: "Ð", LTC: "Ł", ADA: "₳", AVAX: "A", LINK: "⬡", XLM: "✦", BCH: "₿", UNI: "◈" } as Partial<Record<SymbolName, string>>)[route.symbol] || route.symbol[0]}</span><span><strong>{route.symbol}<small> / {route.indicative ? "USD bundle" : "USD"}</small></strong><span className="venue-route">{route.buy} <ArrowRight size={12} aria-hidden="true" /> {route.sell}</span><span className="quote-detail">{route.streamLegs ? `${route.streamLegs}/2 streamed` : "REST quotes"} · {(route.ageMs / 1000).toFixed(1)}s old</span></span></div></TableCell>
                <TableCell className="mono">{price(route.ask)}</TableCell><TableCell className="mono">{price(route.bid)}</TableCell>
                <TableCell className={`mono ${route.grossPct > 0 ? "positive" : "muted-number"}`}>{pct(route.grossPct)}</TableCell>
                <TableCell className="align-right"><strong className={`net-number ${route.indicative ? "indicative-number" : route.net > 0 ? "positive" : route.net < 0 ? "negative" : ""}`}>{signedMoney(route.net)}</strong><span className="net-percent">{route.indicative ? "INDICATIVE · NO CONVERSION" : pct(route.netPct)}</span><span className="fee-breakdown">Buy fee {money(route.buyFee)} · sell fee {money(route.sellFee)}<br />Buffer {money(route.movementCost)}</span></TableCell>
              </TableRow>)}
              {!routes.length && <TableRow><TableCell colSpan={5}><div className="table-empty">{loading ? "Connecting to live order books…" : "No fresh, comparable quotes right now. The monitor will retry automatically."}</div></TableCell></TableRow>}
            </TableBody>
          </Table>
          <div className="panel-bottom"><span>Net estimate includes taker fees and a price movement buffer on both legs. USD bundle routes omit conversion costs.</span>{routes.length > 16 ? <button type="button" className="show-routes" onClick={() => setShowAllRoutes((value) => !value)}>{showAllRoutes ? "Show fewer" : `Show all ${routes.length} routes`}</button> : <span>Spot pairs only</span>}</div>
        </section>
        <aside className="panel controls" aria-labelledby="bot-title">
          <div className="panel-heading"><div><span className="section-index">02 / EXECUTION</span><h2 id="bot-title">Paper bot</h2></div><span className={`bot-state ${running ? "is-running" : ""}`}>{running ? "RUNNING" : "PAUSED"}</span></div>
          <p className="control-copy">Scan when a quote changes and simulate a trade when fresh prices clear your net minimum. Nothing is sent to an exchange.</p>
          <button type="button" className={`run-button ${running ? "pause-button" : ""}`} onClick={() => setRunning(!running)} disabled={!available && !running}>{running ? <><Pause size={17} fill="currentColor" /> Pause paper bot</> : <><Play size={17} fill="currentColor" /> Start paper bot</>}</button>
          {!available && <p className="inline-note">Waiting for live quotes before starting.</p>}
          <div className="control-rule" />
          <div className="setting-head"><span>TRADE RULES</span><span>LOCAL SETTINGS</span></div>
          <label className="field"><span>Budget per trade <small>USD</small></span><div className="input-wrap"><span>$</span><Input type="number" min="5" max="100000" step="1" {...fieldProps("budget", settings.budget)} aria-label="Budget per trade in dollars" /></div></label>
          <label className="field"><span>Minimum estimated profit <small>USD</small></span><div className="input-wrap"><span>$</span><Input type="number" min="0" max="10000" step="0.01" {...fieldProps("minNet", settings.minNet)} aria-label="Minimum estimated profit in dollars" /></div></label>
          <div className="control-rule" />
          <div className="setting-head"><span>COST ASSUMPTIONS</span><span>PER LEG</span></div>
          <div className="fee-sync"><span>{feeSnapshot ? `${Object.keys(feeSnapshot.rates).length}/${Object.keys(publicFeeSources).length} public base tiers · checked ${new Date(feeSnapshot.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : feeLoading ? "Checking public fee schedules…" : "Using editable fee estimates"}</span><button type="button" onClick={() => void refreshFees(true)} disabled={feeLoading}>{feeLoading ? "Checking…" : "Refresh fees"}</button></div>
          {feeError && <p className="inline-note" role="status">{feeError}</p>}
          {!!feeSnapshot?.errors.length && <details className="fee-errors"><summary>{feeSnapshot.errors.length} public schedules unavailable; estimates remain in use</summary><p>{feeSnapshot.errors.join(" · ")}</p></details>}
          <p className="fee-explainer">Published rates are entry tier spot taker fees, not your account’s rate. Edit a number to override it. Dollar costs in each route update with live quotes.</p>
          <div className="field-pair">{venues.map((venue) => {
            const key = feeKey[venue];
            const published = feeSnapshot?.rates[venue];
            const manual = manualFees.includes(venue);
            return <div className="fee-field" key={venue}><label className="field"><span>{venue} fee</span><div className="input-wrap percent-wrap"><Input type="number" min="0" max="10" step="0.01" {...fieldProps(key, appliedSettings[key])} aria-label={`${venue} fee percent`} /><span>%</span></div></label><div className="fee-source">{manual ? "Manual rate" : published ? <a href={published.url} target="_blank" rel="noopener noreferrer">Public base tier ↗</a> : feeScheduleLinks[venue] ? <><span>Estimate · </span><a href={feeScheduleLinks[venue]} target="_blank" rel="noopener noreferrer">Schedule ↗</a></> : "Editable estimate"}{manual && published && <button type="button" onClick={() => setManualFees((previous) => previous.filter((item) => item !== venue))}>Use public</button>}</div></div>;
          })}</div>
          <label className="field"><span>Price movement buffer <small>each side</small></span><div className="input-wrap percent-wrap"><Input type="number" min="0" max="10" step="0.01" {...fieldProps("buffer", settings.buffer)} aria-label="Price movement buffer percent for each side" /><span>%</span></div></label>
          <div className="control-rule" />
          <div className="bot-footer"><div><span className="bot-footer-label">AUTO SCAN</span><span className="bot-footer-sub">Only while this page is open</span></div><Switch checked={running} onCheckedChange={(value) => setRunning(!!value)} disabled={!available && !running} aria-label="Auto scan and paper trade" /></div>
        </aside>
      </div>
      <section className="panel activity-panel" aria-labelledby="activity-title">
        <div className="panel-heading"><div><span className="section-index">03 / SESSION HISTORY</span><h2 id="activity-title">Paper trade log</h2></div>
          <AlertDialog><AlertDialogTrigger asChild><button type="button" className="reset-button"><RotateCcw size={14} /> Reset session</button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Reset paper session?</AlertDialogTitle><AlertDialogDescription>This clears saved paper trades and scans on this device and restores the $500 starting balance.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep session</AlertDialogCancel><AlertDialogAction onClick={() => { setRunning(false); setSession(newSession); }}>Reset session</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
        </div>
        {session.trades.length ? <div className="trade-list">{session.trades.map((trade) => <div className="trade-item" key={trade.id}><span className="trade-icon"><Activity size={17} /></span><div className="trade-description"><strong>{trade.symbol} <span>{trade.buy} → {trade.sell}</span></strong><small>{new Date(trade.time).toLocaleString()} · {trade.quantity.toFixed(trade.symbol === "BTC" ? 6 : 4)} {trade.symbol} · {money(trade.notional)} cost{Number.isFinite(trade.buyFee) && Number.isFinite(trade.sellFee) ? ` · ${money(trade.buyFee + trade.sellFee)} fees` : ""}</small></div><strong className="trade-profit">{signedMoney(trade.net)}<ArrowUpRight size={15} aria-hidden="true" /></strong></div>)}</div> : <div className="activity-empty"><span className="empty-icon"><Activity size={24} strokeWidth={1.5} /></span><div><strong>No paper trades yet</strong><p>{running ? "Scanning live routes. A trade appears when the estimated net amount clears your minimum." : "Start the paper bot to scan for routes that clear your profit threshold."}</p></div></div>}
      </section>
      <footer className="site-footer"><p>Paper results assume pre-funded balances at both venues and immediate fills at quoted depth. Public fee schedules provide entry tier estimates when available; your account’s actual fees may differ. Quote age, minimum sizes, failed fills, regional availability, and rebalancing can prevent a real trade. An available quote does not establish that your account can trade that pair. No orders are placed.</p><div>MARKET DATA <a href="https://docs.cdp.coinbase.com/exchange/websocket-feed/channels" target="_blank" rel="noopener noreferrer">Coinbase ↗</a><a href="https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker" target="_blank" rel="noopener noreferrer">Kraken ↗</a><a href="https://developer.gemini.com/websocket/streams" target="_blank" rel="noopener noreferrer">Gemini ↗</a><a href="https://www.bitstamp.net/api/" target="_blank" rel="noopener noreferrer">Bitstamp ↗</a><a href="https://trade.cex.io/api/spot/ws-public" target="_blank" rel="noopener noreferrer">CEX.IO ↗</a><a href="https://lightning.bitflyer.com/docs?lang=en" target="_blank" rel="noopener noreferrer">bitFlyer ↗</a><a href="https://app.okx.com/docs-v5/en/" target="_blank" rel="noopener noreferrer">OKX ↗</a><a href="https://exchange-developer.crypto.com/exchange/v1/docs/api/rest/public-get-book" target="_blank" rel="noopener noreferrer">Crypto.com ↗</a></div></footer>
    </div>
  </main>;
}
