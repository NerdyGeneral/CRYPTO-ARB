import { supportedPair, validQuote, type Quote, type SymbolName, type Universe, type Venue } from "./market";
import { usdMarket, type Market } from "./markets";

type OnQuote = (symbol: SymbolName, venue: Venue, quote: Quote) => void;
type OnStale = (symbol: SymbolName, venue: Venue) => void;
type OnMarketQuote = (market: Market, quote: Quote) => void;
type OnMarketStale = (market: Market) => void;

// A price-level book that keeps its best bid and ask current without rescanning every level;
// only removing the best level forces a scan.
class Book {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  private bestBid = -Infinity;
  private bestAsk = Infinity;

  static from(bids: unknown, asks: unknown) {
    const book = new Book();
    for (const [rows, side] of [[bids, "bid"], [asks, "ask"]] as const) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) if (Array.isArray(row)) book.set(side, Number(row[0]), Number(row[1]));
    }
    return book;
  }

  set(side: "bid" | "ask", price: number, size: number) {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) return;
    const levels = side === "bid" ? this.bids : this.asks;
    if (size === 0) {
      levels.delete(price);
      if (side === "bid" && price === this.bestBid) { this.bestBid = -Infinity; for (const p of levels.keys()) if (p > this.bestBid) this.bestBid = p; }
      if (side === "ask" && price === this.bestAsk) { this.bestAsk = Infinity; for (const p of levels.keys()) if (p < this.bestAsk) this.bestAsk = p; }
      return;
    }
    levels.set(price, size);
    if (side === "bid" && price > this.bestBid) this.bestBid = price;
    if (side === "ask" && price < this.bestAsk) this.bestAsk = price;
  }

  quote() {
    return validQuote(this.bestBid, this.bids.get(this.bestBid), this.bestAsk, this.asks.get(this.bestAsk), "stream");
  }
}

const streamUrl: Record<Venue, string | null> = {
  Coinbase: "wss://ws-feed.exchange.coinbase.com",
  Kraken: "wss://ws.kraken.com/v2",
  Gemini: "wss://ws.gemini.com",
  Bitstamp: "wss://ws.bitstamp.net",
  "CEX.IO": "wss://trade.cex.io/api/spot/ws-public",
  "OKX US": "wss://wsus.okx.com:8443/ws/v5/public",
  "Crypto.com": "wss://stream.crypto.com/exchange/v1/market",
  "Binance.US": "wss://stream.binance.us:9443/stream",
  bitFlyer: null, // REST only
};

// CEX.IO limits each IP to about 100 requests a minute (subscribes and pings included) and answers
// "API rate limit reached" then disconnects; Bitstamp takes one subscribe message per book. Both are paced
// through one queue per venue shared by every socket: CEX.IO at one subscribe a second on a single socket,
// which with its ping every 8s stays near 70 requests a minute.
const maxPerSocket: Partial<Record<Venue, number>> = { "CEX.IO": 100, "Binance.US": 1000 };
const subscribeGapMs: Partial<Record<Venue, number>> = { "CEX.IO": 1000, Bitstamp: 25 };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A socket that has received nothing for this long (not even a heartbeat) is treated as dead: after a network
// drop a connection can stay half-open without ever closing, so it is abandoned and replaced.
export const SILENT_SOCKET_MS = 90_000;
const WATCHDOG_MS = 10_000;
// OKX closes connections idle for 30s, so a text ping keeps quiet ones open.
const textPing: Partial<Record<Venue, number>> = { "OKX US": 20_000 };
const nextSlot = new Map<Venue, number>();
// Reserves the venue's next send slot and returns how long to wait for it.
const slotDelay = (venue: Venue) => {
  const gap = subscribeGapMs[venue] || 0, now = Date.now();
  const at = Math.max(now, nextSlot.get(venue) || 0);
  nextSlot.set(venue, at + gap);
  return at - now;
};

