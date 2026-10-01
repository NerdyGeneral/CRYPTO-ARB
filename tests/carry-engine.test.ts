import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import type { SpotSide } from "../lib/carry";
import { Carry } from "../engine/carry";
import { carryDefaults, Store } from "../engine/store";
import futures from "./fixtures/coinbase-futures.json";

const HOUR = 3_600_000;
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// A stand-in for Coinbase: the BTC perpetual's latest funding settlement and every contract's top of book.
function fakeCoinbase() {
  const state = { fundingTime: 0, rate: 0.00002, index: 84000, book: { bid: 84090, ask: 84100 } };
  const fetchMock = async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/products?")) {
      const body = structuredClone(futures) as { products: { product_id: string; future_product_details: Record<string, unknown> }[] };
      const btc = body.products.find((p) => p.product_id === "BIP-20DEC30-CDE")!.future_product_details;
      Object.assign(btc, { funding_time: new Date(state.fundingTime).toISOString(), funding_rate: String(state.rate), index_price: String(state.index) });
      return new Response(JSON.stringify(body));
    }
    if (href.includes("/product_book?")) {
      return new Response(JSON.stringify({ pricebook: { bids: [{ price: String(state.book.bid), size: "50" }], asks: [{ price: String(state.book.ask), size: "50" }] } }));
    }
    return new Response("not found", { status: 404 });
  };
  return { state, fetchMock };
}

test("carry records unresolved funding without inventing payments and closes when funding turns negative", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carry-"));
  const originalFetch = globalThis.fetch;
  const coinbase = fakeCoinbase();
  globalThis.fetch = coinbase.fetchMock as typeof fetch;
  const start = Date.parse("2026-09-25T12:10:00Z");
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    const store = new Store(dir);
    const config = { ...carryDefaults, maxPositions: 1, minNetApr: 1, holdDays: 30 };
    const spot = (coin: string): SpotSide[] => coin === "BTC" ? [{ venue: "Binance.US", bid: 84060, ask: 84070, bidSize: 1, askSize: 1, fee: 0.0002, at: Date.now() }] : [];
    const lines: string[] = [];
    const carry = new Carry(() => config, store, spot, (line) => lines.push(line));

    // Six hourly settlements at +17.5% a year.
    for (let h = 6; h >= 1; h--) { coinbase.state.fundingTime = start - 10 * 60_000 - (h - 1) * HOUR; await carry.refreshProducts(); }
    assert.equal(store.readFunding(100).filter((row) => row.coin === "BTC").length, 6);

    await carry.tick();
    let snap = carry.snapshot(Date.now());
    assert.equal(snap.positions.length, 1, JSON.stringify(snap.perps.find((p) => p.coin === "BTC")));
    const position = snap.positions[0];
    assert.equal(position.coin, "BTC");
    assert.equal(position.contracts, 2); // $5,000 fits two contracts of about $1,683 each
    assert.equal(position.spotVenue, "Binance.US");
    close(snap.account.cash, 5000 - (0.02 * 84070 * 1.0002 + 0.02 * 84090 + 0.02 * 84090 * 0.0005));
    assert.match(lines[0], /CARRY OPEN\s+BTC/);

    // The product supplies the current index, not the settlement futures mark: no cash is fabricated.
    mock.timers.tick(50 * 60_000);
    coinbase.state.fundingTime = start + 50 * 60_000;
    await carry.refreshProducts();
    snap = carry.snapshot(Date.now());
    close(snap.positions[0].funding, 0);
    assert.equal(snap.positions[0].fundingPayments, 0);
    assert.equal(snap.positions[0].unresolvedFundingPayments, 1);
    assert.equal(snap.account.fundingComplete, false);
    assert.equal(snap.account.confirmedFunding, 0);

    // Seven hours later, after funding has been negative for the last six, it closes.
    coinbase.state.rate = -0.0001;
    for (let h = 1; h <= 7; h++) { mock.timers.tick(HOUR); coinbase.state.fundingTime += HOUR; await carry.refreshProducts(); }
    mock.timers.tick(61_000);
    await carry.tick();
    snap = carry.snapshot(Date.now());
    assert.equal(snap.positions.length, 0);
    const closed = snap.closed[0];
    assert.match(closed.closeReason!, /Funding averaged -87\.6%\/yr over 6h/);
    close(closed.funding, 0);
    assert.equal(closed.unresolvedFundingPayments, 8);
    close(snap.account.cash, 5000 + closed.realized!);
    const events = store.readRecentCarryEvents(20).map((e) => e.event);
    assert.deepEqual([...events].reverse(), ["open", ...Array(8).fill("funding_unresolved"), "close"]);
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("positions survive a restart and missing funding intervals remain unresolved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carry-"));
  const originalFetch = globalThis.fetch;
  const coinbase = fakeCoinbase();
  globalThis.fetch = coinbase.fetchMock as typeof fetch;
  const start = Date.parse("2026-09-25T12:10:00Z");
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    const config = { ...carryDefaults, maxPositions: 1, minNetApr: 1, holdDays: 30 };
    const spot = (coin: string): SpotSide[] => coin === "BTC" ? [{ venue: "Binance.US", bid: 84060, ask: 84070, bidSize: 1, askSize: 1, fee: 0.0002, at: Date.now() }] : [];
    let carry = new Carry(() => config, new Store(dir), spot, () => {});
    for (let h = 6; h >= 1; h--) { coinbase.state.fundingTime = start - 10 * 60_000 - (h - 1) * HOUR; await carry.refreshProducts(); }
    await carry.tick();
    await carry.save();

    // Stopped for three settlements; no amount is treated as confirmed without settlement marks.
    mock.timers.tick(3 * HOUR);
    coinbase.state.fundingTime = start - 10 * 60_000 + 3 * HOUR;
    carry = new Carry(() => config, new Store(dir), spot, () => {});
    await carry.refreshProducts();
    const snap = carry.snapshot(Date.now());
    assert.equal(snap.positions.length, 1);
    assert.equal(snap.positions[0].fundingPayments, 0);
    assert.equal(snap.positions[0].unresolvedFundingPayments, 3);
    assert.equal(snap.account.unresolvedFundingPayments, 3);
    assert.equal(snap.account.fundingComplete, false);
    const funding = new Store(dir).readRecentCarryEvents(5).find((e) => e.event === "funding_unresolved")!;
    assert.match(funding.note, /2 earlier interval\(s\) unobserved/);
    await carry.refreshProducts();
    assert.equal(carry.snapshot(Date.now()).account.unresolvedFundingPayments, 3, "repeated polling must not double count");
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Deterministic public books for regression checks; no account or network access.
const fixtureStores = new Set<Store>();
async function flushFixtureStores() { await Promise.all([...fixtureStores].map((s) => s.flush())); fixtureStores.clear(); }
function seededCarry(dir: string, maxPositions = 3) {
  const now = Date.now();
  const config = { ...carryDefaults, maxPositions, minNetApr: 0, futuresFee: 0.05 };
  const spot = (): SpotSide[] => [{ venue: "Coinbase", bid: 49.98, ask: 49.99, bidSize: 100, askSize: 100, fee: 0.001, at: now }];
  const store = new Store(dir);
  fixtureStores.add(store);
  const carry = new Carry(() => config, store, spot, () => {});
  for (const coin of ["BTC", "ETH", "SOL"]) {
    carry["perps"].set(coin, { id: coin, coin, contractSize: 1, price: 50, index: 50, fundingRate: 0.0001,
      fundingTime: now, intervalHours: 1, shortMargin: 0.1, openInterest: 100, volume24h: 100 });
    carry["books"].set(coin, { bid: 49.99, ask: 50, bidSize: 100, askSize: 100, at: now });
    carry["history"].set(coin, Array.from({ length: 6 }, (_, i) => ({ time: now - i * HOUR, rate: 0.0001 })));
  }
  return { carry, config, now, spot };
}

