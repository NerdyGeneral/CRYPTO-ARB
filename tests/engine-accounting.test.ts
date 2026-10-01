import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Engine } from "../engine/engine";
import { normalizeConfig, Store, type SessionFile } from "../engine/store";
import { keyOf, makeMarket, type Market } from "../lib/markets";
import type { Quote } from "../lib/market";
import { indexRoutes, type Leg, type Opportunity, type RouteIndex } from "../lib/opportunities";
import * as wallet from "../lib/portfolio";

type Internals = {
  markets: Market[]; marketByKey: Map<string, Market>; quotes: Map<string, Quote>;
  latency: { percentile: () => number }; orderPrepMs: number;
  activeSimulations: Set<Promise<void>>;
  index: RouteIndex;
  react: (market: Market) => void;
  scan: () => void;
  prepareTrade: (trade: Opportunity) => Opportunity | null;
  executeTrade: (trade: Opportunity, now: number, decisionMs: number) => void;
};
const config = () => normalizeConfig({ version: 2, venues: ["Coinbase", "Kraken"], startingBalance: 500,
  settings: { budget: 10, coinbaseFee: 0, krakenFee: 0, buffer: 0, minNet: 0, maxGap: 40 }, carry: { enabled: false } });
function fixture(t: TestContext, initialConfig = config()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-engine-accounting-"));
  const store = new Store(dir), engine = new Engine(initialConfig, store), internals = engine as unknown as Internals;
  internals.latency.percentile = () => 0;
  internals.orderPrepMs = 0;
  t.after(async () => { await engine.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, engine, internals };
}
function install(internals: Internals, market: Market, bid: number, ask: number, size = 20) {
  if (!internals.marketByKey.has(keyOf(market))) internals.markets.push(market);
  internals.marketByKey.set(keyOf(market), market);
  internals.quotes.set(keyOf(market), { bid, ask, bidSize: size, askSize: size, receivedAt: Date.now(), source: "stream" });
}
function leg(market: Market, side: "buy" | "sell", price: number, qty: number): Leg {
  return { venue: market.venue, pair: `${market.base}/${market.quote}`, base: market.base, quote: market.quote,
    side, price, qty, fee: 0, market: keyOf(market), size: 20 };
}
function opportunity(legs: Leg[], kind: "cross" | "triangle", net: number): Opportunity {
  return { key: `test-${kind}`, kind, coin: "BTC", venues: [...new Set(legs.map(l => l.venue))], path: "test route",
    legs, notional: 10, grossPct: net * 10, net, netPct: net * 10, fees: 0, conversion: 0, buffer: 0, ageMs: 0, suspect: false };
}
const crossMarkets = () => [makeMarket("Coinbase", "BTC", "USD"), makeMarket("Kraken", "BTC", "USD")];
function audit(dir: string) {
  const file = path.join(dir, "audit.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("engine requires venue-funded inventory and audits cross execution against actual simulated fills", async t => {
  const { engine, internals, dir, store } = fixture(t), [buy, sell] = crossMarkets();
  install(internals, buy, 9.9, 10);
  install(internals, sell, 11, 11.1);
  const trade = opportunity([leg(buy, "buy", 10, 1), leg(sell, "sell", 11, 1)], "cross", 1);
  assert.equal(internals.prepareTrade(trade), null, "an unfunded sell venue must not simulate a short");
  await engine.tradeInventory(keyOf(sell), "buy", 1);
  assert.ok(internals.prepareTrade(trade));
  internals.executeTrade(trade, Date.now(), 0);
  await Promise.all([...internals.activeSimulations]);
  await store.flush();
  assert.equal(engine.session.tradeCount, 1);
  assert.equal(engine.session.shadow.realized, 1);
  const state = engine.state();
  assert.equal(state.portfolio.balances.Coinbase.BTC, 1);
  assert.equal(state.portfolio.balances.Kraken.BTC, 0);
  assert.equal(state.portfolio.balances.Coinbase.USD, 240);
  assert.ok(Math.abs(state.portfolio.balances.Kraken.USD - 249.9) < 1e-10);
  const records = audit(dir), result = records.find(row => row.event === "simulation_result");
  assert.equal(result.payload.result.realizedNet, 1);
  assert.equal(result.payload.result.execution, "simulated");
  assert.equal(result.payload.result.fills.length, 2);
  assert.ok(result.tradeId);
  assert.equal(records.find(row => row.event === "simulation_intent").tradeId, result.tradeId);
  assert.deepEqual(new Store(dir).loadSession(500).portfolio!.balances, state.portfolio.balances);
});

test("triangle execution funds each next leg from preceding fills without prefunded intermediary coins", async t => {
  const { engine, internals, dir, store } = fixture(t);
  const a = makeMarket("Coinbase", "BTC", "USD"), b = makeMarket("Coinbase", "ETH", "BTC"), c = makeMarket("Coinbase", "ETH", "USD");
  install(internals, a, 9.9, 10); install(internals, b, 0.49, 0.5); install(internals, c, 6, 6.1);
  const trade = opportunity([leg(a, "buy", 10, 1), leg(b, "buy", 0.5, 2), leg(c, "sell", 6, 2)], "triangle", 2);
  assert.ok(internals.prepareTrade(trade));
  assert.equal(engine.state().portfolio.balances.Coinbase.BTC, undefined);
  internals.executeTrade(trade, Date.now(), 0);
  await Promise.all([...internals.activeSimulations]);
  await store.flush();
  assert.equal(engine.session.tradeCount, 1);
  assert.equal(engine.session.shadow.realized, 2);
  const balance = engine.state().portfolio.balances.Coinbase;
  assert.equal(balance.USD, 252);
  assert.equal(balance.BTC, 0);
  assert.equal(balance.ETH, 0);
  const result = audit(dir).find(row => row.event === "simulation_result");
  assert.deepEqual(result.payload.result.fills.map((fill: { filledQty: number }) => fill.filledQty), [1, 2, 2]);
  assert.equal(result.payload.result.accountingComplete, true);
});

test("a triangle whose first leg misses records zero fills, releases funds and keeps the bot running", async t => {
  const { engine, internals, dir, store } = fixture(t);
  const a = makeMarket("Coinbase", "BTC", "USD"), b = makeMarket("Coinbase", "ETH", "BTC"), c = makeMarket("Coinbase", "ETH", "USD");
  install(internals, a, 9.9, 10); install(internals, b, 0.49, 0.5); install(internals, c, 6, 6.1);
  const trade = opportunity([leg(a, "buy", 10, 1), leg(b, "buy", 0.5, 2), leg(c, "sell", 6, 2)], "triangle", 2);
  assert.ok(internals.prepareTrade(trade));
  // The first market moves above the submitted limit before arrival. Later legs have no proceeds to spend.
  install(internals, a, 10.9, 11);
  internals.executeTrade(trade, Date.now(), 0);
  await Promise.all([...internals.activeSimulations]);
  await store.flush();
  const state = engine.state();
  assert.equal(state.running, true);
  assert.equal(state.auditError, null);
  assert.equal(state.portfolio.pending, 0);
  assert.equal(state.portfolio.available.Coinbase.USD, 250);
  assert.deepEqual(engine.session.pendingTrades, {});
  assert.equal(engine.session.shadow.missed, 1);
  assert.equal(engine.session.shadow.realized, 0);
  const result = audit(dir).find(row => row.event === "simulation_result");
  assert.deepEqual(result.payload.result.fills.map((fill: { filledQty: number }) => fill.filledQty), [0, 0, 0]);
  assert.equal(result.payload.result.realizedNet, 0);
  assert.equal(result.payload.result.accountingComplete, true);
  // A subsequent executable triangle can use the released cash and complete normally.
  install(internals, a, 9.9, 10);
  internals.executeTrade(trade, Date.now(), 0);
  await Promise.all([...internals.activeSimulations]);
  assert.equal(engine.session.shadow.filled, 1);
  assert.equal(engine.session.shadow.realized, 2);
  assert.equal(engine.state().portfolio.available.Coinbase.USD, 252);
});

test("portfolio valuation includes inventory spread and both fees; a stale local mark makes P&L unknown", async t => {
  const options = config();
  options.settings.coinbaseFee = 1;
  const { engine, internals } = fixture(t, options), market = makeMarket("Coinbase", "BTC", "USD");
  install(internals, market, 9, 10);
  await engine.tradeInventory(keyOf(market), "buy", 2);
  const position = engine.state().portfolio;
  // Buy: 2*10 + 1% fee = $20.20. Exit valuation: 2*9 less 1% fee = $17.82.
  assert.equal(position.valuationComplete, true);
  assert.ok(Math.abs(position.equity! - 497.62) < 1e-10);
  assert.ok(Math.abs(position.pnl! - (-2.38)) < 1e-10);
  assert.equal(position.balances.Coinbase.BTC, 2);
  const book = internals.quotes.get(keyOf(market))!;
  internals.quotes.set(keyOf(market), { ...book, receivedAt: Date.now() - 20_000 });
  const stale = engine.state().portfolio;
  assert.equal(stale.valuationComplete, false);
  assert.equal(stale.equity, null);
  assert.equal(stale.pnl, null);
  assert.deepEqual(stale.missing, ["Coinbase: BTC has no fresh USD mark"]);
  assert.equal(stale.balances.Coinbase.BTC, 2, "a missing price must not remove the actual holding");
  install(internals, market, 9, 10);
  assert.ok(Math.abs(engine.state().portfolio.pnl! - (-2.38)) < 1e-10);
});

test("manual inventory cannot reuse unchanged one-coin liquidity but a changed book permits another fill", async t => {
  const { engine, internals, store, dir } = fixture(t), market = makeMarket("Coinbase", "BTC", "USD");
  install(internals, market, 9.9, 10, 1);
  const first = await engine.tradeInventory(keyOf(market), "buy", 1);
  assert.equal(first.fill.filledQty, 1);
  await assert.rejects(engine.tradeInventory(keyOf(market), "buy", 1), /already used/);
  // A newer timestamp alone does not prove the consumed displayed liquidity replenished.
  install(internals, market, 9.9, 10, 1);
  await assert.rejects(engine.tradeInventory(keyOf(market), "buy", 1), /already used/);
  assert.equal(engine.state().portfolio.balances.Coinbase.BTC, 1);
  assert.equal(engine.state().portfolio.balances.Coinbase.USD, 240);
  assert.equal(engine.state().portfolio.pending, 0);
  install(internals, market, 9.9, 10, 2);
  const next = await engine.tradeInventory(keyOf(market), "buy", 1);
  assert.equal(next.fill.filledQty, 1);
  assert.equal(engine.state().portfolio.balances.Coinbase.BTC, 2);
  assert.equal(engine.state().portfolio.balances.Coinbase.USD, 230);
  await store.flush();
  assert.equal(audit(dir).filter(row => row.event === "inventory_result").length, 2);
});

test("reset waits for an inventory intent awaiting persistence and cancels it without a new-session fill", async t => {
  const { engine, internals, store, dir } = fixture(t), market = makeMarket("Coinbase", "BTC", "USD");
  install(internals, market, 9.9, 10, 1);
  const gate = deferred(), entered = deferred(), original = store.appendAudit.bind(store);
  store.appendAudit = async record => {
    if (record.event === "inventory_intent") { entered.release(); await gate.promise; }
    return original(record);
  };
  const inventory = engine.tradeInventory(keyOf(market), "buy", 1);
  const cancelled = assert.rejects(inventory, /Session changed/);
  await entered.promise;
  assert.equal(engine.state().portfolio.pending, 1);
  const oldId = engine.session.id;
  let completed = false;
  const resetting = engine.resetSession().then(() => { completed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false, "reset must await in-flight manual inventory before rotating logs");
  } finally {
    gate.release();
    await Promise.all([cancelled, resetting]);
  }
  await store.flush();
  const state = engine.state();
  assert.notEqual(engine.session.id, oldId);
  assert.equal(state.portfolio.pending, 0);
  assert.equal(state.portfolio.balances.Coinbase.USD, 250);
  assert.equal(state.portfolio.balances.Coinbase.BTC, undefined);
  assert.equal(audit(dir).some(row => row.event === "inventory_result"), false);
  assert.deepEqual(new Store(dir).loadSession(500).portfolio!.reservations, {});
});

test("reset waits out pending replay and no old trade or profit leaks into the new session", async t => {
  const { engine, internals, store, dir } = fixture(t), [buy, sell] = crossMarkets();
  install(internals, buy, 9.9, 10); install(internals, sell, 11, 11.1);
  await engine.tradeInventory(keyOf(sell), "buy", 1);
  internals.latency.percentile = () => 30;
  const oldId = engine.session.id;
  internals.executeTrade(opportunity([leg(buy, "buy", 10, 1), leg(sell, "sell", 11, 1)], "cross", 1), Date.now(), 0);
  await engine.resetSession();
  await store.flush();
  assert.notEqual(engine.session.id, oldId);
  assert.equal(engine.session.tradeCount, 0);
  assert.equal(engine.session.shadow.realized, 0);
  assert.equal(engine.state().portfolio.pending, 0);
  assert.equal(engine.state().shadow.recent.length, 0);
  assert.equal(engine.state().trades.length, 0);
  assert.equal(engine.state().portfolio.balances.Coinbase.USD, 250);
  assert.equal(engine.state().portfolio.balances.Kraken.USD, 250);
  assert.ok(audit(dir).every(row => row.sessionId !== oldId));
  assert.equal(new Store(dir).loadSession(500).id, engine.session.id);
});

test("resume and execution controls cannot create a reservation while reset is awaiting storage", async t => {
  const { engine, internals, store } = fixture(t), [buy, sell] = crossMarkets();
  install(internals, buy, 9.9, 10); install(internals, sell, 11, 11.1);
  await engine.tradeInventory(keyOf(sell), "buy", 1);
  const entered = deferred(), gate = deferred(), original = store.archiveLogs.bind(store);
  store.archiveLogs = async () => { entered.release(); await gate.promise; return original(); };
  const reset = engine.resetSession();
  await entered.promise;
  try {
    engine.setRunning(true);
    assert.equal(engine.running, false);
    internals.executeTrade(opportunity([leg(buy, "buy", 10, 1), leg(sell, "sell", 11, 1)], "cross", 1), Date.now(), 0);
    assert.equal(internals.activeSimulations.size, 0);
    assert.equal(engine.state().portfolio.pending, 0);
    assert.deepEqual(engine.session.pendingTrades, {});
  } finally {
    gate.release();
    await reset;
  }
  assert.equal(engine.session.tradeCount, 0);
  assert.equal(engine.state().portfolio.pending, 0);
});

test("shutdown overlapping reset waits for rotation and cannot be undone by the reset resume state", async t => {
  const { engine, internals, store, dir } = fixture(t), entered = deferred(), gate = deferred();
  const original = store.archiveLogs.bind(store);
  store.archiveLogs = async () => { entered.release(); await gate.promise; return original(); };
  const reset = engine.resetSession();
  await entered.promise;
  let completed = false;
  const stopping = engine.stop().then(() => { completed = true; });
  try {
    engine.setRunning(true);
    assert.equal(engine.running, false);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false, "shutdown must wait for the reset's final durable state");
  } finally {
    gate.release();
    await Promise.all([reset, stopping]);
  }
  assert.equal(engine.running, false);
  engine.setRunning(true);
  assert.equal(engine.running, false);
  assert.equal(internals.activeSimulations.size, 0);
  assert.equal(new Store(dir).loadSession(500).id, engine.session.id);
  await assert.rejects(engine.resetSession());
});

