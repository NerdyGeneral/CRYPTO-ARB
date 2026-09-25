import fs from "node:fs";
import path from "node:path";
import { isSea } from "node:sea";
import { emptyTally, type ShadowTally, type VerdictGroup } from "../lib/accuracy";
import type { Listing } from "../lib/discovery";
import { defaults, settingRange, venues, type Settings, type Venue } from "../lib/market";
import type { Opportunity } from "../lib/opportunities";
import type { ShadowResult } from "../lib/shadow";
import type { VerdictKind } from "../lib/verify";

const CONFIG_VERSION = 2;

export type EngineConfig = {
  version: number;
  port: number;
  openBrowser: boolean;
  keepAwake: boolean;
  startingBalance: number;
  venues: Venue[];
  // The most-traded coins listed on at least two exchanges, plus any extras, minus any excluded.
  topCoins: number;
  extraCoins: string[];
  excludeCoins: string[];
  triangular: boolean;
  // Cost of converting a dollar stablecoin to or from USD, in percent (Kraken's entry tier is 0.20%).
  conversionFee: number;
  settings: Settings;
};

export type SessionFile = {
  // The balance this session started from; a new starting balance applies from the next reset.
  startedAt: number; startingBalance: number; balance: number; scans: number; tradeCount: number;
  // Shadow mode: the same trades replayed against the books one round trip later.
  shadowSince: number; shadow: ShadowTally;
};

export type ShadowRecord = ShadowResult & { time: number; path: string; kind: string; latencyMs: number };

export type TradeRecord = Opportunity & { time: number };

export type HourlyRow = {
  hour: string; scans: number; trades: number; pnl: number; bestNetPct: number | null; bestTriangleNetPct: number | null;
  bestGrossPct: number | null; suspectRoutes: number; quotes: number; avgScanMs: number; shadow: ShadowTally;
};

export type VerdictRecord = { time: number; group: VerdictGroup; key: string; path: string; kind: VerdictKind; grossPct: number };

// Crypto.com routes are USD-bundle estimates, so the engine leaves them out by default.
export const defaultConfig: EngineConfig = {
  version: CONFIG_VERSION,
  port: 4173,
  openBrowser: true,
  keepAwake: true,
  startingBalance: 500,
  venues: venues.filter((venue) => venue !== "Crypto.com"),
  topCoins: 150,
  extraCoins: [],
  excludeCoins: [],
  triangular: true,
  conversionFee: 0.2,
  settings: defaults,
};

const TRADES_HEADER = "time,kind,path,notional_usd,gross_pct,net_usd,net_pct,fees_usd,conversion_usd,buffer_usd,quote_age_ms,legs";
const HOURLY_HEADER = "hour,scans,trades,pnl_usd,best_net_pct,best_triangle_net_pct,best_gross_pct,suspect_routes,quotes,avg_scan_ms," +
  "shadow_expected_usd,shadow_pnl_usd,shadow_abs_error_usd,shadow_filled,shadow_partial,shadow_missed,shadow_losses";
const SHADOW_HEADER = "time,kind,path,expected_net_usd,realized_net_usd,outcome,filled_fraction,latency_ms,unwound";
const VERDICT_HEADER = "time,group,route_key,path,kind,gross_pct";

