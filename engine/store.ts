import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isSea } from "node:sea";
import { emptyTally, type ShadowTally, type VerdictGroup } from "../lib/accuracy";
import type { CarryAccounting, CarryPosition } from "../lib/carry";
import type { Listing } from "../lib/discovery";
import { defaults, settingRange, venues, type Settings, type Venue } from "../lib/market";
import type { Opportunity } from "../lib/opportunities";
import type { PortfolioState } from "../lib/portfolio";
import type { ShadowResult } from "../lib/shadow";
import type { VerdictKind } from "../lib/verify";

const CONFIG_VERSION = 2;

export type EngineConfig = {
  version: number;
  port: number;
  openBrowser: boolean;
  keepAwake: boolean;
  // Windows only: a shortcut in the Startup folder opens the engine at sign-in, e.g. after an update restart.
  startWithWindows: boolean;
  startingBalance: number;
  venues: Venue[];
  // The most-traded coins listed on at least two exchanges, plus any extras, minus any excluded.
  topCoins: number;
  extraCoins: string[];
  excludeCoins: string[];
  triangular: boolean;
  // Check the routes that use a book the moment its price changes, rather than only on the half-second scan.
  reactToPrices: boolean;
  // Cost of converting a dollar stablecoin to or from USD, in percent (Kraken's entry tier is 0.20%).
  conversionFee: number;
  settings: Settings;
  carry: CarryConfig;
};

// Spot vs futures carry (paper). Percentages are in percent; capital is a separate paper account.
export type CarryConfig = {
  enabled: boolean; capital: number; maxPositions: number;
  marginBuffer: number; // collateral held against each short, % of its notional
  futuresFee: number; // taker fee per side, %
  minNetApr: number; // open when the expected net yearly return on the capital used is at least this, %
  exitApr: number; // close when the last 6 hours of funding average below this yearly rate, %
  holdDays: number; // expected holding time, to spread the round-trip costs
};

// The persisted carry account: free cash, open positions, recent closed ones and the last settlement seen per contract.
export type CarryState = {
  startedAt: number; capital: number; cash: number; positions: CarryPosition[]; closed: CarryPosition[];
  lastFunding: Record<string, number>; coins: string[]; accounting?: CarryAccounting;
};

export const carryDefaults: CarryConfig = {
  enabled: true, capital: 5000, maxPositions: 3, marginBuffer: 100, futuresFee: 0.05, minNetApr: 8, exitApr: 0, holdDays: 14,
};
export const carryRange: Record<Exclude<keyof CarryConfig, "enabled">, [number, number]> = {
  capital: [100, 10_000_000], maxPositions: [1, 20], marginBuffer: [10, 300], futuresFee: [0, 1], minNetApr: [-100, 1000], exitApr: [-100, 1000], holdDays: [1, 365],
};

export type SessionFile = {
  id: string;
  portfolio?: PortfolioState;
  pendingTrades?: Record<string, Opportunity>;
  // Monotonic sequence of the audit event represented by this snapshot.
  auditSequence?: number;
  accountingVersion?: 1;
  legacyEstimate?: { balance: number; tradeCount: number; shadow: ShadowTally };
  // The balance this session started from; a new starting balance applies from the next reset.
  startedAt: number; startingBalance: number; balance: number; scans: number; tradeCount: number;
  // Shadow mode: the same trades replayed against the books one round trip later.
  shadowSince: number; shadow: ShadowTally;
  // The hour in progress, so a restart doesn't lose it.
  hour?: HourState;
};

export type HourState = {
  start: number; scans: number; trades: number; pnl: number; quotes: number; scanMs: number; scanCount: number;
  bestNetPct: number | null; bestTriangleNetPct: number | null; bestGrossPct: number | null; suspectKeys: string[]; shadow: ShadowTally;
};

export type ShadowRecord = ShadowResult & { id?: string; time: number; path: string; kind: string; latencyMs: number };

export type TradeRecord = Opportunity & { id?: string; time: number };

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
  startWithWindows: false,
  startingBalance: 500,
  venues: venues.filter((venue) => venue !== "Crypto.com"),
  topCoins: 150,
  extraCoins: [],
  excludeCoins: [],
  triangular: true,
  reactToPrices: true,
  conversionFee: 0.2,
  settings: defaults,
  carry: carryDefaults,
};