for (const trigger of ["react", "scan"] as const) {
  test(`${trigger} ranks routes by funded profit instead of their larger unfunded estimate`, async t => {
    const options = config();
    options.venues = ["Coinbase", "Kraken", "Gemini"];
    options.settings.budget = 100;
    options.settings.geminiFee = 0;
    options.triangular = false;
    const { engine, internals, store, dir } = fixture(t, options);
    const buy = makeMarket("Coinbase", "BTC", "USD"), high = makeMarket("Kraken", "BTC", "USD"), funded = makeMarket("Gemini", "BTC", "USD");
    install(internals, buy, 9.9, 10); install(internals, high, 12, 12.1); install(internals, funded, 11, 11.1);
    // Kraken's nominal $20 route can sell only one coin, earning $2. Gemini can sell ten, earning $10.
    await engine.tradeInventory(keyOf(high), "buy", 1);
    await engine.tradeInventory(keyOf(funded), "buy", 10);
    internals.index = indexRoutes(internals.markets);
    engine.ready = true;
    if (trigger === "react") internals.react(buy); else internals.scan();
    await Promise.all([...internals.activeSimulations]);
    await store.flush();
    const result = audit(dir).find(row => row.event === "simulation_result");
    assert.ok(result, "a funded route should execute");
    assert.deepEqual(result.payload.trade.venues, ["Coinbase", "Gemini"]);
    assert.equal(result.payload.trade.legs[0].qty, 10);
    assert.equal(result.payload.result.realizedNet, 10);
  });
}

