import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { makeMarket } from "../lib/markets";
import { connectStreams, SILENT_SOCKET_MS } from "../lib/streams";
import type { Quote } from "../lib/market";

// A stand-in for the WebSocket global that records what the stream code does with it.
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  closeCount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(message: string) { this.sent.push(message); }
  close() { this.closed = true; this.closeCount++; }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  emit(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

test("a socket that goes silent is abandoned and replaced, and its late close is ignored", () => {
  const original = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    FakeSocket.instances = [];
    const market = makeMarket("Kraken", "BTC", "USD", { ws: "BTC/USD" });
    const quotes: number[] = [], stale: string[] = [];
    const stop = connectStreams([market], (_, quote) => quotes.push(quote.bid), (m) => stale.push(m.base));
    const first = FakeSocket.instances[0];
    first.open();
    first.onmessage?.({ data: JSON.stringify({ channel: "ticker", data: [{ symbol: "BTC/USD", bid: 100, bid_qty: 1, ask: 101, ask_qty: 1 }] }) });
    assert.deepEqual(quotes, [100]);

    // Heartbeats keep it alive.
    for (let i = 0; i < 12; i++) { mock.timers.tick(10_000); first.onmessage?.({ data: '{"channel":"heartbeat"}' }); }
    assert.equal(FakeSocket.instances.length, 1);
    assert.equal(first.closed, false);

    // Then nothing arrives: after the silence limit it is closed and marked stale, and a new socket follows.
    mock.timers.tick(SILENT_SOCKET_MS + 10_000);
    assert.equal(first.closed, true);
    assert.deepEqual(stale, ["BTC"]);
    mock.timers.tick(2_000);
    assert.equal(FakeSocket.instances.length, 2);

    // The abandoned socket's close event arriving late must not schedule yet another connection.
    first.onclose?.();
    mock.timers.tick(20_000);
    assert.equal(FakeSocket.instances.length, 2);
    stop();
  } finally {
    mock.timers.reset();
    (globalThis as { WebSocket: unknown }).WebSocket = original;
  }
});

test("a connection that never opens is retried", () => {
  const original = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    FakeSocket.instances = [];
    const stop = connectStreams([makeMarket("Gemini", "ETH", "USD", { ws: "ethusd" })], () => {});
    mock.timers.tick(SILENT_SOCKET_MS + 10_000);
    mock.timers.tick(2_000);
    assert.equal(FakeSocket.instances.length, 2);
    assert.equal(FakeSocket.instances[0].closed, true);
    stop();
  } finally {
    mock.timers.reset();
    (globalThis as { WebSocket: unknown }).WebSocket = original;
  }
});

test("retired socket callbacks cannot publish or reconnect, and cleanup retains only the active socket", () => {
  const original = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  try {
    FakeSocket.instances = [];
    const quotes: Quote[] = [];
    const stop = connectStreams([makeMarket("Kraken", "BTC", "USD")], (_, q) => quotes.push(q));
    const tick = (bid: number) => ({ channel: "ticker", data: [{ symbol: "BTC/USD", bid, bid_qty: 1, ask: bid + 1, ask_qty: 1 }] });
    const first = FakeSocket.instances[0]; first.open(); first.emit(tick(100));
    const lateMessage = first.onmessage!, lateOpen = first.onopen!, lateClose = first.onclose!;
    for (let n = 0; n < 5; n++) {
      const old = FakeSocket.instances.at(-1)!;
      old.onclose?.();
      mock.timers.tick(1000);
      const next = FakeSocket.instances.at(-1)!; next.open();
      assert.equal(old.onmessage, null);
      assert.equal(old.onclose, null);
      assert.equal(old.onopen, null);
      assert.equal(old.closeCount, 1);
    }
    const current = FakeSocket.instances.at(-1)!; current.emit(tick(200));
    lateMessage({ data: JSON.stringify(tick(50)) }); lateOpen(); lateClose();
    assert.deepEqual(quotes.map((q) => q.bid), [100, 200]);
    assert.notEqual(quotes[0].connectionId, quotes[1].connectionId);
    const sent = first.sent.length;
    stop(); lateOpen(); lateMessage({ data: JSON.stringify(tick(50)) });
    mock.timers.tick(200_000);
    assert.equal(FakeSocket.instances.length, 6);
    assert.equal(first.sent.length, sent);
    assert.ok(FakeSocket.instances.every((ws) => ws.closeCount === 1));
  } finally { mock.timers.reset(); (globalThis as { WebSocket: unknown }).WebSocket = original; }
});

