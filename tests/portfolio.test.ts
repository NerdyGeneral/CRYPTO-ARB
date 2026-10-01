import assert from "node:assert/strict";
import { test } from "node:test";
import type { Leg } from "../lib/opportunities";
import type { LegFill } from "../lib/shadow";
import { applyFills, available, cancel, canReserve, initialPortfolio, reserve, settle, settleSequence, type PortfolioResult, type PortfolioState } from "../lib/portfolio";

const leg = (venue: Leg["venue"], side: Leg["side"], qty = 1, price = 10, fee = 0.01, base = "BTC", quote = "USD"): Leg =>
  ({ venue, side, qty, price, fee, base, quote, market: `${venue}|${base}/${quote}`, pair: `${base}/${quote}`, size: qty });
const fill = (order: Leg, qty = order.qty, price: number | null = order.price): LegFill => ({
  leg: order, filledQty: qty, price, feeAmount: qty * (price || 0) * order.fee, feeCurrency: order.quote, book: null, observedAt: 0,
});
const success = (result: PortfolioResult) => { assert.equal(result.ok, true, result.reason); return result.state; };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-10, `${a} differs from ${b}`);
const fundCoin = (state: PortfolioState, venue: Leg["venue"], qty = 1) => {
  const order = leg(venue, "buy", qty);
  return success(settle(success(reserve(state, `inventory-${venue}`, [order])), `inventory-${venue}`, [fill(order)]));
};

test("starting capital is distributed once; no coin inventory or cross-venue cash is invented", () => {
  const state = initialPortfolio(100, ["Kraken", "Coinbase", "Kraken"]);
  assert.deepEqual(state.balances, { Kraken: { USD: 50 }, Coinbase: { USD: 50 } });
  assert.equal(available(state, "Kraken", "BTC"), 0);
  assert.equal(canReserve(state, [leg("Kraken", "buy", 6)]).ok, false);
  assert.equal(canReserve(state, [leg("Coinbase", "sell")]).ok, false);
});

test("cross orders atomically require prefunded assets on both venues", () => {
  const state = initialPortfolio(100, ["Kraken", "Coinbase"]);
  const orders = [leg("Kraken", "buy"), leg("Coinbase", "sell", 1, 12)];
  const rejected = reserve(state, "cross", orders);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.state, state);
  const funded = fundCoin(state, "Coinbase");
  const locked = success(reserve(funded, "cross", orders));
  close(available(locked, "Kraken", "USD"), 39.9);
  assert.equal(available(locked, "Coinbase", "BTC"), 0);
  const result = success(settle(locked, "cross", orders.map((order) => fill(order))));
  close(result.balances.Kraken.USD, 39.9);
  close(result.balances.Coinbase.USD, 51.78);
  assert.equal(result.balances.Kraken.BTC, 1);
  assert.equal(result.balances.Coinbase.BTC, 0);
  // At the $10 inventory acquisition mark, total equity increased by 1.68 after all fees.
  close(result.balances.Kraken.USD + result.balances.Coinbase.USD + 10, 101.68);
  assert.equal(state.balances.Coinbase.USD, 50, "original state remains immutable");
});

test("pending reservations survive serialization and prevent double spending", () => {
  const order = leg("Kraken", "buy", 8);
  const locked = success(reserve(initialPortfolio(100, ["Kraken"]), "first", [order]));
  const restored: PortfolioState = JSON.parse(JSON.stringify(locked));
  close(available(restored, "Kraken", "USD"), 19.2);
  assert.equal(reserve(restored, "second", [leg("Kraken", "buy", 2)]).ok, false);
  assert.equal(reserve(restored, "first", [order]).duplicate, true);
  assert.equal(reserve(restored, "first", [leg("Kraken", "buy", 1)]).ok, false);
});

test("partial IOC fills debit actual cash, retain exposure, and unlock unfilled inputs", () => {
  const order = leg("Kraken", "buy", 8);
  const locked = success(reserve(initialPortfolio(100, ["Kraken"]), "partial", [order]));
  const result = success(settle(locked, "partial", [fill(order, 3, 9)]));
  close(result.balances.Kraken.USD, 72.73);
  close(available(result, "Kraken", "USD"), 72.73);
  assert.equal(result.balances.Kraken.BTC, 3);
  assert.deepEqual(result.reservations, {});
  const exit = leg("Kraken", "sell", 1, 8);
  const closed = success(applyFills(result, "partial-exit", [fill(exit)]));
  assert.equal(closed.balances.Kraken.BTC, 2, "only evidenced exit quantity closes");
  close(closed.balances.Kraken.USD, 80.65);
});