const TRADES_HEADER = "time,kind,path,notional_usd,gross_pct,net_usd,net_pct,fees_usd,conversion_usd,buffer_usd,quote_age_ms,legs,trade_id";
const HOURLY_HEADER = "hour,scans,trades,pnl_usd,best_net_pct,best_triangle_net_pct,best_gross_pct,suspect_routes,quotes,avg_scan_ms," +
  "shadow_expected_usd,shadow_pnl_usd,shadow_abs_error_usd,shadow_filled,shadow_partial,shadow_missed,shadow_losses,shadow_unresolved,shadow_expected_complete_usd";
const SHADOW_HEADER = "time,kind,path,expected_net_usd,realized_net_usd,outcome,filled_fraction,latency_ms,unwound,trade_id,accounting_complete,known_net_usd,execution";
const VERDICT_HEADER = "time,group,route_key,path,kind,gross_pct";
const CARRY_HEADER = "time,event,position,coin,contract,spot_venue,contracts,spot_qty,spot_price,futures_price,funding_rate,amount_usd,net_usd,note";
const FUNDING_HEADER = "time,contract,coin,rate,index_price";

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
    startWithWindows: bool(saved.startWithWindows, defaultConfig.startWithWindows),
    startingBalance: number(saved.startingBalance, defaultConfig.startingBalance, 10, 10_000_000),
    venues: chosenVenues.length >= 2 ? chosenVenues : defaultConfig.venues,
    topCoins: Math.round(number(saved.topCoins, defaultConfig.topCoins, 1, 500)),
    extraCoins: coins(saved.extraCoins),
    excludeCoins: coins(saved.excludeCoins),
    triangular: bool(saved.triangular, defaultConfig.triangular),
    reactToPrices: bool(saved.reactToPrices, defaultConfig.reactToPrices),
    conversionFee: number(saved.conversionFee, defaultConfig.conversionFee, 0, 5),
    settings,
    carry: {
      enabled: bool(saved.carry && (saved.carry as Partial<CarryConfig>).enabled, carryDefaults.enabled),
      ...Object.fromEntries(Object.entries(carryRange).map(([key, [min, max]]) =>
        [key, number(((saved.carry || {}) as Record<string, unknown>)[key], carryDefaults[key as keyof typeof carryRange], min, max)])),
    } as CarryConfig,
  };
  config.carry.maxPositions = Math.round(config.carry.maxPositions);
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

async function writeJson(file: string, serialized: string) {
  const temp = `${file}.tmp`;
  const handle = await fs.promises.open(temp, "w");
  try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
  await fs.promises.rename(temp, file);
  await syncDirectory(path.dirname(file));
}

async function syncDirectory(dir: string) {
  // Windows does not allow opening a directory for fsync. File handles are still synced there.
  if (process.platform === "win32") return;
  const handle = await fs.promises.open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

// Preserve full binary64 precision and reject values JSON would silently turn into null.
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Cannot persist a non-finite audit value");
    return item;
  });
}

export type AuditRecord = {
  version: 1; event: string; sessionId: string; tradeId?: string; time: number; payload: unknown; checkpoint?: SessionFile;
};
type PersistedAuditRecord = AuditRecord & { sequence: number };

function firstLine(file: string): string | null {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(4096);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8").split("\n", 1)[0].replace(/\r$/, "");
  } finally { fs.closeSync(fd); }
}

// Startup-only streaming recovery keeps memory bounded by the largest individual audit event.
function scanAudit(file: string, accept: (record: PersistedAuditRecord) => void): { sequence: number; completeBytes: number; size: number } {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sequence: 0, completeBytes: 0, size: 0 };
    throw error;
  }
  let sequence = 0, completeBytes = 0, position = 0, pending = Buffer.alloc(0);
  try {
    const buffer = Buffer.alloc(64 * 1024), size = fs.fstatSync(fd).size;
    while (position < size) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!count) break;
      position += count;
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end).toString("utf8");
        completeBytes += end + 1;
        pending = pending.subarray(end + 1);
        const record = JSON.parse(line) as PersistedAuditRecord;
        if (record.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence <= sequence
          || typeof record.sessionId !== "string" || !record.sessionId || !Number.isFinite(record.time)
          || typeof record.event !== "string" || (record.checkpoint && record.checkpoint.id !== record.sessionId)) {
          throw new Error(`Invalid or out-of-order audit record at byte ${completeBytes}`);
        }
        sequence = record.sequence;
        accept(record);
      }
    }
    // A crash can leave an incomplete trailing append. No complete event is discarded.
    return { sequence, completeBytes, size };
  } finally { fs.closeSync(fd); }
}