test("carry reserves remaining cash before each entry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carry-reserve-"));
  try {
    const { carry, now } = seededCarry(dir);
    carry["state"].cash = 150;
    carry["decide"](now);
    const snap = carry.snapshot(now);
    assert.equal(snap.positions.length, 1, "the same $150 must not finance three ~$100 positions");
    assert.ok(snap.account.cash >= 0);
    close(snap.account.cash, 150 - 49.99 * 1.001 - 49.99 * 1.0005);
  } finally { await flushFixtureStores(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stale books preserve the last mark across restart and unknown marks are not valued at entry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carry-mark-"));
  try {
    const { carry, config, now, spot } = seededCarry(dir, 1);
    carry["decide"](now);
    const p = carry["state"].positions[0];
    carry["books"].set(p.perpId, { bid: 54.99, ask: 55, bidSize: 100, askSize: 100, at: now });
    const before = carry.snapshot(now);
    assert.ok(before.account.pnl! < -100);
    await carry.save();
    const restarted = new Carry(() => config, new Store(dir), spot, () => {});
    const stale = restarted.snapshot(now + 91_000);
    close(stale.account.pnl!, before.account.pnl!);
    assert.equal(stale.account.valuationComplete, false);
    assert.equal(stale.positions[0].markStale, true);
    assert.equal(stale.account.apr, null);
    delete restarted["state"].positions[0].lastMark;
    assert.equal(restarted.snapshot(now + 91_000).account.equity, null);
    assert.equal(restarted.snapshot(now + 91_000).account.pnl, null);
  } finally { await flushFixtureStores(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a margin exit waits for enough depth and records the unresolved exposure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carry-exit-"));
  try {
    const { carry, now } = seededCarry(dir, 1);
    carry["decide"](now);
    const p = carry["state"].positions[0];
    assert.ok(p.contracts > 1);
    const stressed = { bid: 89.99, ask: 90, bidSize: 100, askSize: 1, at: now };
    carry["books"].set(p.perpId, stressed);
    assert.equal(carry["closePositions"](now), false);
    let snap = carry.snapshot(now);
    assert.equal(snap.positions.length, 1);
    assert.equal(snap.closed.length, 0);
    assert.match(snap.positions[0].exitBlocked!, /insufficient top-of-book/);
    assert.equal(snap.account.valuationComplete, false);
    carry["books"].set(p.perpId, { ...stressed, askSize: p.contracts });
    assert.equal(carry["closePositions"](now), true);
    snap = carry.snapshot(now);
    assert.equal(snap.positions.length, 0);
    assert.equal(snap.closed.length, 1);
    assert.ok(snap.closed[0].realized! < 0);
  } finally { await flushFixtureStores(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("lifetime fees survive pruning more than 100 closes and restarting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carry-totals-"));
  try {
    const { carry, config, now, spot } = seededCarry(dir, 1);
    let expectedFees = 0;
    for (let i = 0; i < 105; i++) {
      carry["decide"](now);
      const p = carry["state"].positions[0];
      assert.ok(p);
      const mark = carry.snapshot(now).positions[0].mark!;
      expectedFees += p.fees + mark.exitFees;
      carry["close"](p, 49.98, 50, mark.value, "test round trip", now);
    }
    await carry.save();
    assert.equal(carry["state"].closed.length, 100);
    close(carry.snapshot(now).account.fees, expectedFees);
    const restored = new Carry(() => config, new Store(dir), spot, () => {});
    close(restored.snapshot(now).account.fees, expectedFees);
  } finally { await flushFixtureStores(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("carry polling is bounded, prioritizes open positions, and rechecks the current decision time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carry-poll-"));
  const originalFetch = globalThis.fetch;
  try {
    const { carry, now } = seededCarry(dir, 1);
    carry["decide"](now);
    const openId = carry["state"].positions[0].perpId;
    // Put the open contract last in discovery order; polling must still prioritize it.
    const entry = carry["perps"].get(openId)!;
    carry["perps"].delete(openId);
    carry["perps"].set(openId, entry);
    carry["books"].clear();
    let active = 0, maximum = 0;
    const order: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      order.push(new URL(String(url)).searchParams.get("product_id")!);
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      active--;
      return new Response(JSON.stringify({ pricebook: { bids: [{ price: "49.99", size: "100" }], asks: [{ price: "50", size: "100" }] } }));
    }) as typeof fetch;
    await carry["pollBooks"](now);
    assert.equal(order[0], openId);
    assert.equal(maximum, 3);

    const start = now + 1_000;
    mock.timers.enable({ apis: ["Date"], now: start });
    carry["productsAt"] = start;
    carry["lastHourFetched"] = Math.floor(start / HOUR);
    let decisionAt = 0;
    carry["pollBooks"] = async () => { mock.timers.tick(120_000); };
    carry["decide"] = (at: number) => { decisionAt = at; };
    await carry.tick();
    assert.equal(decisionAt, start + 120_000);
  } finally {
    mock.timers.reset(); globalThis.fetch = originalFetch;
    await flushFixtureStores();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy funding estimates are excluded from confirmed totals and migration is idempotent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carry-legacy-"));
  try {
    const { carry, config, now, spot } = seededCarry(dir, 1);
    carry["decide"](now);
    const state = carry["state"];
    state.positions[0].funding = 10;
    state.positions[0].fundingPayments = 2;
    delete state.accounting;
    await carry.save();
    const restored = new Carry(() => config, new Store(dir), spot, () => {});
    let snap = restored.snapshot(now);
    assert.equal(snap.account.confirmedFunding, 0);
    assert.equal(snap.positions[0].funding, 0);
    assert.equal(snap.account.legacyFundingEstimate, 10);
    assert.equal(snap.account.fundingComplete, false);
    assert.equal(snap.account.historyComplete, false);
    await restored.save();
    snap = new Carry(() => config, new Store(dir), spot, () => {}).snapshot(now);
    assert.equal(snap.account.legacyFundingEstimate, 10);
    assert.equal(snap.account.unresolvedFundingPayments, 2);
    assert.equal(snap.positions[0].fundingPayments, 0);
  } finally { await flushFixtureStores(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("closing before the funding refresh preserves the unobserved hourly liability", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carry-close-funding-"));
  try {
    const { carry, now } = seededCarry(dir, 1);
    carry["decide"](now);
    const p = carry["state"].positions[0];
    const mark = carry.snapshot(now).positions[0].mark!;
    const afterBoundary = (Math.floor(now / HOUR) + 1) * HOUR + 1;
    carry["close"](p, 49.98, 50, mark.value, "test close before refresh", afterBoundary);
    await carry.save();
    const snap = carry.snapshot(afterBoundary);
    assert.equal(snap.closed[0].unresolvedFundingPayments, 1);
    assert.equal(snap.account.unresolvedFundingPayments, 1);
    assert.equal(snap.account.fundingComplete, false);
    assert.equal(snap.account.confirmedFunding, 0);
    // Seeing that rate later must not count the same unknown settlement twice.
    carry["settle"]({ ...carry["perps"].get(p.perpId)!, fundingTime: afterBoundary - 1 });
    assert.equal(carry.snapshot(afterBoundary).account.unresolvedFundingPayments, 1);
  } finally { await flushFixtureStores(); fs.rmSync(dir, { recursive: true, force: true }); }
});