test("missed orders and known-unsubmitted cancellation release locks without changing holdings", () => {
  const start = initialPortfolio(100, ["Kraken"]), order = leg("Kraken", "buy");
  const missed = success(settle(success(reserve(start, "missed", [order])), "missed", [fill(order, 0, null)]));
  assert.deepEqual(missed.balances, start.balances);
  const locked = success(reserve(missed, "cancelled", [order]));
  const cancelled = success(cancel(locked, "cancelled"));
  assert.equal(available(cancelled, "Kraken", "USD"), 100);
  assert.equal(cancel(cancelled, "cancelled").duplicate, true);
  assert.equal(reserve(cancelled, "cancelled", [order]).ok, false);
  assert.equal(settle(cancelled, "cancelled", [fill(order)]).ok, false);
});

test("settlement and direct fills are idempotent across a serialized restart", () => {
  const start = initialPortfolio(100, ["Kraken"]), order = leg("Kraken", "buy");
  const result = success(settle(success(reserve(start, "buy", [order])), "buy", [fill(order)]));
  const restored = JSON.parse(JSON.stringify(result));
  assert.equal(settle(restored, "buy", [fill(order)]).duplicate, true);
  assert.equal(settle(restored, "buy", [fill(order, 0.5)]).ok, false);
  const exit = leg("Kraken", "sell");
  const closed = success(applyFills(restored, "exit", [fill(exit)]));
  assert.equal(applyFills(closed, "exit", [fill(exit)]).duplicate, true);
  assert.equal(applyFills(closed, "second-exit", [fill(exit)]).ok, false);
  assert.equal(closed.balances.Kraken.BTC, 0);
  close(closed.balances.Kraken.USD, 99.8);
});

test("triangles spend acquired assets sequentially and cannot borrow future leg proceeds", () => {
  const start = initialPortfolio(100, ["Kraken"]);
  const first = leg("Kraken", "buy", 1, 10, 0.01, "BTC");
  const second = leg("Kraken", "buy", 1.98, 0.5, 0.01, "ETH", "BTC");
  const third = leg("Kraken", "sell", 1.98, 6, 0.01, "ETH");
  assert.equal(reserve(start, "all", [first, second, third]).ok, false);
  assert.equal(applyFills(start, "all", [fill(first), fill(second), fill(third)]).ok, false);
  let state = start;
  for (const [index, order] of [first, second, third].entries())
    state = success(settle(success(reserve(state, `triangle-${index}`, [order])), `triangle-${index}`, [fill(order)]));
  close(state.balances.Kraken.USD, 101.6612);
  close(state.balances.Kraken.BTC, 0.0001);
  assert.equal(state.balances.Kraken.ETH, 0);
});

test("fees paid in quote currency, including stablecoins, remain on the correct venue", () => {
  const start = initialPortfolio(100, ["Kraken", "Coinbase"]);
  const conversion = leg("Kraken", "buy", 20, 0.99, 0.002, "USDT");
  let state = success(applyFills(start, "convert", [fill(conversion)]));
  const buy = leg("Kraken", "buy", 1, 10, 0.01, "BTC", "USDT");
  state = success(settle(success(reserve(state, "buy", [buy])), "buy", [fill(buy)]));
  close(state.balances.Kraken.USD, 30.1604);
  close(state.balances.Kraken.USDT, 9.9);
  assert.equal(state.balances.Coinbase.USD, 50);
  assert.equal(available(state, "Coinbase", "USDT"), 0);
});

test("invalid fills cannot overfill, mutate reserved requests, overspend, or violate limits", () => {
  const order = leg("Kraken", "buy", 2);
  const locked = success(reserve(initialPortfolio(100, ["Kraken"]), "trade", [order]));
  for (const fills of [[fill(order, 3)], [fill(order, 1, 11)], [fill(order, NaN)],
    [fill({ ...order, fee: 0 }, 1)], [fill(order), fill(order)], [fill(order, 1, Infinity)]]) {
    const rejected = settle(locked, "trade", fills);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.state, locked);
  }
  assert.equal(applyFills(locked, "steal-lock", [fill(leg("Kraken", "buy", 9))]).ok, false);
  assert.equal(reserve(locked, "bad", [leg("Kraken", "buy", Infinity)]).ok, false);
  assert.equal(reserve(locked, "bad", [leg("Kraken", "buy", 1, 10, -1)]).ok, false);
  assert.equal(reserve(locked, "bad", [leg("Kraken", "buy", 1, 10, NaN)]).ok, false);
});

