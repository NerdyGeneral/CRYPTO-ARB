import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coinsPerPriceUnit, fundingPayment, markCarry, openCarry, openingCost, parseFutures, quoteCarry, quoteDated, trailingApr,
  HOURS_PER_YEAR, type Book, type SpotSide,
} from "../lib/carry";
import futures from "./fixtures/coinbase-futures.json";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("reads Coinbase's US perps and dated futures, leaving out non-crypto contracts", () => {
  const { perps, dated } = parseFutures(futures);
  assert.deepEqual(perps.map((p) => p.id).sort(), ["BIP-20DEC30-CDE", "PEP-20DEC30-CDE", "SHP-20DEC30-CDE"]);
  assert.deepEqual(dated.map((d) => d.id), ["BIT-30OCT26-CDE"]);
  const btc = perps.find((p) => p.coin === "BTC")!;
  assert.equal(btc.contractSize, 0.01);
  assert.equal(btc.intervalHours, 1);
  close(btc.fundingRate, 0.000008);
  assert.equal(btc.fundingTime, Date.parse("2026-09-25T23:00:00Z"));
  close(btc.shortMargin, 0.306375); // the stricter of the overnight and intraday short margins
  assert.equal(parseFutures({}).perps.length, 0);
});

test("contracts priced per 1,000 coins are detected from the spot price", () => {
  assert.equal(coinsPerPriceUnit(0.00595, 0.00000597), 1000);
  assert.equal(coinsPerPriceUnit(84105, 84071), 1);
  assert.equal(coinsPerPriceUnit(0.2594, 0.2593), 1);
});

const btc = () => parseFutures(futures).perps.find((p) => p.coin === "BTC")!;
const book: Book = { bid: 84090, ask: 84100, bidSize: 6, askSize: 20, at: 0 };
const spot: SpotSide = { venue: "Binance.US", bid: 84060, ask: 84070, bidSize: 1, askSize: 1, fee: 0.0002, at: 0 };
const options = { futuresFee: 0.0005, marginBuffer: 1, holdDays: 14, capital: 2000 };

test("a carry quote is sized in whole contracts and nets out every fee and spread", () => {
  const q = quoteCarry(btc(), book, spot, 1, 0.12, options);
  // One contract is 0.01 BTC: about $840.7 of coins plus $840.9 of collateral, so $2,000 fits one.
  assert.equal(q.contracts, 1);
  close(q.capital, 0.01 * 84070 * 1.0002 + 0.01 * 84090 * (1 + 0.0005));
  close(q.spotQty, 0.01);
  const roundTrip = 2 * 0.0002 + 2 * 0.0005 + 10 / 84065 + 10 / 84095;
  close(q.roundTripPct, roundTrip);
  close(q.netApr, 0.12 - roundTrip * 365 / 14);
  close(q.netAprOnCapital, q.netApr / 2);
  close(q.breakEvenHours!, roundTrip / (0.12 / HOURS_PER_YEAR));
  assert.equal(q.reason, null);
  assert.match(quoteCarry(btc(), book, spot, 1, 0.12, { ...options, capital: 1000 }).reason!, /One contract needs \$1,683/);
  assert.match(quoteCarry(btc(), { ...book, bidSize: 0 }, spot, 1, 0.12, options).reason!, /futures size/);
  assert.match(quoteCarry(btc(), book, spot, 1, 0.12, { ...options, marginBuffer: 0.3 }).reason!, /Needs over 39% collateral/);
});

test("funding, basis and fees add up on a round trip, and the margin call price is where equity meets the requirement", () => {
  const perp = btc();
  const p = openCarry("c1", perp, book, spot, 1, 2, options, 0);
  close(openingCost(p), 0.02 * 84070 * 1.0002 + 0.02 * 84090 * 1 + 0.02 * 84090 * 0.0005);
  // Two hours of funding: +0.0008% and −0.0002% of the notional at the index.
  p.funding += fundingPayment(p, 0.000008, 84000) + fundingPayment(p, -0.000002, 84100);
  close(p.funding, 0.02 * (84000 * 0.000008 - 84100 * 0.000002));
  // Price rises 1% on both legs: the spot gain and the short loss cancel, leaving funding minus fees.
  const m = markCarry(p, 84060 * 1.01, 84100 * 1.01, perp.shortMargin);
  close(m.spotPnl + m.shortPnl, 0.02 * (84060 * 1.01 - 84070) + 0.02 * (84090 - 84100 * 1.01), 1e-6);
  close(m.net, m.spotPnl + m.shortPnl + p.funding - p.fees - m.exitFees, 1e-6);
  // At the margin call price, collateral + funding + short P&L equals the overnight margin on the notional.
  const callPrice = 84100 * 1.01 * (1 + m.riseToMarginCall), k = 0.02;
  close(p.collateral + p.funding + k * (p.entryPerp - callPrice), perp.shortMargin * k * callPrice, 1e-6);
  assert.ok(m.riseToMarginCall > 0.5, "with 100% collateral BTC can rise over 50% before a margin call");
});

test("trailing funding needs enough settlements; dated futures lock the basis to expiry", () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ time: i * 3_600_000, rate: 0.00001 }));
  close(trailingApr(history, 0, 6)!, 0.00001 * HOURS_PER_YEAR);
  assert.equal(trailingApr(history, 8 * 3_600_000, 6), null);
  const dated = parseFutures(futures).dated[0];
  const q = quoteDated(dated, { bid: 84820, ask: 84830, bidSize: 5, askSize: 5, at: 0 }, spot, 1, dated.expiry - 30 * 86_400_000, options);
  close(q.days, 30);
  close(q.basisPct, (84820 / 84070 - 1) * 100);
  close(q.netPct, q.basisPct - (2 * 0.0002 + 2 * 0.0005 + 10 / 84065) * 100);
  close(q.netApr!, q.netPct / 100 * 365 / 30);
});
