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

test("the carry opens after enough funding history, collects each settlement and closes when funding turns negative", async () => {
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

    // The next settlement pays the short 2 × 0.01 BTC × index × rate.
    mock.timers.tick(50 * 60_000);
    coinbase.state.fundingTime = start + 50 * 60_000;
    await carry.refreshProducts();
    snap = carry.snapshot(Date.now());
    close(snap.positions[0].funding, 0.02 * 84000 * 0.00002);
    assert.equal(snap.positions[0].fundingPayments, 1);

    // Seven hours later, after funding has been negative for the last six, it closes.
    coinbase.state.rate = -0.0001;
    for (let h = 1; h <= 7; h++) { mock.timers.tick(HOUR); coinbase.state.fundingTime += HOUR; await carry.refreshProducts(); }
    mock.timers.tick(61_000);
    await carry.tick();
    snap = carry.snapshot(Date.now());
    assert.equal(snap.positions.length, 0);
    const closed = snap.closed[0];
    assert.match(closed.closeReason!, /Funding averaged -87\.6%\/yr over 6h/);
    close(closed.funding, 0.02 * 84000 * (0.00002 - 7 * 0.0001));
    close(snap.account.cash, 5000 + closed.realized!);
    const events = store.readRecentCarryEvents(20).map((e) => e.event);
    assert.deepEqual([...events].reverse(), ["open", "funding", "funding", "funding", "funding", "funding", "funding", "funding", "funding", "close"]);
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("positions survive a restart, and hours settled while stopped are noted, not counted", async () => {
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
    carry.save();

    // Stopped for three settlements; after the restart only the latest is paid.
    mock.timers.tick(3 * HOUR);
    coinbase.state.fundingTime = start - 10 * 60_000 + 3 * HOUR;
    carry = new Carry(() => config, new Store(dir), spot, () => {});
    await carry.refreshProducts();
    const snap = carry.snapshot(Date.now());
    assert.equal(snap.positions.length, 1);
    assert.equal(snap.positions[0].fundingPayments, 1);
    const funding = new Store(dir).readRecentCarryEvents(5).find((e) => e.event === "funding")!;
    assert.match(funding.note, /2 earlier hour\(s\) missed while stopped/);
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
