import assert from "node:assert/strict";
import { test } from "node:test";
import type { Quote, Venue } from "../lib/market";
import type { Leg, Opportunity } from "../lib/opportunities";
import { fillLeg, LatencyTracker, settle } from "../lib/shadow";

const q = (bid: number, ask: number, size = 10): Quote => ({ bid, bidSize: size, ask, askSize: size, receivedAt: 0, source: "stream" });
const leg = (venue: Leg["venue"], side: Leg["side"], base: string, quote: string, price: number, qty: number, fee: number): Leg =>
  ({ venue, pair: `${base}/${quote}`, base, quote, side, price, market: `${venue}|${base}/${quote}`, size: 10, qty, fee });
const opp = (legs: Leg[], net = 1): Opportunity => ({
  key: "k", kind: legs.length === 3 ? "triangle" : "cross", coin: "X", venues: [...new Set(legs.map((l) => l.venue))], path: "p", legs,
  notional: 50, grossPct: 1, net, netPct: 2, fees: 0, conversion: 0, buffer: 0, ageMs: 0, suspect: false,
});
const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);
const usd = (venue: Venue, currency: string) => ({ market: `${venue}|${currency}/USD`, quote: q(0.998, 0.998, 100_000), fee: 0 });

test("both legs still on the book: filled at the book's prices, fees paid, no buffer", () => {
  const buy = leg("Kraken", "buy", "BTC", "USD", 100, 0.5, 0.008), sell = leg("Coinbase", "sell", "BTC", "USD", 102, 0.5, 0.009);
  const fills = [fillLeg(buy, q(99.9, 99.95)), fillLeg(sell, q(102.1, 102.2))];
  const r = settle(opp([buy, sell]), fills, () => undefined, usd);
  assert.equal(r.outcome, "filled");
  close(r.realizedNet, 0.5 * 102.1 * (1 - 0.009) - 0.5 * 99.95 * (1 + 0.008));
});

test("sell side gone by the time the order lands: buy is unwound at the new bid", () => {
  const buy = leg("Kraken", "buy", "BTC", "USD", 100, 0.5, 0.008), sell = leg("Coinbase", "sell", "BTC", "USD", 102, 0.5, 0.009);
  const fills = [fillLeg(buy, q(99.9, 100)), fillLeg(sell, q(101.5, 101.6))];
  assert.equal(fills[1].filledQty, 0);
  const r = settle(opp([buy, sell]), fills, (m) => (m === "Kraken|BTC/USD" ? q(99.7, 99.8) : undefined), usd);
  assert.equal(r.outcome, "partial");
  close(r.realizedNet, -0.5 * 100 * 1.008 + 0.5 * 99.7 * 0.992);
  assert.ok(r.realizedNet !== null && r.realizedNet < 0);
  assert.match(r.unwound[0], /sold 0.5000 BTC on Kraken/);
});

test("a thinner book fills part of the order; the rest of the position is closed out", () => {
  const buy = leg("Kraken", "buy", "SOL", "USD", 10, 4, 0.008), sell = leg("Bitstamp", "sell", "SOL", "USD", 10.5, 4, 0.005);
  const fills = [fillLeg(buy, q(9.9, 10, 10)), fillLeg(sell, q(10.5, 10.6, 1))];
  assert.equal(fills[1].filledQty, 1);
  const r = settle(opp([buy, sell]), fills, () => q(9.8, 9.9), usd);
  assert.equal(r.outcome, "partial");
  close(r.filledFraction, 0.25);
  close(r.realizedNet, -4 * 10 * 1.008 + 1 * 10.5 * 0.995 + 3 * 9.8 * 0.992);
});

test("nothing fills when both prices have moved away", () => {
  const buy = leg("Kraken", "buy", "BTC", "USD", 100, 0.5, 0.008), sell = leg("Coinbase", "sell", "BTC", "USD", 102, 0.5, 0.009);
  const r = settle(opp([buy, sell]), [fillLeg(buy, q(100.2, 100.3)), fillLeg(sell, q(101.8, 101.9))], () => undefined, usd);
  assert.equal(r.outcome, "missed");
  assert.equal(r.realizedNet, 0);
});