test("an empty or crossed BBO invalidates immediately and a valid update restores it", () => {
  const original = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  try {
    FakeSocket.instances = [];
    let count = 0, stale = 0;
    const stop = connectStreams([makeMarket("Kraken", "BTC", "USD")], () => count++, () => stale++);
    const ws = FakeSocket.instances[0]; ws.open();
    const tick = (bid: number, bid_qty = 1) => ws.emit({ channel: "ticker", data: [{ symbol: "BTC/USD", bid, bid_qty, ask: 101, ask_qty: 1 }] });
    tick(100); tick(100, 0); tick(102); tick(100);
    assert.equal(count, 2); assert.equal(stale, 2);
    stop();
  } finally { (globalThis as { WebSocket: unknown }).WebSocket = original; }
});

test("CEX sequence gaps invalidate until a replacement snapshot arrives", () => {
  const original = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  try {
    FakeSocket.instances = [];
    const quotes: Quote[] = []; let stale = 0;
    const stop = connectStreams([makeMarket("CEX.IO", "BTC", "USD")], (_, q) => quotes.push(q), () => stale++);
    const ws = FakeSocket.instances[0]; ws.open();
    const frame = (e: string, seqId: number) => ws.emit({ e, ok: "ok", data: { pair: "BTC-USD", seqId, bids: [[100, 1]], asks: [[101, 1]] } });
    frame("order_book_subscribe", 10); frame("order_book_increment", 12); frame("order_book_increment", 13);
    assert.equal(quotes.length, 1); assert.ok(stale >= 1);
    frame("order_book_subscribe", 20); frame("order_book_increment", 21);
    assert.deepEqual(quotes.map((q) => q.sequence), ["10", "20", "21"]);
    stop();
  } finally { mock.timers.reset(); (globalThis as { WebSocket: unknown }).WebSocket = original; }
});

test("Gemini timestamps use nanoseconds and stale or out-of-order events cannot refresh a quote", () => {
  const original = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    FakeSocket.instances = [];
    const quotes: Quote[] = []; let stale = 0;
    const stop = connectStreams([makeMarket("Gemini", "BTC", "USD")], (_, q) => quotes.push(q), () => stale++);
    const ws = FakeSocket.instances[0]; ws.open();
    const tick = (u: number, eventMs: number, bid = 100) => ws.emit({ s: "btcusd", u, E: eventMs * 1_000_000, b: bid, B: 1, a: bid + 1, A: 1 });
    tick(10, Date.now()); tick(9, Date.now(), 90); tick(10, Date.now(), 90);
    assert.equal(quotes.length, 1); assert.equal(quotes[0].exchangeAt, Date.now()); assert.equal(quotes[0].sequence, "10");
    tick(11, Date.now() - 20_000); tick(12, Date.now() + 10_000);
    assert.equal(quotes.length, 1); assert.equal(stale, 2);
    stop();
  } finally { mock.timers.reset(); (globalThis as { WebSocket: unknown }).WebSocket = original; }
});

test("a Coinbase obsolete delta cannot mutate the current book", () => {
  const original = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    FakeSocket.instances = [];
    const quotes: Quote[] = [];
    const stop = connectStreams([makeMarket("Coinbase", "BTC", "USD")], (_, q) => quotes.push(q));
    const ws = FakeSocket.instances[0]; ws.open();
    ws.emit({ type: "snapshot", product_id: "BTC-USD", bids: [[100, 1]], asks: [[101, 1]] });
    const delta = (at: number, changes: unknown[][]) => ws.emit({ type: "l2update", product_id: "BTC-USD", time: new Date(at).toISOString(), changes });
    delta(Date.now(), [["buy", 100, 2]]);
    delta(Date.now() - 1, [["buy", 100, 0]]);
    delta(Date.now(), [["sell", 101, 2]]);
    assert.equal(quotes.at(-1)?.bid, 100); assert.equal(quotes.at(-1)?.bidSize, 2);
    delta(Date.now(), [["buy", 100, 0]]);
    assert.equal(quotes.length, 3);
    stop();
  } finally { mock.timers.reset(); (globalThis as { WebSocket: unknown }).WebSocket = original; }
});

test("a malformed delta invalidates the book and requests a new connection", () => {
  const original = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  try {
    FakeSocket.instances = [];
    let quotes = 0, stale = 0;
    const stop = connectStreams([makeMarket("Coinbase", "BTC", "USD")], () => quotes++, () => stale++);
    const ws = FakeSocket.instances[0]; ws.open();
    ws.emit({ type: "snapshot", product_id: "BTC-USD", bids: [[100, 1]], asks: [[101, 1]] });
    ws.emit({ type: "l2update", product_id: "BTC-USD", changes: [["buy", "bad-price", "1"]] });
    assert.equal(quotes, 1); assert.equal(stale, 1); assert.equal(ws.closed, true);
    mock.timers.tick(1000);
    assert.equal(FakeSocket.instances.length, 2);
    stop();
  } finally { mock.timers.reset(); (globalThis as { WebSocket: unknown }).WebSocket = original; }
});
