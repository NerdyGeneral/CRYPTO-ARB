import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { Engine } from "../engine/engine";
import { defaultConfig, Store } from "../engine/store";
import type { Quote, Venue } from "../lib/market";
import { keyOf, makeMarket, type Market } from "../lib/markets";
import { indexRoutes, type RouteIndex } from "../lib/opportunities";

class FeedSocket {
  static readonly OPEN = 1;
  static instances: FeedSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FeedSocket.instances.push(this); }
  send() {}
  close() {}
  open() { this.readyState = FeedSocket.OPEN; this.onopen?.(); }
  emit(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

// The harness seeds the discovered market list without starting discovery, probes, timers or trading.
type FeedInternals = {
  markets: Market[]; marketByKey: Map<string, Market>; index: RouteIndex;
  quotes: Map<string, Quote>; streamedAt: Map<string, number>; inFlight: Set<string>;
  connect(): void; pollRest(): void; freshQuote(key: string): Quote | undefined;
};
function harness(venue: Venue) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-feeds-"));
  const store = new Store(dir);
  const engine = new Engine({ ...defaultConfig, venues: [venue], carry: { ...defaultConfig.carry, enabled: false } }, store);
  const internal = engine as unknown as FeedInternals;
  const market = makeMarket(venue, "BTC", "USD");
  internal.markets = [market]; internal.marketByKey = new Map([[keyOf(market), market]]); internal.index = indexRoutes([market]);
  internal.connect();
  const socket = FeedSocket.instances.at(-1)!; socket.open();
  return { engine, internal, market, socket, dispose: async () => { await engine.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const settleCallbacks = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
function streamBook(socket: FeedSocket, venue: Venue, bid: number, size = 1) {
  socket.emit(venue === "Coinbase"
    ? { type: "snapshot", product_id: "BTC-USD", bids: [[bid, size]], asks: [[bid + 1, size]] }
    : { channel: "ticker", data: [{ symbol: "BTC/USD", bid, bid_qty: size, ask: bid + 1, ask_qty: size }] });
}
function restBook(market: Market, bid: number) {
  return new Response(JSON.stringify(market.venue === "Coinbase"
    ? { bids: [[bid, 1]], asks: [[bid + 1, 1]] }
    : { error: [], result: { [market.batch || market.rest]: { b: [String(bid), "1", "1"], a: [String(bid + 1), "1", "1"] } } }));
}

test("engine removes a CEX sequence-gap book from scans and delayed fills immediately", async () => {
  const originalSocket = globalThis.WebSocket, originalFetch = globalThis.fetch;
  (globalThis as { WebSocket: unknown }).WebSocket = FeedSocket;
  globalThis.fetch = async () => { throw new Error("unexpected network request"); };
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const h = harness("CEX.IO");
  try {
    h.socket.emit({ e: "order_book_subscribe", ok: "ok", data: { pair: "BTC-USD", seqId: 10, bids: [[100, 1]], asks: [[101, 1]] } });
    assert.ok(h.internal.freshQuote(keyOf(h.market)));
    h.socket.emit({ e: "order_book_increment", ok: "ok", data: { pair: "BTC-USD", seqId: 12, bids: [], asks: [] } });
    assert.equal(h.internal.quotes.has(keyOf(h.market)), false);
    assert.equal(h.internal.streamedAt.has(keyOf(h.market)), false);
    assert.equal(h.internal.freshQuote(keyOf(h.market)), undefined);
    h.socket.emit({ e: "order_book_subscribe", ok: "ok", data: { pair: "BTC-USD", seqId: 20, bids: [[102, 1]], asks: [[103, 1]] } });
    assert.equal(h.internal.freshQuote(keyOf(h.market))?.bid, 102);
  } finally { await h.dispose(); mock.timers.reset(); globalThis.WebSocket = originalSocket; globalThis.fetch = originalFetch; }
});

for (const venue of ["Coinbase", "Kraken"] as const) {
  test(`${venue}: REST started before a newer stream quote cannot overwrite it`, async () => {
    const originalSocket = globalThis.WebSocket, originalFetch = globalThis.fetch;
    (globalThis as { WebSocket: unknown }).WebSocket = FeedSocket;
    const response = deferredResponse();
    globalThis.fetch = async () => response.promise;
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const h = harness(venue);
    try {
      h.internal.pollRest();
      assert.equal(h.internal.inFlight.size, 1);
      mock.timers.tick(10); streamBook(h.socket, venue, 200);
      mock.timers.tick(10); response.resolve(restBook(h.market, 100));
      await settleCallbacks();
      assert.equal(h.internal.inFlight.size, 0);
      assert.equal(h.internal.quotes.get(keyOf(h.market))?.bid, 200);
      assert.equal(h.internal.quotes.get(keyOf(h.market))?.source, "stream");
    } finally { await h.dispose(); mock.timers.reset(); globalThis.WebSocket = originalSocket; globalThis.fetch = originalFetch; }
  });

  test(`${venue}: an in-flight REST response cannot resurrect an invalidated book`, async () => {
    const originalSocket = globalThis.WebSocket, originalFetch = globalThis.fetch;
    (globalThis as { WebSocket: unknown }).WebSocket = FeedSocket;
    const response = deferredResponse();
    globalThis.fetch = async () => response.promise;
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const h = harness(venue);
    try {
      h.internal.pollRest();
      mock.timers.tick(10); streamBook(h.socket, venue, 200);
      mock.timers.tick(10); streamBook(h.socket, venue, 200, 0);
      assert.equal(h.internal.freshQuote(keyOf(h.market)), undefined);
      mock.timers.tick(10); response.resolve(restBook(h.market, 100));
      await settleCallbacks();
      assert.equal(h.internal.inFlight.size, 0);
      assert.equal(h.internal.quotes.has(keyOf(h.market)), false);
      assert.equal(h.internal.freshQuote(keyOf(h.market)), undefined);
      // A request genuinely begun after invalidation may restore the market.
      mock.timers.tick(4000);
      globalThis.fetch = async () => restBook(h.market, 300);
      h.internal.pollRest(); await settleCallbacks();
      assert.equal(h.internal.freshQuote(keyOf(h.market))?.bid, 300);
    } finally { await h.dispose(); mock.timers.reset(); globalThis.WebSocket = originalSocket; globalThis.fetch = originalFetch; }
  });

  test(`${venue}: a failed old REST request does not invalidate a newer streamed book`, async () => {
    const originalSocket = globalThis.WebSocket, originalFetch = globalThis.fetch;
    (globalThis as { WebSocket: unknown }).WebSocket = FeedSocket;
    const response = deferredResponse();
    globalThis.fetch = async () => response.promise;
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const h = harness(venue);
    try {
      h.internal.pollRest();
      mock.timers.tick(10); streamBook(h.socket, venue, 200);
      mock.timers.tick(10); response.resolve(new Response("unavailable", { status: 503 }));
      await settleCallbacks();
      assert.equal(h.internal.freshQuote(keyOf(h.market))?.bid, 200);
    } finally { await h.dispose(); mock.timers.reset(); globalThis.WebSocket = originalSocket; globalThis.fetch = originalFetch; }
  });
}

test("reset rejects pre-reset REST work while the existing stream continues accepting prices", async () => {
  const originalSocket = globalThis.WebSocket, originalFetch = globalThis.fetch;
  (globalThis as { WebSocket: unknown }).WebSocket = FeedSocket;
  const response = deferredResponse();
  globalThis.fetch = async () => response.promise;
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const h = harness("Kraken");
  try {
    h.internal.pollRest();
    mock.timers.tick(10);
    await h.engine.resetSession();
    mock.timers.tick(10); response.resolve(restBook(h.market, 100));
    await settleCallbacks();
    assert.equal(h.internal.quotes.has(keyOf(h.market)), false, "pre-reset response must be discarded");
    streamBook(h.socket, "Kraken", 200);
    assert.equal(h.internal.freshQuote(keyOf(h.market))?.bid, 200, "reset must not disable the existing stream callback");
  } finally { await h.dispose(); mock.timers.reset(); globalThis.WebSocket = originalSocket; globalThis.fetch = originalFetch; }
});
