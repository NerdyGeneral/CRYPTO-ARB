import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { fetchBatchBooks, fetchMarketBook } from "../lib/exchanges";
import { EXCHANGE_CLOCK_TOLERANCE_MS, quoteFresh, quoteSequence, validQuote } from "../lib/market";
import { keyOf, makeMarket } from "../lib/markets";

test("freshness preserves provenance and bounds clock uncertainty without treating receipt time as event time", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const now = Date.now();
    const q = validQuote(100, 1, 101, 2, "poll", { requestStartedAt: now - 200, exchangeAt: now - 100, sequence: "9007199254740993" })!;
    assert.equal(q.receivedAt, now); assert.equal(q.requestStartedAt, now - 200); assert.equal(q.exchangeAt, now - 100);
    assert.equal(quoteSequence("9007199254740993"), "9007199254740993");
    assert.equal(quoteSequence(9007199254740992), undefined);
    assert.equal(quoteFresh(q, now + 11_900), false); // Request age, not the later response receipt.
    assert.equal(quoteFresh({ ...q, receivedAt: now + 1 }, now), false);
    assert.equal(validQuote(100, 1, 101, 1, "stream", { exchangeAt: now + EXCHANGE_CLOCK_TOLERANCE_MS + 1 }), null);
    assert.equal(validQuote(100, 1, 101, 1, "stream", { exchangeAt: now - 12_000 - EXCHANGE_CLOCK_TOLERANCE_MS - 1 }), null);
    assert.equal(validQuote(100, 1, 101, 1, "stream", { exchangeAt: NaN }), null);
    assert.ok(validQuote(100, 1, 101, 1, "stream", { exchangeAt: now + 1000 }));
    // A caller with a synchronized clock can enforce a tighter uncertainty bound.
    assert.equal(quoteFresh({ ...q, exchangeAt: now + 1000 }, now, 12_000, 100), false);
  } finally { mock.timers.reset(); }
});

test("REST book records request start independently from later response receipt", async () => {
  const original = globalThis.fetch;
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const requestAt = Date.now();
    globalThis.fetch = (async () => {
      mock.timers.tick(350);
      return new Response(JSON.stringify({ bids: [[100, 1]], asks: [[101, 2]], sequence: "123456789012345678" }));
    }) as typeof fetch;
    const quote = await fetchMarketBook(makeMarket("Coinbase", "BTC", "USD"));
    assert.equal(quote.requestStartedAt, requestAt);
    assert.equal(quote.receivedAt, requestAt + 350);
    assert.equal(quote.sequence, "123456789012345678");
    assert.equal(quote.exchangeAt, undefined); // Coinbase snapshot has no event timestamp.
  } finally { globalThis.fetch = original; mock.timers.reset(); }
});

test("REST Bitstamp timestamp is preserved and stale snapshots fail closed", async () => {
  const original = globalThis.fetch;
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    let age = 100;
    globalThis.fetch = (async () => new Response(JSON.stringify({ bids: [[100, 1]], asks: [[101, 2]], microtimestamp: String((Date.now() - age) * 1000) }))) as typeof fetch;
    const quote = await fetchMarketBook(makeMarket("Bitstamp", "BTC", "USD"));
    assert.equal(quote.exchangeAt, Date.now() - 100);
    age = 60_000;
    await assert.rejects(fetchMarketBook(makeMarket("Bitstamp", "BTC", "USD")), /invalid book/);
  } finally { globalThis.fetch = original; mock.timers.reset(); }
});

test("batch responses preserve per-request start and individual event times", async () => {
  const original = globalThis.fetch;
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const start = Date.now();
    globalThis.fetch = (async () => {
      mock.timers.tick(200);
      return new Response(JSON.stringify({ code: "0", data: [
        { instId: "BTC-USD", bidPx: "100", bidSz: "1", askPx: "101", askSz: "2", ts: String(start) },
        { instId: "ETH-USD", bidPx: "10", bidSz: "1", askPx: "11", askSz: "2", ts: String(start - 60_000) },
      ] }));
    }) as typeof fetch;
    const btc = makeMarket("OKX US", "BTC", "USD"), eth = makeMarket("OKX US", "ETH", "USD");
    const books = await fetchBatchBooks("OKX US", [btc, eth]);
    assert.equal(books.get(keyOf(btc))?.requestStartedAt, start);
    assert.equal(books.get(keyOf(btc))?.exchangeAt, start);
    assert.equal(books.get(keyOf(btc))?.receivedAt, start + 200);
    assert.equal(books.has(keyOf(eth)), false);
  } finally { globalThis.fetch = original; mock.timers.reset(); }
});
