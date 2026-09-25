import fs from "node:fs";
import path from "node:path";
import { isSea } from "node:sea";
import type { Listing } from "../lib/discovery";
import { defaults, settingRange, venues, type Settings, type Venue } from "../lib/market";
import type { Opportunity } from "../lib/opportunities";

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

export type SessionFile = { startedAt: number; balance: number; scans: number; tradeCount: number };

export type TradeRecord = Opportunity & { time: number };

export type HourlyRow = {
  hour: string; scans: number; trades: number; pnl: number; bestNetPct: number | null; bestTriangleNetPct: number | null;
  bestGrossPct: number | null; suspectRoutes: number; quotes: number; avgScanMs: number;
};

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
const HOURLY_HEADER = "hour,scans,trades,pnl_usd,best_net_pct,best_triangle_net_pct,best_gross_pct,suspect_routes,quotes,avg_scan_ms";

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

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.configFile = path.join(dir, "config.json");
    this.sessionFile = path.join(dir, "session.json");
    this.tradesFile = path.join(dir, "trades.csv");
    this.hourlyFile = path.join(dir, "hourly.csv");
    this.listingFile = path.join(dir, "listings.json");
    // Logs written by an older version have different columns; set them aside rather than mix formats.
    for (const [file, header] of [[this.tradesFile, TRADES_HEADER], [this.hourlyFile, HOURLY_HEADER]]) {
      const first = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n", 1)[0] : header;
      if (first !== header) fs.renameSync(file, file.replace(/\.csv$/, `-old-format-${stamp()}.csv`));
    }
  }

  // Missing or invalid values fall back to defaults; the file is rewritten so every option is visible.
  loadConfig(): EngineConfig {
    const saved = (readJson(this.configFile) || {}) as Partial<Record<keyof EngineConfig, unknown>> & { settings?: Partial<Record<keyof Settings, unknown>> };
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
    writeJson(this.configFile, config);
    return config;
  }

  loadSession(startingBalance: number): SessionFile {
    const saved = readJson(this.sessionFile) as Partial<SessionFile> | null;
    if (saved && [saved.startedAt, saved.balance, saved.scans, saved.tradeCount].every((n) => typeof n === "number" && Number.isFinite(n)))
      return saved as SessionFile;
    return { startedAt: Date.now(), balance: startingBalance, scans: 0, tradeCount: 0 };
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
    const line = [row.hour, row.scans, row.trades, row.pnl.toFixed(4), row.bestNetPct?.toFixed(4), row.bestTriangleNetPct?.toFixed(4),
      row.bestGrossPct?.toFixed(4), row.suspectRoutes, row.quotes, row.avgScanMs.toFixed(1)].map(csvCell).join(",");
    this.append(this.hourlyFile, HOURLY_HEADER, line);
  }

  readRecentTrades(limit: number): Record<string, string>[] { return this.readCsvTail(this.tradesFile, limit); }
  readRecentHours(limit: number): Record<string, string>[] { return this.readCsvTail(this.hourlyFile, limit); }

  // Keep the CSV files but archive them so a reset starts a clean log.
  archiveLogs() {
    const suffix = stamp();
    for (const file of [this.tradesFile, this.hourlyFile]) if (fs.existsSync(file)) fs.renameSync(file, file.replace(/\.csv$/, `-${suffix}.csv`));
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