function parseCsvRecord(text: string): string[] {
  const cells: string[] = [];
  let cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) { cells.push(cell); cell = ""; }
    else cell += c;
  }
  cells.push(cell.replace(/\r$/, ""));
  return cells;
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
  private readonly carryFile: string;
  private readonly carryLog: string;
  private readonly fundingFile: string;
  private readonly auditFile: string;
  private queue: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private auditSequence = 0;
  private recovered: PersistedAuditRecord[] = [];

  get writeError(): string | null { return this.failure?.message || null; }

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
    this.carryFile = path.join(dir, "carry.json");
    this.carryLog = path.join(dir, "carry.csv");
    this.fundingFile = path.join(dir, "funding.csv");
    this.auditFile = path.join(dir, "audit.jsonl");
    // Logs written by an older version have different columns; set them aside rather than mix formats.
    for (const [file, header] of [[this.tradesFile, TRADES_HEADER], [this.hourlyFile, HOURLY_HEADER], [this.shadowFile, SHADOW_HEADER], [this.verdictFile, VERDICT_HEADER],
      [this.carryLog, CARRY_HEADER], [this.fundingFile, FUNDING_HEADER]]) {
      const first = firstLine(file) ?? header;
      if (first !== header) fs.renameSync(file, file.replace(/\.csv$/, `-old-format-${stamp()}.csv`));
    }
    const checkpoints = new Map<string, PersistedAuditRecord>();
    const audit = scanAudit(this.auditFile, (record) => { if (record.checkpoint) checkpoints.set(record.sessionId, record); });
    const sessionSequence = (readJson(this.sessionFile) as Partial<SessionFile> | null)?.auditSequence;
    // A clean reset can persist its new session before its first new audit event. Keep the sequence
    // watermark across that restart so a subsequent checkpoint is still newer than the session file.
    this.auditSequence = Math.max(audit.sequence, Number.isSafeInteger(sessionSequence) ? sessionSequence! : 0);
    this.recovered = [...checkpoints.values()];
    if (audit.completeBytes < audit.size) fs.truncateSync(this.auditFile, audit.completeBytes);
  }

  // Missing or invalid values fall back to defaults; the file is rewritten so every option is visible.
  loadConfig(): EngineConfig {
    const config = normalizeConfig(readJson(this.configFile));
    this.saveConfig(config);
    return config;
  }

  saveConfig(config: EngineConfig) { return this.saveJson(this.configFile, config); }

  loadSession(startingBalance: number): SessionFile {
    let saved = readJson(this.sessionFile) as Partial<SessionFile> | null;
    const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
    // Older sessions have a deterministic ID so later startup recovery never merges unrelated sessions.
    const savedId = saved?.id || (valid(saved?.startedAt) ? `legacy-${saved.startedAt}` : undefined);
    const candidate = this.recovered.filter((r) => !savedId || r.sessionId === savedId).sort((a, b) => b.sequence - a.sequence)[0];
    if (candidate && candidate.sequence > (saved?.auditSequence || 0)) saved = { ...candidate.checkpoint, auditSequence: candidate.sequence };
    const fresh = Store.freshSession(startingBalance);
    if (!saved || ![saved.startedAt, saved.balance, saved.scans, saved.tradeCount].every(valid)) return fresh;
    const isTally = (t: unknown): t is ShadowTally => !!t && Object.keys(emptyTally()).every((key) => valid((t as ShadowTally)[key as keyof ShadowTally]));
    const migrated = saved.accountingVersion !== 1;
    const legacyTally = saved.shadow && typeof saved.shadow === "object" ? Object.fromEntries(Object.entries(emptyTally()).map(([key, fallback]) =>
      [key, valid(saved!.shadow![key as keyof ShadowTally]) ? saved!.shadow![key as keyof ShadowTally] : fallback])) as ShadowTally : emptyTally();
    const tally = !migrated && isTally(saved.shadow) ? saved.shadow : null;
    const h = saved.hour;
    const hour = h && [h.start, h.scans, h.trades, h.pnl, h.quotes, h.scanMs, h.scanCount].every(valid) && Array.isArray(h.suspectKeys) && isTally(h.shadow)
      && [h.bestNetPct, h.bestTriangleNetPct, h.bestGrossPct].every((n) => n === null || valid(n)) ? h : undefined;
    return {
      ...saved, id: saved.id || savedId || fresh.id, accountingVersion: 1,
      startedAt: saved.startedAt!, startingBalance: valid(saved.startingBalance) ? saved.startingBalance : startingBalance,
      balance: migrated ? (valid(saved.startingBalance) ? saved.startingBalance : startingBalance) : saved.balance!,
      scans: migrated ? 0 : saved.scans!, tradeCount: migrated ? 0 : saved.tradeCount!,
      // Legacy estimates remain identifiable; the engine creates a separately funded, simulated portfolio.
      legacyEstimate: saved.legacyEstimate || (migrated ? { balance: saved.balance!, tradeCount: saved.tradeCount!, shadow: legacyTally } : undefined),
      shadowSince: tally && valid(saved.shadowSince) ? saved.shadowSince : fresh.shadowSince, shadow: tally || emptyTally(), hour: migrated ? undefined : hour,
    };
  }

  static freshSession(startingBalance: number): SessionFile {
    const now = Date.now();
    return { id: randomUUID(), accountingVersion: 1, startedAt: now, startingBalance, balance: startingBalance, scans: 0, tradeCount: 0,
      shadowSince: now, shadow: emptyTally(), pendingTrades: {} };
  }

  saveSession(session: SessionFile) { return this.saveJson(this.sessionFile, { ...session, auditSequence: this.auditSequence }); }

  appendAudit(record: AuditRecord): Promise<void> {
    if (record.version !== 1 || !record.sessionId || (record.checkpoint && record.checkpoint.id !== record.sessionId)) {
      return this.fail(new Error("Audit checkpoint does not belong to its session"));
    }
    let line: string;
    try { line = `${serialize({ ...record, sequence: ++this.auditSequence })}\n`; }
    catch (error) { return this.fail(error); }
    return this.enqueue(async () => {
      const handle = await fs.promises.open(this.auditFile, "a");
      try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(this.dir);
    });
  }

  flush(): Promise<void> { return this.queue; }

  loadListing(): Listing | null {
    const saved = readJson(this.listingFile) as Listing | null;
    return saved && Array.isArray(saved.markets) && saved.markets.length ? saved : null;
  }

  saveListing(listing: Listing) { return this.saveJson(this.listingFile, listing); }

  appendTrade(trade: TradeRecord) {
    const legs = trade.legs.map((leg) => `${leg.side} ${leg.pair} @${leg.price} ${leg.venue}`).join("; ");
    const row = [new Date(trade.time).toISOString(), trade.kind, trade.path, trade.notional, trade.grossPct,
      trade.net, trade.netPct, trade.fees, trade.conversion, trade.buffer,
      trade.ageMs, legs, trade.id].map(csvCell).join(",");
    return this.append(this.tradesFile, TRADES_HEADER, row);
  }

  appendHourly(row: HourlyRow) {
    const t = row.shadow;
    const line = [row.hour, row.scans, row.trades, row.pnl, row.bestNetPct, row.bestTriangleNetPct,
      row.bestGrossPct, row.suspectRoutes, row.quotes, row.avgScanMs, t.expected, t.realized,
      t.absError, t.filled, t.partial, t.missed, t.losses, t.unresolved, t.expectedComplete].map(csvCell).join(",");
    return this.append(this.hourlyFile, HOURLY_HEADER, line);
  }

  appendShadow(record: ShadowRecord) {
    const line = [new Date(record.time).toISOString(), record.kind, record.path, record.expectedNet, record.realizedNet,
      record.outcome, record.filledFraction, record.latencyMs, record.unwound.join("; "), record.id, record.accountingComplete, record.knownNet, record.execution].map(csvCell).join(",");
    return this.append(this.shadowFile, SHADOW_HEADER, line);
  }

  readRecentShadow(limit: number): Record<string, string>[] { return this.readCsvTail(this.shadowFile, limit); }

  appendVerdict(record: VerdictRecord) {
    const line = [new Date(record.time).toISOString(), record.group, record.key, record.path, record.kind, record.grossPct].map(csvCell).join(",");
    return this.append(this.verdictFile, VERDICT_HEADER, line);
  }

  readRecentVerdicts(limit: number): Record<string, string>[] { return this.readCsvTail(this.verdictFile, limit); }

  loadCarry(capital: number): CarryState {
    const saved = readJson(this.carryFile) as Partial<CarryState> | null;
    const fresh: CarryState = { startedAt: Date.now(), capital, cash: capital, positions: [], closed: [], lastFunding: {}, coins: [] };
    if (!saved || typeof saved.cash !== "number" || !Number.isFinite(saved.cash) || !Array.isArray(saved.positions)) return fresh;
    return { ...fresh, ...saved, closed: Array.isArray(saved.closed) ? saved.closed : [], lastFunding: saved.lastFunding || {}, coins: saved.coins || [] } as CarryState;
  }

  saveCarry(state: CarryState) { return this.saveJson(this.carryFile, state); }

  appendCarryEvent(row: { time: number; event: string; position: CarryPosition; spotPrice?: number; futuresPrice?: number; rate?: number; amount?: number; net?: number; note?: string }) {
    const p = row.position;
    const line = [new Date(row.time).toISOString(), row.event, p.id, p.coin, p.perpId, p.spotVenue, p.contracts, p.spotQty, row.spotPrice, row.futuresPrice,
      row.rate, row.amount, row.net, row.note].map(csvCell).join(",");
    return this.append(this.carryLog, CARRY_HEADER, line);
  }

  readRecentCarryEvents(limit: number): Record<string, string>[] { return this.readCsvTail(this.carryLog, limit); }

  appendFunding(row: { time: number; contract: string; coin: string; rate: number; index: number }) {
    return this.append(this.fundingFile, FUNDING_HEADER, [new Date(row.time).toISOString(), row.contract, row.coin, row.rate, row.index].map(csvCell).join(","));
  }

  readFunding(limit: number): Record<string, string>[] { return this.readCsvTail(this.fundingFile, limit); }

  readRecentTrades(limit: number): Record<string, string>[] { return this.readCsvTail(this.tradesFile, limit); }
  readRecentHours(limit: number): Record<string, string>[] { return this.readCsvTail(this.hourlyFile, limit); }

  // Rotation is itself ordered behind all queued writes; callers await it before starting a new session.
  archiveLogs(): Promise<void> {
    return this.enqueue(async () => {
      const suffix = `${stamp()}-${randomUUID().slice(0, 8)}`;
      for (const file of [this.tradesFile, this.hourlyFile, this.shadowFile, this.verdictFile, this.carryLog, this.sessionFile, this.auditFile]) {
        try { await fs.promises.rename(file, file.replace(/(\.[^.]+)$/, `-${suffix}$1`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await syncDirectory(this.dir);
      this.recovered = [];
    });
  }

  private fail(error: unknown): Promise<void> {
    // Keep preceding writes ordered even when serialization/validation fails before a new write starts.
    return this.enqueue(async () => { throw error instanceof Error ? error : new Error(String(error)); });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      await work();
    }).catch((error: unknown) => {
      this.failure ||= error instanceof Error ? error : new Error(String(error));
      throw this.failure;
    });
    // Existing reporting callers may fire-and-forget; the failure remains observable through flush/writeError.
    void next.catch(() => {});
    this.queue = next;
    return next;
  }

  private saveJson(file: string, value: unknown): Promise<void> {
    let serialized: string;
    try { serialized = serialize(value); } catch (error) { return this.fail(error); }
    return this.enqueue(() => writeJson(file, serialized));
  }

  private append(file: string, header: string, line: string): Promise<void> {
    return this.enqueue(async () => {
      const handle = await fs.promises.open(file, "a");
      try {
        const { size } = await handle.stat();
        await handle.writeFile(size ? `${line}\n` : `${header}\n${line}\n`);
      } finally { await handle.close(); }
    });
  }

  // Read a bounded suffix, locating record boundaries backwards so quoted commas/newlines stay intact.
  // CSV is a convenience view; the fsynced audit log is the durable, full-precision source of truth.
  private readCsvTail(file: string, limit: number): Record<string, string>[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    limit = Math.min(10_000, Math.floor(limit));
    const headerLine = firstLine(file);
    if (headerLine === null) return [];
    const header = parseCsvRecord(headerLine);
    const fd = fs.openSync(file, "r");
    let text: string;
    try {
      const size = fs.fstatSync(fd).size;
      const budget = Math.min(8 * 1024 * 1024, Math.max(64 * 1024, limit * 4096));
      const start = Math.max(0, size - budget);
      const bytes = Buffer.alloc(size - start);
      text = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, start)).toString("utf8");
    } finally { fs.closeSync(fd); }
    const rows: string[][] = [];
    let end = text.length, quoted = false;
    if (text.endsWith("\n")) end--;
    else return []; // An in-progress append is never reported as a completed row.
    for (let i = end - 1; i >= 0 && rows.length < limit; i--) {
      if (text[i] === '"') quoted = !quoted;
      else if (text[i] === "\n" && !quoted) {
        const cells = parseCsvRecord(text.slice(i + 1, end));
        if (cells.length === header.length) rows.push(cells);
        end = i;
      }
    }
    // If the suffix contains the whole file, the unconsumed first record is the header.
    // Otherwise it is a truncated row and must not be treated as a fill.
    return rows.map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index]])));
  }
}