// Streams best bid/ask for any set of markets. Browser sockets are scoped to the open tab and pause
// while it is hidden; outside a browser (the background engine) they always run.
export function connectStreams(markets: Market[], onQuote: OnMarketQuote, onStale?: OnMarketStale): () => void {
  if (typeof WebSocket === "undefined") return () => {};
  let stopped = false;
  const sockets: WebSocket[] = [];
  type Timer = ReturnType<typeof setTimeout>;
  const timers: Timer[] = [];
  const page = typeof document === "undefined" ? undefined : document;
  const isVisible = () => !page?.hidden;

  const connect = (venue: Venue, url: string, list: Market[]) => {
    const byName = new Map(list.map((market) => [market.ws.toLowerCase(), market]));
    const find = (name: unknown) => byName.get(String(name ?? "").toLowerCase());
    let socket: WebSocket | null = null;
    let attempts = 0;
    let reconnectTimer: Timer | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let lastMessageAt = 0;
    let books = new Map<Market, Book>();
    let cexBooks = new Map<Market, { book: Book; seqId: number }>();
    let resyncing = new Set<Market>();
    const cexSubscribe = (market: Market) => JSON.stringify({ e: "order_book_subscribe", oid: `${market.ws}-${Date.now()}`, data: { pair: market.ws } });
    const start = () => {
      if (stopped || !isVisible()) return;
      books = new Map();
      cexBooks = new Map();
      resyncing = new Set();
      try { socket = new WebSocket(url); } catch { schedule(); return; }
      const ws = socket;
      sockets.push(ws);
      lastMessageAt = Date.now();
      // Sends one message per book in the venue's shared send slots, until the socket closes.
      const paced = async (messages: string[]) => {
        for (const message of messages) {
          const delay = slotDelay(venue);
          if (delay) await pause(delay);
          if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(message);
        }
      };
      ws.onopen = () => {
        attempts = 0;
        const names = list.map((market) => market.ws);
        if (venue === "Coinbase") {
          // level2_batch is the fastest public Coinbase book: measured side by side on the same 40 books, the
          // unbatched Advanced Trade level2 feed showed a new best bid/ask about 50 ms later (first in only 7-8% of
          // cases, with 3.6x the data), and the ticker channel about 110 ms later.
          ws.send(JSON.stringify({ type: "subscribe", product_ids: names, channels: ["level2_batch"] }));
        } else if (venue === "Kraken") {
          ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: names, event_trigger: "bbo", snapshot: true } }));
        } else if (venue === "Gemini") {
          ws.send(JSON.stringify({ id: String(Date.now()), method: "subscribe", params: names.map((name) => `${name}@bookTicker`) }));
        } else if (venue === "Bitstamp") {
          void paced(names.map((name) => JSON.stringify({ event: "bts:subscribe", data: { channel: `order_book_${name}` } })));
        } else if (venue === "CEX.IO") {
          void paced(list.map(cexSubscribe));
          heartbeatTimer = setInterval(() => { if (socket === ws) ws.send(JSON.stringify({ e: "ping" })); }, 8000);
        } else if (venue === "OKX US") {
          ws.send(JSON.stringify({ id: String(Date.now()), op: "subscribe", args: names.map((instId) => ({ channel: "bbo-tbt", instId })) }));
          heartbeatTimer = setInterval(() => { if (socket === ws) ws.send("ping"); }, textPing[venue]);
        } else if (venue === "Binance.US") {
          for (let i = 0; i < names.length; i += 200)
            ws.send(JSON.stringify({ method: "SUBSCRIBE", params: names.slice(i, i + 200).map((name) => `${name}@bookTicker`), id: i + 1 }));
        } else {
          ws.send(JSON.stringify({ id: Date.now(), method: "subscribe", nonce: Date.now(), params: { channels: names.map((name) => `ticker.${name}`) } }));
        }
      };
      ws.onmessage = (event) => {
        lastMessageAt = Date.now();
        try {
          if (event.data === "ping") { ws.send("pong"); return; }
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          const emit = (market: Market | undefined, quote: Quote | null) => { if (market && quote) onQuote(market, quote); };
          if (venue === "Gemini") {
            emit(find(message.s), validQuote(message.b, message.B, message.a, message.A, "stream"));
          } else if (venue === "Binance.US") {
            const data = message.data as Record<string, unknown> | undefined;
            if (data) emit(find(data.s), validQuote(data.b, data.B, data.a, data.A, "stream"));
          } else if (venue === "Bitstamp") {
            if (message.event === "bts:request_reconnect") { ws.close(); return; }
            if (message.event !== "data") return;
            const depth = message.data as { bids?: unknown[][]; asks?: unknown[][] } | undefined;
            emit(find(String(message.channel || "").replace(/^order_book_/, "")),
              validQuote(depth?.bids?.[0]?.[0], depth?.bids?.[0]?.[1], depth?.asks?.[0]?.[0], depth?.asks?.[0]?.[1], "stream"));
          } else if (venue === "CEX.IO") {
            if (message.e === "disconnected") { ws.close(); return; }
            if (message.ok !== "ok" || (message.e !== "order_book_subscribe" && message.e !== "order_book_increment")) return;
            const data = message.data as { pair?: string; seqId?: number; bids?: unknown[][]; asks?: unknown[][] } | undefined;
            const market = find(data?.pair);
            if (!market) return;
            if (message.e === "order_book_subscribe") {
              if (!Number.isSafeInteger(data?.seqId)) return;
              cexBooks.set(market, { book: Book.from(data?.bids, data?.asks), seqId: data!.seqId! });
              resyncing.delete(market);
            } else {
              const entry = cexBooks.get(market);
              if (!entry || data?.seqId !== entry.seqId + 1) {
                cexBooks.delete(market);
                onStale?.(market);
                if (!resyncing.has(market)) { resyncing.add(market); void paced([cexSubscribe(market)]); }
                return;
              }
              entry.seqId = data!.seqId!;
              for (const row of data?.bids || []) if (Array.isArray(row)) entry.book.set("bid", Number(row[0]), Number(row[1]));
              for (const row of data?.asks || []) if (Array.isArray(row)) entry.book.set("ask", Number(row[0]), Number(row[1]));
            }
            emit(market, cexBooks.get(market)?.book.quote() ?? null);
          } else if (venue === "OKX US") {
            const arg = message.arg as { channel?: string; instId?: string } | undefined;
            if (arg?.channel !== "bbo-tbt" || !Array.isArray(message.data)) return;
            const depth = (message.data as { bids?: unknown[][]; asks?: unknown[][] }[])[0];
            emit(find(arg.instId), validQuote(depth?.bids?.[0]?.[0], depth?.bids?.[0]?.[1], depth?.asks?.[0]?.[0], depth?.asks?.[0]?.[1], "stream"));
          } else if (venue === "Crypto.com") {
            if (message.method === "public/heartbeat") { ws.send(JSON.stringify({ id: message.id, method: "public/respond-heartbeat" })); return; }
            const result = message.result as { channel?: string; instrument_name?: string; data?: Record<string, unknown>[] } | undefined;
            if (result?.channel !== "ticker" || !Array.isArray(result.data)) return;
            for (const tick of result.data) emit(find(tick.i || result.instrument_name), validQuote(tick.b, tick.bs, tick.k, tick.ks, "stream"));
          } else if (venue === "Kraken") {
            if (message.channel !== "ticker" || !Array.isArray(message.data)) return;
            for (const ticker of message.data as Record<string, unknown>[]) emit(find(ticker.symbol), validQuote(ticker.bid, ticker.bid_qty, ticker.ask, ticker.ask_qty, "stream"));
          } else {
            const market = find(message.product_id);
            if (!market) return;
            if (message.type === "snapshot") {
              books.set(market, Book.from(message.bids, message.asks));
            } else if (message.type === "l2update") {
              const book = books.get(market);
              if (!book || !Array.isArray(message.changes)) return;
              for (const change of message.changes as unknown[][]) {
                if (Array.isArray(change) && (change[0] === "buy" || change[0] === "sell")) book.set(change[0] === "buy" ? "bid" : "ask", Number(change[1]), Number(change[2]));
              }
            } else return;
            emit(market, books.get(market)?.quote() ?? null);
          }
        } catch { /* Ignore malformed exchange messages; the REST fallback remains available. */ }
      };
      // Node's WebSocket fires error again from inside close() on a failed connection; close once.
      let closing = false;
      ws.onerror = () => { if (closing) return; closing = true; ws.close(); };
      ws.onclose = () => { if (socket === ws) abandon(); };
    };
    // Forgets the current socket and its books and schedules a new connection. A late close event from the
    // abandoned socket is ignored because it is no longer the current one.
    const abandon = () => {
      socket = null; books.clear(); cexBooks.clear();
      for (const market of list) onStale?.(market);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      schedule();
    };
    const watchdog = setInterval(() => {
      const ws = socket;
      if (!ws || Date.now() - lastMessageAt < SILENT_SOCKET_MS) return;
      abandon();
      try { ws.close(); } catch { /* Already closed. */ }
    }, WATCHDOG_MS);
    const schedule = () => {
      if (stopped || !isVisible()) return;
      reconnectTimer = setTimeout(start, Math.min(10000, 1000 * 2 ** Math.min(attempts++, 4)));
      timers.push(reconnectTimer);
    };
    const visibility = () => {
      if (!isVisible()) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        socket?.close();
      } else if (!socket) start();
    };
    page?.addEventListener("visibilitychange", visibility);
    start();
    return () => { clearInterval(watchdog); page?.removeEventListener("visibilitychange", visibility); };
  };

  const byVenue = new Map<Venue, Market[]>();
  for (const market of markets) byVenue.set(market.venue, [...(byVenue.get(market.venue) || []), market]);
  const cleanups: (() => void)[] = [];
  for (const [venue, list] of byVenue) {
    const url = streamUrl[venue];
    const size = maxPerSocket[venue] || list.length;
    if (url) for (let i = 0; i < list.length; i += size) cleanups.push(connect(venue, url, list.slice(i, i + size)));
  }
  return () => {
    stopped = true;
    cleanups.forEach((cleanup) => cleanup());
    timers.forEach((timer) => clearTimeout(timer));
    sockets.forEach((socket) => socket.close());
  };
}

// The dashboard's USD universe, expressed as markets.
export function connectMarketStreams(universe: Universe, onQuote: OnQuote, onStale?: OnStale): () => void {
  const markets = universe.venues.flatMap((venue) => universe.assets.filter((asset) => supportedPair(asset, venue)).map((asset) => usdMarket(asset, venue)));
  return connectStreams(markets,
    (market, quote) => onQuote(market.base as SymbolName, market.venue, quote),
    (market) => onStale?.(market.base as SymbolName, market.venue));
}
