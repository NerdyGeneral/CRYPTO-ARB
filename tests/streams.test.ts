import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { makeMarket } from "../lib/markets";
import { connectStreams, SILENT_SOCKET_MS } from "../lib/streams";

// A stand-in for the WebSocket global that records what the stream code does with it.
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(message: string) { this.sent.push(message); }
  close() { this.closed = true; }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
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