test("tiny asset quantities do not receive a large absolute overdraft tolerance", () => {
  const buy = leg("Kraken", "buy", 1e-13, 1, 0);
  const state = success(applyFills(initialPortfolio(1, ["Kraken"]), "tiny-buy", [fill(buy)]));
  assert.equal(canReserve(state, [leg("Kraken", "sell", 2e-13, 1, 0)]).ok, false);
  const sell = leg("Kraken", "sell", 1e-13, 1, 0);
  const closed = success(applyFills(state, "tiny-sell", [fill(sell)]));
  assert.equal(closed.balances.Kraken.BTC, 0);
});

test("sequential settlement isolates intermediate proceeds from unrelated inventory and concurrent trades", () => {
  let start = initialPortfolio(100, ["Kraken"]);
  start = fundCoin(start, "Kraken", 2);
  const first = leg("Kraken", "buy", 1, 10, 0.01, "BTC");
  const tooLarge = leg("Kraken", "buy", 2, 0.5, 0.01, "ETH", "BTC");
  const second = leg("Kraken", "buy", 1.98, 0.5, 0.01, "ETH", "BTC");
  const third = leg("Kraken", "sell", 1.98, 6, 0.01, "ETH");
  const locked = success(reserve(start, "triangle", [first]));
  assert.equal(settleSequence(locked, "triangle", [fill(first), fill(tooLarge)]).ok, false,
    "preexisting BTC cannot cover this triangle's fee shortfall");
  assert.equal(available(locked, "Kraken", "BTC"), 2, "first leg output is not globally spendable");
  const result = success(settleSequence(locked, "triangle", [fill(first), fill(second), fill(third)]));
  close(result.balances.Kraken.BTC, 2.0001);
  close(result.balances.Kraken.USD, 81.4612);
  assert.equal(result.balances.Kraken.ETH, 0);
  assert.equal(settleSequence(result, "triangle", [fill(first), fill(second), fill(third)]).duplicate, true);
});

test("an interrupted triangle retains acquired assets and unused starting cash", () => {
  const first = leg("Kraken", "buy", 4, 10, 0.01, "BTC");
  const locked = success(reserve(initialPortfolio(100, ["Kraken"]), "triangle", [first]));
  const result = success(settleSequence(locked, "triangle", [fill(first, 2)]));
  close(result.balances.Kraken.USD, 79.8);
  assert.equal(result.balances.Kraken.BTC, 2);
  const none = success(settleSequence(success(reserve(result, "miss", [first])), "miss", []));
  assert.deepEqual(none.balances, result.balances);
});

test("actual commissions are recorded exactly in quote, acquired, or third fee assets", () => {
  const order = leg("Kraken", "buy");
  const normal = fill(order);
  const state = initialPortfolio(100, ["Kraken"]);
  const quoted = success(applyFills(state, "quote-fee", [{ ...normal, feeAmount: 0.25 }]));
  close(quoted.balances.Kraken.USD, 89.75);
  assert.equal(applyFills(quoted, "quote-fee", [{ ...normal, feeAmount: 0.3 }]).ok, false);
  const acquired = success(applyFills(state, "base-fee", [{ ...normal, feeAmount: 0.05, feeCurrency: "BTC" }]));
  assert.equal(acquired.balances.Kraken.USD, 90);
  close(acquired.balances.Kraken.BTC, 0.95);
  assert.equal(applyFills(state, "unfunded-fee", [{ ...normal, feeAmount: 0.01, feeCurrency: "ETH" }]).ok, false);
  const ethOrder = leg("Kraken", "buy", 1, 1, 0, "ETH");
  const funded = success(applyFills(state, "fee-inventory", [fill(ethOrder)]));
  const third = success(applyFills(funded, "third-fee", [{ ...normal, feeAmount: 0.01, feeCurrency: "ETH" }]));
  close(third.balances.Kraken.ETH, 0.99);
  close(third.balances.Kraken.USD, 89);
  assert.equal(third.balances.Kraken.BTC, 1);
});