test("stablecoin legs are valued at the conversion rate", () => {
  const buy = leg("Binance.US", "buy", "ETH", "USDT", 2000, 0.01, 0.0002), sell = leg("Coinbase", "sell", "ETH", "USD", 2010, 0.01, 0.009);
  const r = settle(opp([buy, sell]), [fillLeg(buy, q(1999, 2000)), fillLeg(sell, q(2010, 2011))], () => undefined, usd);
  close(r.realizedNet, 0.01 * 2010 * 0.991 - 0.01 * 2000 * 1.0002 * 0.998);
});

test("a triangle that loses its last leg holds the middle coin and sells it", () => {
  const legs = [leg("Kraken", "buy", "BTC", "USD", 100, 0.5, 0.008), leg("Kraken", "buy", "ETH", "BTC", 0.05, 10, 0.008), leg("Kraken", "sell", "ETH", "USD", 5.2, 10, 0.008)];
  const fills = [fillLeg(legs[0], q(99.9, 100)), fillLeg(legs[1], q(0.0499, 0.05, 20)), fillLeg(legs[2], q(5.1, 5.11, 20))];
  assert.deepEqual(fills.map((f) => f.filledQty), [0.5, 10, 0]);
  const r = settle(opp(legs), fills, (m) => (m === "Kraken|ETH/USD" ? q(5.1, 5.11, 20) : q(99.9, 100)), usd);
  assert.equal(r.outcome, "partial");
  // Bought 0.5 BTC, spent 0.5 BTC (+ fee in BTC) on 10 ETH, sold the 10 ETH at 5.1 and the BTC fee shortfall back.
  const btcLeft = 0.5 - 10 * 0.05 * 1.008;
  close(r.realizedNet, -0.5 * 100 * 1.008 + 10 * 5.1 * 0.992 + btcLeft * 100 * 1.008);
});

test("latency uses the median of recent samples", () => {
  const t = new LatencyTracker(300, 5);
  assert.equal(t.get("Kraken"), 300);
  for (const ms of [80, 90, 2000, 85, 95]) t.record("Kraken", ms);
  assert.equal(t.get("Kraken"), 90);
});


test("no fresh unwind book leaves exposure and unknown profit, never the old price", () => {
  const buy = leg("Kraken", "buy", "BTC", "USD", 100, 10, 0), sell = leg("Coinbase", "sell", "BTC", "USD", 102, 10, 0);
  const result = settle(opp([buy, sell]), [fillLeg(buy, q(99, 100)), fillLeg(sell, undefined)], () => undefined);
  assert.equal(result.accountingComplete, false);
  assert.equal(result.realizedNet, null);
  assert.equal(result.knownNet, -1000);
  assert.equal(result.unwindFills.length, 0);
  assert.deepEqual(result.unresolved, [{ venue: "Kraken", currency: "BTC", amount: 10, reason: "No fresh unwind book" }]);
});

test("unwind fills respect displayed depth and preserve the unfilled remainder", () => {
  const buy = leg("Kraken", "buy", "BTC", "USD", 100, 10, 0), sell = leg("Coinbase", "sell", "BTC", "USD", 102, 10, 0);
  const result = settle(opp([buy, sell]), [fillLeg(buy, q(99, 100)), fillLeg(sell, undefined)], () => q(99, 100, 0.01));
  assert.equal(result.realizedNet, null);
  assert.equal(result.unwindFills.length, 1);
  assert.equal(result.unwindFills[0].filledQty, 0.01);
  close(result.unresolved[0].amount, 9.99);
  close(result.knownNet, -999.01);
});

test("matched base inventory stays on each venue, without a fictitious transfer or liquidation", () => {
  const buy = leg("Kraken", "buy", "BTC", "USD", 100, 1, 0), sell = leg("Coinbase", "sell", "BTC", "USD", 102, 1, 0);
  const result = settle(opp([buy, sell]), [fillLeg(buy, q(99, 100)), fillLeg(sell, q(102, 103))], () => { throw new Error("no unwind needed"); });
  assert.equal(result.realizedNet, 2);
  assert.equal(result.accountingComplete, true);
  assert.deepEqual(result.cashflows.filter((c) => c.currency === "BTC"), [
    { venue: "Kraken", currency: "BTC", amount: 1 }, { venue: "Coinbase", currency: "BTC", amount: -1 },
  ]);
});

