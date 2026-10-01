import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults, emptyMarkets, routesFor, type Quote, type Settings } from "../lib/market";
import { keyOf, makeMarket, type Market } from "../lib/markets";
import { selectMarkets } from "../lib/discovery";
import { barrierKey, blockReason, chooseTrade, indexRoutes, scanMarket, scanOpportunities, type Opportunity } from "../lib/opportunities";

const now = 1_000_000;
const quote = (bid: number, ask: number, size = 1000, receivedAt = now - 100): Quote => ({ bid, bidSize: size, ask, askSize: size, receivedAt, source: "stream" });
const book = (entries: [Market, Quote][]) => ({ markets: entries.map(([m]) => m), quotes: new Map(entries.map(([m, q]) => [keyOf(m), q])) });
const settings: Settings = { ...defaults, budget: 50, buffer: 0.1, maxGap: 10 };
const scan = (entries: [Market, Quote][], extra: Partial<Parameters<typeof scanOpportunities>[0]> = {}) =>
  scanOpportunities({ ...book(entries), settings, conversionFee: 0.2, balance: 500, now, triangular: true, ...extra });
const close = (actual: number, expected: number, digits = 9) => assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} ≉ ${expected}`);

test("USD-only cross route matches the dashboard's routesFor", () => {
  const cb = quote(100, 100.5, 10), kr = quote(102, 102.5, 10);
  const result = scan([[makeMarket("Coinbase", "BTC", "USD"), cb], [makeMarket("Kraken", "BTC", "USD"), kr]], { triangular: false });
  const markets = emptyMarkets();
  markets.BTC = { Coinbase: cb, Kraken: kr };
  const legacy = routesFor({ generatedAt: now, markets, errors: [] }, settings, 500, { assets: ["BTC"], venues: ["Coinbase", "Kraken"] }, now)
    .find((r) => r.buy === "Coinbase" && r.sell === "Kraken")!;
  const route = result.top.find((o) => o.key.includes("Coinbase|BTC/USD>Kraken|BTC/USD"))!;
  close(route.net, legacy.net);
  close(route.grossPct, legacy.grossPct);
  assert.equal(route.conversion, 0);
});

test("a USDT leg is valued at the venue's USDT/USD book including conversion cost", () => {
  const result = scan([
    [makeMarket("Binance.US", "BTC", "USDT"), quote(99.9, 100, 10)],
    [makeMarket("Binance.US", "USDT", "USD"), quote(0.999, 1.001)],
    [makeMarket("Coinbase", "BTC", "USD"), quote(101, 101.1, 10)],
  ], { triangular: false });
  const route = result.top.find((o) => o.path === "BTC: Binance.US (USDT) → Coinbase (USD)")!;
  const fee = 0.0002, cost = 1.001 * (1 + fee);             // buying USDT back costs the ask plus Binance.US's fee
  const qty = 50 / (100 * cost * (1 + fee + 0.001));
  const fees = qty * 100 * fee + qty * 101 * 0.009;
  const conversion = qty * 100 * (1 + fee) * (cost - 1);
  const buffer = qty * (100 + 101) * 0.001;
  close(route.net, qty * (101 - 100) - fees - conversion - buffer);
  close(route.conversion, conversion);
  close(route.grossPct, 1);
  close(result.rates.USDT.mid, 1);
});

test("triangles are priced with three taker fees and a buffer per leg, in both directions", () => {
  const result = scan([
    [makeMarket("Kraken", "BTC", "USD"), quote(99.9, 100)],
    [makeMarket("Kraken", "ETH", "BTC"), quote(0.0499, 0.05)],
    [makeMarket("Kraken", "ETH", "USD"), quote(5.2, 5.21)],
  ]);
  const fee = 0.008, slip = 0.001;
  const forward = result.top.concat(result.suspects).find((o) => o.path === "Kraken: USD → BTC → ETH → USD")!;
  const raw = (1 / 100) * (1 / 0.05) * 5.2;
  close(forward.grossPct, (raw - 1) * 100);
  close(forward.net, 50 * raw * (1 - fee) / (1 + fee) ** 2 * (1 - slip) ** 3 - 50);
  assert.equal(forward.legs.map((l) => `${l.side} ${l.pair}`).join(", "), "buy BTC/USD, buy ETH/BTC, sell ETH/USD");
  const reverse = result.top.find((o) => o.path === "Kraken: USD → ETH → BTC → USD")!;
  close(reverse.grossPct, ((1 / 5.21) * 0.0499 * 99.9 - 1) * 100);
});

test("gaps above maxGap are suspect and never the best route", () => {
  const result = scan([
    [makeMarket("Gemini", "FET", "USD"), quote(0.2390, 0.2392)],
    [makeMarket("Kraken", "FET", "USD"), quote(0.2529, 0.2532)],
    [makeMarket("Coinbase", "SOL", "USD"), quote(120, 120.1)],
    [makeMarket("Bitstamp", "SOL", "USD"), quote(120.05, 120.2)],
  ], { settings: { ...settings, maxGap: 2 }, triangular: false });
  assert.ok(result.suspects.some((o) => o.coin === "FET" && o.venues[1] === "Kraken"));
  assert.equal(result.best?.coin, "SOL");
  assert.ok(result.top.every((o) => !o.suspect));
});

test("stale quotes and legs recorded too far apart are ignored", () => {
  const result = scan([
    [makeMarket("Coinbase", "BTC", "USD"), quote(100, 100.5, 10, now - 13_000)],
    [makeMarket("Kraken", "BTC", "USD"), quote(102, 102.5, 10)],
    [makeMarket("Gemini", "ETH", "USD"), quote(5, 5.01, 10, now - 100)],
    [makeMarket("Bitstamp", "ETH", "USD"), quote(5.1, 5.11, 10, now - 5_000)],
  ], { triangular: false });
  assert.equal(result.top.length, 0);
  assert.equal(result.evaluated.cross, 0);
});

test("a paper trade cannot fill twice against the same unchanged quote", () => {
  const route = (key: string, sellPrice: number, sellSize: number, net = 0.3): Opportunity => ({
    key, kind: "cross", coin: "GRT", venues: ["CEX.IO", "Binance.US"], path: key, notional: 50, grossPct: 1, net, netPct: 0.6,
    fees: 0.1, conversion: 0, buffer: 0.1, ageMs: 100, suspect: false,
    legs: [
      { venue: "CEX.IO", pair: "GRT/USD", base: "GRT", quote: "USD", side: "buy", price: 0.0285, market: `CEX.IO|GRT/USD|${key}`, size: 5000, qty: 1700, fee: 0.0025 },
      { venue: "Binance.US", pair: "GRT/USD", base: "GRT", quote: "USD", side: "sell", price: sellPrice, market: "Binance.US|GRT/USD", size: sellSize, qty: 1700, fee: 0.0002 },
    ],
  });
  const memory = { recent: new Map<string, number>(), consumed: new Map<string, { price: number; size: number }>() };
  const options = { minNet: 0.25, now, cooldownMs: 60_000 };
  assert.equal(chooseTrade([route("a", 0.0288, 2600)], memory, options)?.key, "a");
  // A different buy venue selling into the same Binance.US bid, and the same route a minute later, are both blocked.
  assert.equal(chooseTrade([route("b", 0.0288, 2600)], memory, { ...options, now: now + 1000 }), null);
  assert.equal(chooseTrade([route("a", 0.0288, 2600)], memory, { ...options, now: now + 61_000 }), null);
  // Once the book shows a new bid, it can trade again.
  assert.equal(chooseTrade([route("b", 0.02881, 900)], memory, { ...options, now: now + 2000 })?.key, "b");
  // Routes below the minimum are skipped, and every block has a reason the dashboard can show.
  assert.equal(chooseTrade([route("c", 0.03, 10, 0.1)], memory, options), null);
  assert.equal(blockReason(route("c", 0.03, 10, 0.1), memory, options), "Below your $0.25 minimum");
  assert.equal(blockReason(route("d", 0.03, 10, -0.2), memory, options), "Loses money after costs");
  assert.equal(blockReason({ ...route("e", 0.03, 10), suspect: true }, memory, options), "Suspect gap");
  assert.equal(blockReason(route("a", 0.0288, 2600), memory, { ...options, now: now + 1000 }), "Traded in the last minute");
  assert.equal(blockReason(route("z", 0.02881, 900), memory, { ...options, now: now + 3000 }), "Quote already used by a paper trade");
});

test("a barrier found by the route checks blocks the coin between those exchanges at any gap", () => {
  const route = (venues: Opportunity["venues"]): Opportunity => ({
    key: venues.join(">"), kind: "cross", coin: "FET", venues, path: "", notional: 50, grossPct: 1.5, net: 0.4, netPct: 0.8,
    fees: 0.1, conversion: 0, buffer: 0.1, ageMs: 100, suspect: false,
    legs: [
      { venue: venues[0], pair: "FET/USD", base: "FET", quote: "USD", side: "buy", price: 1, market: `${venues[0]}|FET/USD`, size: 100, qty: 50, fee: 0.001 },
      { venue: venues[1], pair: "FET/USD", base: "FET", quote: "USD", side: "sell", price: 1.015, market: `${venues[1]}|FET/USD`, size: 100, qty: 50, fee: 0.001 },
    ],
  });
  const memory = { recent: new Map<string, number>(), consumed: new Map<string, { price: number; size: number }>(),
    barriers: new Map([[barrierKey("FET", "Binance.US", "Kraken"), "Known barrier: price outlier"]]) };
  const options = { minNet: 0.25, now, cooldownMs: 60_000 };
  assert.equal(blockReason(route(["Binance.US", "Kraken"]), memory, options), "Known barrier: price outlier");
  assert.equal(chooseTrade([route(["Binance.US", "Kraken"])], memory, options), null);
  assert.equal(chooseTrade([route(["Coinbase", "Kraken"])], memory, options)?.venues[0], "Coinbase");
});

test("market selection ranks coins by volume, needs two venues and caps books per venue", () => {
  const markets = [
    ...["BTC", "ETH", "AAA", "BBB", "CCC"].flatMap((coin) => [makeMarket("Coinbase", coin, "USD"), makeMarket("CEX.IO", coin, "USD"), makeMarket("CEX.IO", coin, "USDT")]),
    makeMarket("Kraken", "LONE", "USD"),               // listed on one venue only
    makeMarket("Kraken", "USDT", "USD"),               // stablecoin rate book
    makeMarket("Kraken", "ETH", "BTC"),                // cross book for triangles
  ];
  const volumeUsd = { BTC: 100, ETH: 90, AAA: 5, BBB: 50, CCC: 1, LONE: 1000 };
  const selection = selectMarkets({ markets, volumeUsd, fetchedAt: now, errors: [] },
    { tradableVenues: ["Coinbase", "CEX.IO", "Kraken"], topCoins: 3, triangular: true, maxPerVenue: { "CEX.IO": 4 } });
  assert.deepEqual(selection.coins, ["BTC", "ETH", "BBB"]);
  const cex = selection.markets.filter((m) => m.venue === "CEX.IO").map((m) => `${m.base}/${m.quote}`);
  assert.deepEqual(cex, ["BTC/USD", "BTC/USDT", "ETH/USD", "ETH/USDT"]);
  assert.ok(selection.markets.some((m) => m.base === "USDT" && m.quote === "USD"));
  assert.ok(selection.markets.some((m) => m.base === "ETH" && m.quote === "BTC"));
  assert.ok(!selection.markets.some((m) => m.base === "LONE" || m.base === "AAA"));
});

test("re-checking only the routes that use a changed book finds exactly what a full scan finds", () => {
  // Three venues with USD, USDT and BTC books for a few coins, and seeded random prices around a reference.
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const reference: Record<string, number> = { BTC: 84000, ETH: 2700, SOL: 122, XRP: 1.57, USDT: 1, USD: 1 };
  const entries: [Market, Quote][] = [];
  for (const venue of ["Coinbase", "Kraken", "Binance.US"] as const) {
    for (const [base, quoteCcy] of [["BTC", "USD"], ["ETH", "USD"], ["SOL", "USD"], ["XRP", "USD"], ["ETH", "BTC"], ["SOL", "BTC"], ["XRP", "USDT"], ["USDT", "USD"], ["SOL", "USDT"]]) {
      const mid = reference[base] / reference[quoteCcy] * (1 + (random() - 0.5) * 0.03), half = mid * 0.0002;
      entries.push([makeMarket(venue, base, quoteCcy), quote(mid - half, mid + half, 1 + random() * 50, now - Math.floor(random() * 2000))]);
    }
  }
  const input = { ...book(entries), settings: { ...settings, maxGap: 50, budget: 1000 }, conversionFee: 0.2, balance: 5000, now, triangular: true };
  const index = indexRoutes(input.markets);
  const full = scanOpportunities({ ...input, index });
  assert.ok(full.top.length >= 10, `expected a full list, got ${full.top.length}`);
  assert.ok(full.top.some((o) => o.kind === "triangle") && full.top.some((o) => o.kind === "cross"), "both kinds of route are covered");
  for (const o of full.top) {
    // Each route the full scan found is found, with the same value, when any one of its books changes.
    for (const leg of o.legs) {
      const market = input.markets.find((m) => keyOf(m) === leg.market)!;
      const match = scanMarket({ ...input, index }, market).find((x) => x.key === o.key);
      assert.ok(match, `${o.key} missing when ${leg.market} changes`);
      close(match!.net, o.net);
    }
  }
  // And nothing it returns involves only other books.
  const market = input.markets.find((m) => keyOf(m) === "Kraken|SOL/BTC")!;
  for (const o of scanMarket({ ...input, index }, market)) assert.ok(o.legs.some((leg) => leg.market === "Kraken|SOL/BTC"), o.key);
});


test("the best eligible route is selected even when it ranks below the displayed top 20", () => {
  const entries: [Market, Quote][] = [];
  for (let i = 0; i < 25; i++) {
    const coin = `COIN${i}`;
    entries.push([makeMarket("Coinbase", coin, "USD"), quote(99.9, 100)]);
    entries.push([makeMarket("Kraken", coin, "USD"), quote(103 - i * 0.01, 103.1 - i * 0.01)]);
  }
  const result = scan(entries, { triangular: false, eligible: (o) => o.coin === "COIN24" && o.venues[0] === "Coinbase" });
  assert.equal(result.top.length, 20);
  assert.ok(result.top.every((o) => o.coin !== "COIN24"));
  assert.equal(result.bestEligible?.coin, "COIN24");
  assert.equal(result.bestEligible?.venues[0], "Coinbase");
  assert.ok(result.bestEligible!.net > 0);
});

test("stablecoin book updates immediately rescan every locally dependent cross route and triangle", () => {
  const stable = makeMarket("Kraken", "USDT", "USD");
  const entries: [Market, Quote][] = [
    [stable, quote(0.999, 1.001)],
    [makeMarket("Kraken", "BTC", "USDT"), quote(99.9, 100)],
    [makeMarket("Kraken", "BTC", "USD"), quote(102, 102.1)],
    [makeMarket("Coinbase", "BTC", "USD"), quote(102, 102.1)],
    [makeMarket("Kraken", "ETH", "USDT"), quote(9.99, 10)],
    [makeMarket("Coinbase", "ETH", "USD"), quote(10.2, 10.21)],
  ];
  const input = { ...book(entries), settings, conversionFee: 0.2, balance: 500, now, triangular: true };
  const index = indexRoutes(input.markets);
  const changed = scanMarket({ ...input, index }, stable);
  assert.ok(changed.some((o) => o.kind === "cross" && o.coin === "BTC"));
  assert.ok(changed.some((o) => o.kind === "cross" && o.coin === "ETH"));
  assert.ok(changed.some((o) => o.kind === "triangle"));
  assert.equal(new Set(changed.map((o) => o.key)).size, changed.length);
  const full = scanOpportunities({ ...input, index });
  for (const o of changed) close(full.top.find((candidate) => candidate.key === o.key)!.net, o.net);
});

test("a cross route cannot borrow another venue's stablecoin conversion book", () => {
  const entries: [Market, Quote][] = [
    [makeMarket("Binance.US", "BTC", "USDT"), quote(99.9, 100)],
    [makeMarket("Kraken", "USDT", "USD"), quote(0.999, 1.001)],
    [makeMarket("Coinbase", "BTC", "USD"), quote(102, 102.1)],
  ];
  assert.equal(scan(entries, { triangular: false }).top.length, 0);
  entries.push([makeMarket("Binance.US", "USDT", "USD"), quote(0.999, 1.001, 1000, now - 13_000)]);
  assert.equal(scan(entries, { triangular: false }).top.length, 0, "old local rate cannot execute a fresh route");
  entries[entries.length - 1][1] = quote(0.999, 1.001, 1000, now - 5_000);
  assert.equal(scan(entries, { triangular: false }).top.length, 0, "conversion and coin quote skew is enforced");
});

test("cross route size cannot exceed conversion liquidity including coin fees", () => {
  const entries: [Market, Quote][] = [
    [makeMarket("Binance.US", "BTC", "USDT"), quote(99.9, 100)],
    [makeMarket("Binance.US", "USDT", "USD"), quote(0.999, 1.001, 10)],
    [makeMarket("Coinbase", "BTC", "USD"), quote(102, 102.1)],
  ];
  const result = scan(entries, { triangular: false });
  const buyStable = result.top.find((o) => o.venues[0] === "Binance.US")!;
  close(buyStable.legs[0].qty * 100 * (1 + settings.binanceUsFee / 100), 10);
  const sellStable = result.top.find((o) => o.venues[1] === "Binance.US")!;
  close(sellStable.legs[1].qty * 99.9 * (1 - settings.binanceUsFee / 100), 10);
});

test("triangle buys pay quote-currency fees without phantom intermediate balances", () => {
  const result = scan([
    [makeMarket("Kraken", "BTC", "USD"), quote(99.9, 100, 0.2)],
    [makeMarket("Kraken", "ETH", "BTC"), quote(0.0499, 0.05)],
    [makeMarket("Kraken", "ETH", "USD"), quote(5.2, 5.21)],
  ], { settings: { ...settings, buffer: 0 } });
  const route = result.top.find((o) => o.path === "Kraken: USD → BTC → ETH → USD")!;
  const [first, second, third] = route.legs;
  close(first.qty, 0.2);
  close(first.qty * first.price * (1 + first.fee), route.notional);
  close(second.qty * second.price * (1 + second.fee), first.qty);
  close(third.qty, second.qty);
  close(third.qty * third.price * (1 - third.fee) - route.notional, route.net);
});


test("recent receipts cannot revive stale exchange events or long-running REST requests", () => {
  const cb = makeMarket("Coinbase", "BTC", "USD"), kr = makeMarket("Kraken", "BTC", "USD");
  for (const provenance of [{ receivedAt: now + 1 }, { exchangeAt: now - 30_000 }, { requestStartedAt: now - 13_000 }]) {
    const result = scan([[cb, { ...quote(99.9, 100), ...provenance }], [kr, quote(102, 102.1)]], { triangular: false });
    assert.equal(result.top.length, 0);
  }
});


test("execution ranks funded profit while the display retains each raw opportunity", () => {
  const entries: [Market, Quote][] = [
    [makeMarket("Coinbase", "A", "USD"), quote(99.9, 100)],
    [makeMarket("Kraken", "A", "USD"), quote(120, 120.1)],
    [makeMarket("Coinbase", "B", "USD"), quote(99.9, 100)],
    [makeMarket("Kraken", "B", "USD"), quote(110, 110.1)],
  ];
  const eligibleSaw: Opportunity[] = [];
  const result = scan(entries, {
    triangular: false, settings: { ...settings, coinbaseFee: 0, krakenFee: 0, buffer: 0, maxGap: 50 },
    prepare: (o) => o.net <= 0 ? null : o.coin === "A" ? { ...o, net: 0.1, notional: 0.5 } : o,
    eligible: (o) => { eligibleSaw.push(o); return true; },
  });
  assert.equal(result.best?.coin, "A");
  close(result.best!.net, 10);
  close(result.top[0].net, 10);
  assert.equal(result.bestEligible?.coin, "B");
  close(result.bestEligible!.net, 5);
  assert.equal(eligibleSaw.find((o) => o.coin === "A")?.net, 0.1, "eligibility sees prepared funding");
});

test("preparation runs even when raw profit is below the current executable leader", () => {
  const entries: [Market, Quote][] = [
    [makeMarket("Coinbase", "A", "USD"), quote(99.9, 100)],
    [makeMarket("Kraken", "A", "USD"), quote(120, 120.1)],
    [makeMarket("Coinbase", "B", "USD"), quote(99.9, 100)],
    [makeMarket("Kraken", "B", "USD"), quote(101, 101.1)],
  ];
  const result = scan(entries, {
    triangular: false, settings: { ...settings, coinbaseFee: 0, krakenFee: 0, buffer: 0, maxGap: 50 },
    prepare: (o) => o.net <= 0 ? null : { ...o, net: o.coin === "A" ? 1 : 2 },
  });
  assert.equal(result.best?.coin, "A");
  assert.equal(result.bestEligible?.coin, "B");
  assert.equal(result.bestEligible?.net, 2);
});