// Validates a config from disk or the dashboard; anything missing or out of range takes its default.
export function normalizeConfig(raw: unknown): EngineConfig {
  const saved = (raw || {}) as Partial<Record<keyof EngineConfig, unknown>> & { settings?: Partial<Record<keyof Settings, unknown>> };
  const number = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  const bool = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
  const coins = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((c): c is string => typeof c === "string").map((c) => c.trim().toUpperCase()).filter(Boolean))] : [];
  const settings = Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
    const [min, max] = settingRange(key as keyof Settings);
    return [key, number(saved.settings?.[key as keyof Settings], value, min, max)];
  })) as Settings;
  // Configs from before version 2 predate Binance.US, so their exchange list is replaced by the default.
  const current = saved.version === CONFIG_VERSION;
  const chosenVenues = current && Array.isArray(saved.venues) ? venues.filter((venue) => (saved.venues as unknown[]).includes(venue)) : defaultConfig.venues;
  const config: EngineConfig = {
    version: CONFIG_VERSION,
    port: number(saved.port, defaultConfig.port, 1024, 65535),
    openBrowser: bool(saved.openBrowser, defaultConfig.openBrowser),
    keepAwake: bool(saved.keepAwake, defaultConfig.keepAwake),
    startingBalance: number(saved.startingBalance, defaultConfig.startingBalance, 10, 10_000_000),
    venues: chosenVenues.length >= 2 ? chosenVenues : defaultConfig.venues,
    topCoins: Math.round(number(saved.topCoins, defaultConfig.topCoins, 1, 500)),
    extraCoins: coins(saved.extraCoins),
    excludeCoins: coins(saved.excludeCoins),
    triangular: bool(saved.triangular, defaultConfig.triangular),
    conversionFee: number(saved.conversionFee, defaultConfig.conversionFee, 0, 5),
    settings,
  };
  return config;
}

