import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store, type AuditRecord, type TradeRecord } from "../engine/store";

function fixture(t: { after: (callback: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-store-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return { dir, store: new Store(dir) };
}
const trade = (id = "trade-1", route = "BTC Coinbase → Kraken"): TradeRecord => ({
  id, time: 1_700_000_000_000, key: "route", kind: "cross", coin: "BTC", venues: ["Coinbase", "Kraken"],
  path: route, legs: [], notional: 10.123456789012345, grossPct: 2.123456789, net: 0.1234567890123456,
  netPct: 1.1, fees: 0.0000000000123, conversion: 0, buffer: 0, ageMs: 0.123,
  suspect: false,
});

test("audit snapshots are immutable, ordered, full precision and recover newer trade state after a crash", async (t) => {
  const { dir, store } = fixture(t), session = Store.freshSession(500);
  await store.saveSession(session);
  const checkpoint = { ...session, balance: 500.1234567890123, pendingTrades: { pending: trade() } };
  const payload = { fillQty: 0.00000012345678901234, price: 10.1234567891234 };
  const first = store.appendAudit({ version: 1, event: "reservation", sessionId: session.id, tradeId: "pending", time: 1, payload, checkpoint });
  checkpoint.balance = 999;
  payload.fillQty = 999;
  const second = store.appendAudit({ version: 1, event: "observation", sessionId: session.id, time: 2, payload: { value: 2 } });
  await Promise.all([first, second]);
  const records = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((r) => JSON.parse(r));
  assert.deepEqual(records.map((r) => r.sequence), [1, 2]);
  assert.equal(records[0].payload.fillQty, 0.00000012345678901234);
  assert.equal(records[0].checkpoint.balance, 500.1234567890123);
  const recovered = new Store(dir).loadSession(500);
  assert.equal(recovered.balance, 500.1234567890123);
  assert.equal(recovered.auditSequence, 1);
  assert.equal(recovered.pendingTrades!.pending.key, "route");
  assert.equal(recovered.id, session.id);
});

test("recovery never replaces a newer snapshot or mixes checkpoints from another session", async (t) => {
  const { dir, store } = fixture(t), current = Store.freshSession(500), other = Store.freshSession(500);
  await store.appendAudit({ version: 1, event: "first", time: 1, sessionId: current.id, payload: {}, checkpoint: { ...current, scans: 1 } });
  await store.saveSession({ ...current, scans: 10 });
  await store.appendAudit({ version: 1, event: "unrelated", time: 2, sessionId: other.id, payload: {}, checkpoint: { ...other, scans: 99 } });
  const recovered = new Store(dir).loadSession(500);
  assert.equal(recovered.id, current.id);
  assert.equal(recovered.scans, 10);
});

test("only an incomplete crash tail is discarded and the next append is recoverable", async (t) => {
  const { dir, store } = fixture(t), session = Store.freshSession(500);
  await store.appendAudit({ version: 1, event: "initial", time: 1, sessionId: session.id, payload: {}, checkpoint: session });
  fs.appendFileSync(path.join(dir, "audit.jsonl"), '{"version":1,"sequence":2');
  const recovered = new Store(dir);
  assert.equal(recovered.loadSession(500).id, session.id);
  await recovered.appendAudit({ version: 1, event: "next", time: 2, sessionId: session.id, payload: {}, checkpoint: { ...session, scans: 8 } });
  assert.equal(new Store(dir).loadSession(500).scans, 8);
  const lines = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n");
  assert.deepEqual(lines.map((line) => JSON.parse(line).sequence), [1, 2]);
});

test("complete corrupt or out-of-order audit records fail visibly instead of being skipped", async (t) => {
  const { dir, store } = fixture(t), session = Store.freshSession(500);
  await store.appendAudit({ version: 1, event: "initial", time: 1, sessionId: session.id, payload: {}, checkpoint: session });
  const file = path.join(dir, "audit.jsonl"), first = fs.readFileSync(file, "utf8");
  fs.appendFileSync(file, first);
  assert.throws(() => new Store(dir), /out-of-order/);
});

test("reset archives queued events before new writes and cannot recover the previous session", async (t) => {
  const { dir, store } = fixture(t), oldSession = Store.freshSession(500);
  const pending = store.appendAudit({ version: 1, event: "old", time: 1, sessionId: oldSession.id, payload: {}, checkpoint: oldSession });
  const csv = store.appendTrade(trade("old-trade"));
  const saved = store.saveSession(oldSession);
  await store.archiveLogs();
  await Promise.all([pending, csv, saved]);
  const fresh = Store.freshSession(250);
  await store.saveSession(fresh);
  await store.appendAudit({ version: 1, event: "new", time: 2, sessionId: fresh.id, payload: {}, checkpoint: fresh });
  await store.appendTrade(trade("new-trade"));
  await store.flush();
  assert.equal(new Store(dir).loadSession(250).id, fresh.id);
  assert.deepEqual(store.readRecentTrades(10).map((r) => r.trade_id), ["new-trade"]);
  assert.ok(fs.readdirSync(dir).some((f) => /^audit-.+\.jsonl$/.test(f)));
  assert.ok(fs.readdirSync(dir).some((f) => /^session-.+\.json$/.test(f)));
});

test("audit I/O failure rejects, poisons subsequent writes and remains visible through flush", async (t) => {
  const { dir, store } = fixture(t), session = Store.freshSession(500);
  fs.mkdirSync(path.join(dir, "audit.jsonl"));
  await assert.rejects(store.appendAudit({ version: 1, event: "failure", time: 1, sessionId: session.id, payload: {} }));
  assert.ok(store.writeError);
  await assert.rejects(store.flush());
  await assert.rejects(store.saveSession(session));
  assert.equal(fs.existsSync(path.join(dir, "session.json")), false);
});

test("restart between reset and first event preserves the session sequence watermark", async (t) => {
  const { dir, store } = fixture(t), previous = Store.freshSession(500);
  await store.appendAudit({ version: 1, event: "old", time: 1, sessionId: previous.id, payload: {}, checkpoint: previous });
  await store.archiveLogs();
  const current = Store.freshSession(500);
  await store.saveSession(current);
  const restarted = new Store(dir);
  await restarted.appendAudit({ version: 1, event: "new", time: 2, sessionId: current.id, payload: {}, checkpoint: { ...current, scans: 9 } });
  assert.equal(new Store(dir).loadSession(500).scans, 9);
});

test("invalid values cannot be silently converted to null in the audit", async (t) => {
  const { dir, store } = fixture(t), session = Store.freshSession(500);
  const first = store.appendAudit({ version: 1, event: "valid", time: 1, sessionId: session.id, payload: { qty: 1 } });
  const bad: AuditRecord = { version: 1, event: "invalid", time: 2, sessionId: session.id, payload: { qty: NaN } };
  await assert.rejects(store.appendAudit(bad), /non-finite/);
  await first;
  assert.equal(fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("CSV tails handle commas, quotes, multiline cells and full precision", async (t) => {
  const { store } = fixture(t), route = 'BTC, "quoted" route\nsecond line';
  await Promise.all([store.appendTrade(trade("first", route)), store.appendTrade(trade("second", "normal"))]);
  const rows = store.readRecentTrades(2);
  assert.deepEqual(rows.map((r) => r.trade_id), ["second", "first"]);
  assert.equal(rows[1].path, route);
  assert.equal(Number(rows[1].net_usd), trade().net);
  assert.equal(Number(rows[1].fees_usd), trade().fees);
  assert.deepEqual(store.readRecentTrades(0), []);
});

test("legacy shadow totals are retained once as legacy estimates and excluded from new accounting", async (t) => {
  const { dir } = fixture(t);
  const oldShadow = { filled: 2, partial: 1, missed: 0, expected: 4, realized: 3, absError: 1, losses: 0 };
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ startedAt: 1234, startingBalance: 500, balance: 503, scans: 10, tradeCount: 3, shadow: oldShadow }));
  const loaded = new Store(dir).loadSession(500);
  assert.equal(loaded.id, "legacy-1234");
  assert.equal(loaded.legacyEstimate!.balance, 503);
  assert.equal(loaded.legacyEstimate!.shadow.realized, 3);
  assert.equal(loaded.accountingVersion, 1);
  assert.equal(loaded.balance, 500);
  assert.equal(loaded.tradeCount, 0);
  assert.equal(loaded.scans, 0);
  assert.equal(loaded.shadow.realized, 0);
  assert.equal(loaded.shadow.filled, 0);
  loaded.balance = 501;
  loaded.tradeCount = 1;
  loaded.shadow.realized = 1;
  loaded.shadow.filled = 1;
  await new Store(dir).saveSession(loaded);
  const next = new Store(dir).loadSession(500);
  assert.equal(next.balance, 501);
  assert.equal(next.tradeCount, 1);
  assert.equal(next.shadow.realized, 1);
  assert.equal(next.shadow.filled, 1);
  assert.equal(next.legacyEstimate!.shadow.realized, 3);
});
