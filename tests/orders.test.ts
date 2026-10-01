import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { sendInParallel } from "../lib/execution";
import { makeMarket } from "../lib/markets";
import type { Leg, Opportunity } from "../lib/opportunities";
import { checkLeg, coinbaseCreateOrder, floorToStep, formatStep, krakenAddOrder, normalizeLeg, floorToCommonStep, normalizeCrossOpportunity } from "../lib/orders";
import { coinbaseJwt, krakenSignature } from "../lib/signing";

const leg = (over: Partial<Leg> = {}): Leg => ({ venue: "Kraken", pair: "BTC/USD", base: "BTC", quote: "USD", side: "buy", price: 84000.1, market: "Kraken|BTC/USD", size: 1, qty: 0.000595241, fee: 0.004, ...over });

test("sizes round down to whole lots without floating-point residue", () => {
  assert.equal(floorToStep(1.23456789, 0.001), 1.234);
  assert.equal(floorToStep(0.3, 0.1), 0.3);
  assert.equal(floorToStep(2.5, 0.5), 2.5);
  assert.equal(floorToStep(7, 5), 5);
  assert.equal(floorToStep(0.000595241, 1e-8), 0.00059524);
  assert.equal(formatStep(84000.1, 0.01), "84000.10");
  assert.equal(formatStep(0.5, 0.25), "0.50");
});

test("a leg is refused below the exchange's minimums or when its lot would unbalance the trade", () => {
  const rules = { lot: 1e-8, tick: 0.1, minQty: 0.00005, minNotional: 0.5 };
  assert.equal(checkLeg(leg(), rules).problem, null);
  assert.match(checkLeg(leg({ qty: 0.00004 }), rules).problem!, /Below Kraken's minimum order size \(0.00005 BTC\)/);
  assert.match(checkLeg(leg({ qty: 1, price: 0.4 }), { ...rules, minQty: 0 }).problem!, /minimum order value/);
  assert.match(checkLeg(leg({ qty: 1.9 }), { ...rules, lot: 1 }).problem!, /lot size would cut the order by over 1%/);
  assert.equal(checkLeg(leg({ qty: 0.00001 }), undefined).problem, null); // no published rules: unchecked
});

test("Kraken's WebSocket add_order and Coinbase's create order are built as documented", () => {
  const kraken = makeMarket("Kraken", "BTC", "USD", { ws: "BTC/USD", rules: { lot: 1e-8, tick: 0.1, minQty: 0.00005, minNotional: 0.5 } });
  assert.deepEqual(krakenAddOrder(leg(), kraken, { token: "T", reqId: 7, clientOrderId: "da8e4ad59b78481c93e589746b0cf91f" }), {
    method: "add_order",
    params: { order_type: "limit", side: "buy", order_qty: 0.00059524, symbol: "BTC/USD", limit_price: 84000.1, time_in_force: "ioc", token: "T", cl_ord_id: "da8e4ad59b78481c93e589746b0cf91f" },
    req_id: 7,
  });
  const coinbase = makeMarket("Coinbase", "BTC", "USD", { rules: { lot: 1e-8, tick: 0.01, minQty: 1e-8, minNotional: 1 } });
  assert.deepEqual(coinbaseCreateOrder(leg({ venue: "Coinbase", side: "sell", market: "Coinbase|BTC/USD" }), coinbase, "id-1"), {
    method: "POST", host: "api.coinbase.com", path: "/api/v3/brokerage/orders",
    body: { client_order_id: "id-1", product_id: "BTC-USD", side: "SELL", order_configuration: { sor_limit_ioc: { base_size: "0.00059524", limit_price: "84000.10" } } },
  });
});

test("request signing: Kraken's documented example and a Coinbase JWT that verifies", () => {
  // From Kraken's REST authentication guide.
  assert.equal(krakenSignature("/0/private/AddOrder", "1616492376594", "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25",
    "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg=="),
  "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwt = coinbaseJwt({ keyName: "organizations/o/apiKeys/k", privateKeyPem: privateKey.export({ type: "sec1", format: "pem" }).toString(),
    method: "post", host: "api.coinbase.com", path: "/api/v3/brokerage/orders", now: 1_790_000_000_000, nonce: "abc" });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "organizations/o/apiKeys/k", nonce: "abc", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()),
    { iss: "cdp", sub: "organizations/o/apiKeys/k", nbf: 1_790_000_000, exp: 1_790_000_120, uri: "POST api.coinbase.com/api/v3/brokerage/orders" });
  assert.ok(crypto.verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
});

