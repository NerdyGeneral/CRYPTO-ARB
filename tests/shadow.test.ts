import assert from "node:assert/strict";
import { test } from "node:test";
import type { Quote } from "../lib/market";
import type { Leg, Opportunity } from "../lib/opportunities";
import { fillLeg, LatencyTracker, settle } from "../lib/shadow";

const q = (bid: number, ask: number, size = 10): Quote => ({ bid, bidSize: size, ask, askSize: size, receivedAt: 0, source: "stream" });
const leg = (venue: Leg["venue"], side: Leg["side"], base: string, quote: string, price: number, qty: number, fee: number): Leg =>
  ({ venue, pair: `${base}/${quote}`, base, quote, side, price, market: `${venue}|${base}/${quote}`, size: 10, qty, fee });
const opp = (legs: Leg[], net = 1): Opportunity => ({
  key: "k", kind: legs.length === 3 ? "triangle" : "cross", coin: "X", venues: [...new Set(legs.map((l) => l.venue))], path: "p", legs,
  notional: 50, grossPct: 1, net, netPct: 2, fees: 0, conversion: 0, buffer: 0, ageMs: 0, suspect: false,
});
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);
const usd = (c: string) => (c === "USDT" ? 0.998 : 1);

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
  assert.ok(r.realizedNet < 0);
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