test("a sell-only fill is bought back on the venue that sold the inventory", () => {
  const buy = leg("Kraken", "buy", "BTC", "USD", 100, 1, 0), sell = leg("Coinbase", "sell", "BTC", "USD", 102, 1, 0);
  const result = settle(opp([buy, sell]), [fillLeg(buy, undefined), fillLeg(sell, q(102, 103))],
    (market) => market.startsWith("Kraken") ? q(98, 99) : q(102, 103));
  assert.equal(result.realizedNet, -1);
  assert.equal(result.unwindFills[0].leg.venue, "Coinbase");
  assert.equal(result.unwindFills[0].leg.side, "buy");
});

test("stablecoin conversions keep both venues' gross cash flows and conversion fees", () => {
  const buy = leg("Kraken", "buy", "BTC", "USDT", 100, 1, 0), sell = leg("Coinbase", "sell", "BTC", "USDT", 101, 1, 0);
  const result = settle(opp([buy, sell]), [fillLeg(buy, q(99, 100)), fillLeg(sell, q(101, 102))], () => undefined,
    (venue, currency) => ({ market: `${venue}|${currency}/USD`, quote: q(1, 1, 1000), fee: 0.002 }));
  close(result.realizedNet, 101 * 0.998 - 100 * 1.002);
  assert.equal(result.accountingComplete, true);
  assert.equal(result.conversionFills.length, 2);
  assert.deepEqual(result.conversionFills.map((f) => [f.leg.venue, f.leg.side, f.filledQty, f.feeCurrency]), [
    ["Kraken", "buy", 100, "USD"], ["Coinbase", "sell", 101, "USD"],
  ]);
  close(result.conversionFills[0].feeAmount, 0.2);
});

test("missing or shallow stable conversion books leave explicitly unresolved exposure", () => {
  const buy = leg("Kraken", "buy", "ETH", "USDT", 100, 1, 0), sell = leg("Coinbase", "sell", "ETH", "USD", 102, 1, 0);
  const fills = [fillLeg(buy, q(99, 100)), fillLeg(sell, q(102, 103))];
  const missing = settle(opp([buy, sell]), fills, () => undefined);
  assert.equal(missing.realizedNet, null);
  assert.equal(missing.conversionFills.length, 0);
  assert.equal(missing.unresolved[0].amount, -100);
  const shallow = settle(opp([buy, sell]), fills, () => undefined,
    (venue, currency) => ({ market: `${venue}|${currency}/USD`, quote: q(0.99, 1.01, 40), fee: 0.002 }));
  assert.equal(shallow.realizedNet, null);
  assert.equal(shallow.conversionFills[0].filledQty, 40);
  assert.equal(shallow.unresolved[0].amount, -60);
});

test("fees remain explicit in their charged currency and balance the per-venue ledger", () => {
  const buy = leg("Kraken", "buy", "BTC", "USD", 100, 1, 0.01), sell = leg("Coinbase", "sell", "BTC", "USD", 105, 1, 0.01);
  const fills = [fillLeg(buy, q(99, 100)), fillLeg(sell, q(105, 106))];
  assert.deepEqual(fills.map((f) => [f.feeAmount, f.feeCurrency]), [[1, "USD"], [1.05, "USD"]]);
  const result = settle(opp([buy, sell]), fills, () => undefined);
  close(result.realizedNet, 2.95);
  close(result.cashflows.filter((f) => f.currency === "USD").reduce((n, f) => n + f.amount, 0), 2.95);
});


test("small shortfalls remain partial instead of being rounded into a full fill", () => {
  const buy = leg("Kraken", "buy", "BTC", "USD", 100, 1, 0), sell = leg("Coinbase", "sell", "BTC", "USD", 102, 1, 0);
  const result = settle(opp([buy, sell]), [fillLeg(buy, q(99, 100, 0.9995)), fillLeg(sell, q(102, 103))], () => undefined);
  assert.equal(result.outcome, "partial");
  assert.equal(result.realizedNet, null);
  close(result.unresolved[0].amount, -0.0005);
});