test("legs are sent at the same time, and one failure doesn't hide the others", async () => {
  const legs = [leg(), leg({ venue: "Coinbase" }), leg({ venue: "Gemini" })];
  const started = performance.now();
  const sent = await sendInParallel(legs, (l, i) => new Promise((resolve, reject) => setTimeout(() => (i === 2 ? reject(new Error("rejected")) : resolve(l.venue)), 60)));
  assert.ok(performance.now() - started < 110, "three 60 ms sends overlap instead of running one after another");
  assert.ok(Math.max(...sent.map((s) => s.startedAt)) - Math.min(...sent.map((s) => s.startedAt)) < 5);
  assert.deepEqual(sent.map((s) => [s.result, s.error]), [["Kraken", null], ["Coinbase", null], [null, "rejected"]]);
});


test("arbitrary decimal lots remain exact and cannot round an undersized amount upward", () => {
  assert.equal(floorToStep(1.249, 0.125), 1.125);
  assert.equal(floorToStep(1.25, 0.125), 1.25);
  assert.equal(floorToStep(0.999999999999, 0.125), 0.875);
  assert.equal(floorToStep(0.001249, 0.000125), 0.001125);
  assert.equal(formatStep(1.125, 0.125), "1.125");
  assert.equal(formatStep(0.001125, 0.000125), "0.001125");
  assert.throws(() => floorToStep(1, 0), /increments positive/);
});

test("order builders and replay normalization use the same quantities and protective tick prices", () => {
  const rules = { lot: 0.125, tick: 0.25, minQty: 0.125, minNotional: 1 };
  const market = makeMarket("Kraken", "BTC", "USD", { rules });
  const buy = leg({ qty: 1.251, price: 100.13 });
  const sell = leg({ qty: 1.251, price: 100.13, side: "sell" });
  assert.deepEqual(checkLeg(buy, rules), { qty: 1.25, price: 100, problem: null });
  assert.equal(normalizeLeg(sell, rules).price, 100.25);
  const kraken = krakenAddOrder(buy, market, { token: "T", reqId: 1 });
  assert.equal(kraken.params.order_qty, 1.25);
  assert.equal(kraken.params.limit_price, 100);
  const coinbase = coinbaseCreateOrder(sell, makeMarket("Coinbase", "BTC", "USD", { rules }), "order");
  assert.equal(coinbase.body.order_configuration.sor_limit_ioc.base_size, "1.250");
  assert.equal(coinbase.body.order_configuration.sor_limit_ioc.limit_price, "100.25");
});


test("cross orders share the exact common lot and scale expected costs to their actual size", () => {
  assert.equal(floorToCommonStep(1.01, [0.03, 0.02]), 0.96);
  assert.equal(floorToCommonStep(1.13, [0.125, 0.05]), 1);
  const buy = leg({ qty: 1.201, price: 100 }), sell = leg({ venue: "Coinbase", qty: 1.201, side: "sell", price: 102 });
  const route: Opportunity = { key: "cross", kind: "cross", coin: "BTC", venues: ["Kraken", "Coinbase"], path: "", legs: [buy, sell],
    notional: 120.1, grossPct: 2, net: 1.201, netPct: 1, fees: 0.5, conversion: 0, buffer: 0.1, ageMs: 0, suspect: false };
  const rulesFor = (leg: Leg) => ({ lot: leg.venue === "Kraken" ? 0.03 : 0.02, tick: 0.01, minQty: 0, minNotional: 1 });
  const result = normalizeCrossOpportunity(route, rulesFor);
  assert.equal(result.problem, null);
  assert.deepEqual(result.opportunity?.legs.map((leg) => leg.qty), [1.2, 1.2]);
  assert.equal(result.opportunity?.net, 1.2);
  assert.equal(result.opportunity?.notional, 120.1 * (1.2 / 1.201));
  const badPrice = normalizeCrossOpportunity({ ...route, legs: [{ ...buy, price: 100.001 }, sell] }, rulesFor);
  assert.match(badPrice.problem!, /order tick/);
});
