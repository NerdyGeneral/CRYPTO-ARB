import fs from "node:fs";
import path from "node:path";
import { isSea } from "node:sea";
import { defaults, settingRange, symbols, venues, type Settings, type SymbolName, type Trade, type Venue } from "../lib/market";

export type EngineConfig = {
  port: number;
  openBrowser: boolean;
  keepAwake: boolean;
  startingBalance: number;
  assets: SymbolName[];
  venues: Venue[];
  settings: Settings;
};

export type SessionFile = {
  startedAt: number;
  balance: number;
  scans: number;
  tradeCount: number;
};

export type HourlyRow = {
  hour: string; scans: number; trades: number; pnl: number; bestNetPct: number | null;
  bestGrossPct: number | null; suspectRoutes: number; quotes: number;
};

// Crypto.com routes are USD-bundle estimates, so the engine leaves them out by default.
export const defaultConfig: EngineConfig = {
  port: 4173,
  openBrowser: true,
  keepAwake: true,
  startingBalance: 500,
  assets: symbols.slice(0, 16),
  venues: venues.filter((venue) => venue !== "Crypto.com"),
  settings: defaults,
};

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

export class Store {
  readonly dir: string;
  private readonly configFile: string;
  private readonly sessionFile: string;
  private readonly tradesFile: string;
  private readonly hourlyFile: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.configFile = path.join(dir, "config.json");
    this.sessionFile = path.join(dir, "session.json");
    this.tradesFile = path.join(dir, "trades.csv");
    this.hourlyFile = path.join(dir, "hourly.csv");
  }

  // Missing or invalid values fall back to defaults; the file is rewritten so every option is visible.
  loadConfig(): EngineConfig {
    const saved = (readJson(this.configFile) || {}) as Partial<EngineConfig> & { settings?: Partial<Record<keyof Settings, unknown>> };
    const number = (value: unknown, fallback: number, min: number, max: number) =>
      typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
    const settings = Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
      const [min, max] = settingRange(key as keyof Settings);
      return [key, number(saved.settings?.[key as keyof Settings], value, min, max)];
    })) as Settings;
    const assets = symbols.filter((symbol) => Array.isArray(saved.assets) ? saved.assets.includes(symbol) : defaultConfig.assets.includes(symbol));
    const chosenVenues = venues.filter((venue) => Array.isArray(saved.venues) ? saved.venues.includes(venue) : defaultConfig.venues.includes(venue));
    const config: EngineConfig = {
      port: number(saved.port, defaultConfig.port, 1024, 65535),
      openBrowser: typeof saved.openBrowser === "boolean" ? saved.openBrowser : defaultConfig.openBrowser,
      keepAwake: typeof saved.keepAwake === "boolean" ? saved.keepAwake : defaultConfig.keepAwake,
      startingBalance: number(saved.startingBalance, defaultConfig.startingBalance, 10, 10_000_000),
      assets: assets.length ? assets : defaultConfig.assets,
      venues: chosenVenues.length >= 2 ? chosenVenues : defaultConfig.venues,
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

  appendTrade(trade: Trade) {
    const header = "time,symbol,buy,sell,ask,bid,quantity,notional_usd,gross_pct,net_usd,net_pct,buy_fee_usd,sell_fee_usd,buffer_usd,quote_age_ms\n";
    const row = [new Date(trade.time).toISOString(), trade.symbol, trade.buy, trade.sell, trade.ask, trade.bid, trade.quantity.toFixed(8),
      trade.notional.toFixed(2), trade.grossPct.toFixed(4), trade.net.toFixed(4), trade.netPct.toFixed(4), trade.buyFee.toFixed(4),
      trade.sellFee.toFixed(4), trade.movementCost.toFixed(4), trade.ageMs].map(csvCell).join(",");
    this.append(this.tradesFile, header, `${row}\n`);
  }

  appendHourly(row: HourlyRow) {
    const header = "hour,scans,trades,pnl_usd,best_net_pct,best_gross_pct,suspect_routes,quotes\n";
    const line = [row.hour, row.scans, row.trades, row.pnl.toFixed(4), row.bestNetPct?.toFixed(4), row.bestGrossPct?.toFixed(4),
      row.suspectRoutes, row.quotes].map(csvCell).join(",");
    this.append(this.hourlyFile, header, `${line}\n`);
  }

  readRecentTrades(limit: number): Record<string, string>[] { return this.readCsvTail(this.tradesFile, limit); }
  readRecentHours(limit: number): Record<string, string>[] { return this.readCsvTail(this.hourlyFile, limit); }

  // Keep the CSV files but archive them so a reset starts a clean log.
  archiveLogs() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const file of [this.tradesFile, this.hourlyFile]) if (fs.existsSync(file)) fs.renameSync(file, file.replace(/\.csv$/, `-${stamp}.csv`));
  }

  private append(file: string, header: string, line: string) {
    fs.appendFileSync(file, fs.existsSync(file) ? line : header + line);
  }

  private readCsvTail(file: string, limit: number): Record<string, string>[] {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
    const lines = text.trim().split("\n");
    const header = lines.shift()?.split(",") || [];
    return lines.slice(-limit).reverse().map((line) => Object.fromEntries(line.split(",").map((cell, index) => [header[index], cell])));
  }
}