export function resolveDataDir(): string {
  if (process.env.ARBITER_DATA_DIR) return path.resolve(process.env.ARBITER_DATA_DIR);
  // A packaged exe keeps its data beside itself so it is easy to find, back up or delete.
  return path.join(isSea() ? path.dirname(process.execPath) : process.cwd(), "arbiter-data");
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(file: string, value: unknown) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export class Store {
  readonly dir: string;
  private readonly configFile: string;
  private readonly sessionFile: string;
  private readonly tradesFile: string;
  private readonly hourlyFile: string;
  private readonly listingFile: string;
  private readonly shadowFile: string;
  private readonly verdictFile: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.configFile = path.join(dir, "config.json");
    this.sessionFile = path.join(dir, "session.json");
    this.tradesFile = path.join(dir, "trades.csv");
    this.hourlyFile = path.join(dir, "hourly.csv");
    this.listingFile = path.join(dir, "listings.json");
    this.shadowFile = path.join(dir, "shadow.csv");
    this.verdictFile = path.join(dir, "verdicts.csv");
    // Logs written by an older version have different columns; set them aside rather than mix formats.
    for (const [file, header] of [[this.tradesFile, TRADES_HEADER], [this.hourlyFile, HOURLY_HEADER], [this.shadowFile, SHADOW_HEADER], [this.verdictFile, VERDICT_HEADER]]) {
      const first = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n", 1)[0] : header;
      if (first !== header) fs.renameSync(file, file.replace(/\.csv$/, `-old-format-${stamp()}.csv`));
    }
  }

  // Missing or invalid values fall back to defaults; the file is rewritten so every option is visible.
  loadConfig(): EngineConfig {
    const config = normalizeConfig(readJson(this.configFile));
    this.saveConfig(config);
    return config;
  }

  saveConfig(config: EngineConfig) { writeJson(this.configFile, config); }

  loadSession(startingBalance: number): SessionFile {
    const saved = readJson(this.sessionFile) as Partial<SessionFile> | null;
    const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
    const fresh = Store.freshSession(startingBalance);
    if (!saved || ![saved.startedAt, saved.balance, saved.scans, saved.tradeCount].every(valid)) return fresh;
    // Sessions from before shadow mode start their shadow tally now; ones from before a stored starting
    // balance keep measuring from the configured one.
    const tally = saved.shadow && Object.keys(emptyTally()).every((key) => valid(saved.shadow![key as keyof ShadowTally])) ? saved.shadow : null;
    return {
      startedAt: saved.startedAt!, startingBalance: valid(saved.startingBalance) ? saved.startingBalance : startingBalance,
      balance: saved.balance!, scans: saved.scans!, tradeCount: saved.tradeCount!,
      shadowSince: tally && valid(saved.shadowSince) ? saved.shadowSince : fresh.shadowSince, shadow: tally || emptyTally(),
    };
  }

  static freshSession(startingBalance: number): SessionFile {
    const now = Date.now();
    return { startedAt: now, startingBalance, balance: startingBalance, scans: 0, tradeCount: 0, shadowSince: now, shadow: emptyTally() };
  }

  saveSession(session: SessionFile) { writeJson(this.sessionFile, session); }

  loadListing(): Listing | null {
    const saved = readJson(this.listingFile) as Listing | null;
    return saved && Array.isArray(saved.markets) && saved.markets.length ? saved : null;
  }

  saveListing(listing: Listing) { writeJson(this.listingFile, listing); }

  appendTrade(trade: TradeRecord) {
    const legs = trade.legs.map((leg) => `${leg.side} ${leg.pair} @${leg.price} ${leg.venue}`).join("; ");
    const row = [new Date(trade.time).toISOString(), trade.kind, trade.path, trade.notional.toFixed(2), trade.grossPct.toFixed(4),
      trade.net.toFixed(4), trade.netPct.toFixed(4), trade.fees.toFixed(4), trade.conversion.toFixed(4), trade.buffer.toFixed(4),
      Math.round(trade.ageMs), legs].map(csvCell).join(",");
    this.append(this.tradesFile, TRADES_HEADER, row);
  }

  appendHourly(row: HourlyRow) {
    const t = row.shadow;
    const line = [row.hour, row.scans, row.trades, row.pnl.toFixed(4), row.bestNetPct?.toFixed(4), row.bestTriangleNetPct?.toFixed(4),
      row.bestGrossPct?.toFixed(4), row.suspectRoutes, row.quotes, row.avgScanMs.toFixed(1), t.expected.toFixed(4), t.realized.toFixed(4),
      t.absError.toFixed(4), t.filled, t.partial, t.missed, t.losses].map(csvCell).join(",");
    this.append(this.hourlyFile, HOURLY_HEADER, line);
  }

  appendShadow(record: ShadowRecord) {
    const line = [new Date(record.time).toISOString(), record.kind, record.path, record.expectedNet.toFixed(4), record.realizedNet.toFixed(4),
      record.outcome, record.filledFraction.toFixed(3), Math.round(record.latencyMs), record.unwound.join("; ")].map(csvCell).join(",");
    this.append(this.shadowFile, SHADOW_HEADER, line);
  }

  readRecentShadow(limit: number): Record<string, string>[] { return this.readCsvTail(this.shadowFile, limit); }

  appendVerdict(record: VerdictRecord) {
    const line = [new Date(record.time).toISOString(), record.group, record.key, record.path, record.kind, record.grossPct.toFixed(4)].map(csvCell).join(",");
    this.append(this.verdictFile, VERDICT_HEADER, line);
  }

  readRecentVerdicts(limit: number): Record<string, string>[] { return this.readCsvTail(this.verdictFile, limit); }

  readRecentTrades(limit: number): Record<string, string>[] { return this.readCsvTail(this.tradesFile, limit); }
  readRecentHours(limit: number): Record<string, string>[] { return this.readCsvTail(this.hourlyFile, limit); }

  // Keep the CSV files but archive them so a reset starts a clean log.
  archiveLogs() {
    const suffix = stamp();
    for (const file of [this.tradesFile, this.hourlyFile, this.shadowFile, this.verdictFile]) if (fs.existsSync(file)) fs.renameSync(file, file.replace(/\.csv$/, `-${suffix}.csv`));
  }

  private append(file: string, header: string, line: string) {
    fs.appendFileSync(file, fs.existsSync(file) ? `${line}\n` : `${header}\n${line}\n`);
  }

  // Rows never contain commas except inside quoted cells, which these logs do not produce.
  private readCsvTail(file: string, limit: number): Record<string, string>[] {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
    const lines = text.trim().split("\n");
    const header = lines.shift()?.split(",") || [];
    return lines.slice(-limit).reverse().map((line) => Object.fromEntries(line.split(",").map((cell, index) => [header[index], cell])));
  }
}