test("stop does not complete before the final session snapshot is durably saved", async t => {
  const { engine, store, dir } = fixture(t), gate = deferred(), entered = deferred();
  const original = store.saveSession.bind(store);
  store.saveSession = async (snapshot: SessionFile) => { entered.release(); await gate.promise; return original(snapshot); };
  let stopped = false;
  const stopping = engine.stop().then(() => { stopped = true; });
  await entered.promise;
  assert.equal(stopped, false);
  gate.release();
  await stopping;
  assert.equal(new Store(dir).loadSession(500).id, engine.session.id);
});

test("restart cancels interrupted paper reservations and records linked recovery evidence", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-engine-restart-")), store = new Store(dir);
  const session = Store.freshSession(500), [buy] = crossMarkets();
  const order = leg(buy, "buy", 10, 1), id = "interrupted-paper-trade";
  const portfolio = wallet.reserve(wallet.initialPortfolio(500, ["Coinbase", "Kraken"]), id, [order]).state;
  session.portfolio = portfolio;
  session.pendingTrades = { [id]: opportunity([order], "cross", 1) };
  await store.appendAudit({ version: 1, event: "simulation_intent", sessionId: session.id, tradeId: id, time: Date.now(), payload: {}, checkpoint: session });
  const recoveredStore = new Store(dir), engine = new Engine(config(), recoveredStore);
  t.after(async () => { await engine.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await recoveredStore.flush();
  assert.equal(engine.state().portfolio.pending, 0);
  assert.equal(engine.session.tradeCount, 0);
  assert.equal(engine.state().portfolio.available.Coinbase.USD, 250);
  assert.deepEqual(engine.session.pendingTrades, {});
  const recovery = audit(dir).find(row => /recover|cancel|abandon/.test(row.event));
  assert.ok(recovery, "abandoned intent must have durable cancellation/recovery evidence");
  assert.ok(JSON.stringify(recovery).includes(id), "evidence must identify the interrupted trade");
  assert.equal(new Store(dir).loadSession(500).portfolio!.reservations[id], undefined);
});
