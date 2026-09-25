import { supportedPair, validQuote, type Quote, type SymbolName, type Universe, type Venue } from "./market";

type OnQuote = (symbol: SymbolName, venue: Venue, quote: Quote) => void;
type OnStale = (symbol: SymbolName, venue: Venue) => void;
type Levels = { bids: Map<number, number>; asks: Map<number, number> };

function asLevels(rows: unknown): Map<number, number> {
  const levels = new Map<number, number>();
  if (!Array.isArray(rows)) return levels;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const price = Number(row[0]), size = Number(row[1]);
    if (Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0) levels.set(price, size);
  }
  return levels;
}

function bestOf(levels: Map<number, number>, side: "bid" | "ask"): [number, number] | null {
  let best = side === "bid" ? -Infinity : Infinity;
  for (const price of levels.keys()) if (side === "bid" ? price > best : price < best) best = price;
  return Number.isFinite(best) ? [best, levels.get(best)!] : null;
}

// Browser sockets are scoped to the open tab. Reconnects restore Coinbase books from a new snapshot.
export function connectMarketStreams(universe: Universe, onQuote: OnQuote, onStale?: OnStale): () => void {
  if (typeof WebSocket === "undefined") return () => {};
  let stopped = false;
  const sockets: WebSocket[] = [];
  type Timer = ReturnType<typeof setTimeout>;
  const timers: Timer[] = [];
  // Outside a browser (the background engine) there is no page visibility, so streams always run.
  const page = typeof document === "undefined" ? undefined : document;
  const isVisible = () => !page?.hidden;

  const connect = (venue: "Coinbase" | "Kraken" | "Gemini" | "Bitstamp" | "CEX.IO" | "OKX US" | "Crypto.com", url: string) => {
    let socket: WebSocket | null = null;
    let attempts = 0;
    let reconnectTimer: Timer | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let books = new Map<SymbolName, Levels>();
    let cexBooks = new Map<SymbolName, Levels & { seqId: number }>();
    let resyncing = new Set<SymbolName>();
    const start = () => {
      const assets = universe.assets.filter((asset) => supportedPair(asset, venue));
      if (stopped || !isVisible() || !universe.venues.includes(venue) || !assets.length) return;
      books = new Map();
      cexBooks = new Map();
      resyncing = new Set();
      try { socket = new WebSocket(url); } catch { schedule(); return; }
      const ws = socket;
      sockets.push(ws);
      ws.onopen = () => {
        attempts = 0;
        if (venue === "Coinbase") {
          ws.send(JSON.stringify({ type: "subscribe", product_ids: assets.map((asset) => `${asset}-USD`), channels: ["level2_batch"] }));
        } else if (venue === "Kraken") {
          ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: assets.map((asset) => `${asset}/USD`), event_trigger: "bbo", snapshot: true } }));
        } else if (venue === "Gemini") {
          ws.send(JSON.stringify({ id: String(Date.now()), method: "subscribe", params: assets.map((asset) => `${asset.toLowerCase()}usd@bookTicker`) }));
        } else if (venue === "Bitstamp") {
          for (const asset of assets) ws.send(JSON.stringify({ event: "bts:subscribe", data: { channel: `order_book_${asset.toLowerCase()}usd` } }));
        } else if (venue === "CEX.IO") {
          for (const asset of assets) ws.send(JSON.stringify({ e: "order_book_subscribe", oid: `${asset}-${Date.now()}`, data: { pair: `${asset}-USD` } }));
          heartbeatTimer = setInterval(() => { if (socket === ws) ws.send(JSON.stringify({ e: "ping" })); }, 8000);
        } else if (venue === "OKX US") {
          ws.send(JSON.stringify({ id: String(Date.now()), op: "subscribe", args: assets.map((asset) => ({ channel: "bbo-tbt", instId: `${asset}-USD` })) }));
        } else {
          ws.send(JSON.stringify({ id: Date.now(), method: "subscribe", nonce: Date.now(), params: { channels: assets.map((asset) => `ticker.${asset}_USD`) } }));
        }
      };
      ws.onmessage = (event) => {
        try {
          if (event.data === "ping") { ws.send("pong"); return; }
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (venue === "Gemini") {
            const symbol = String(message.s || "").replace(/usd$/i, "").toUpperCase() as SymbolName;
            if (!universe.assets.includes(symbol)) return;
            const quote = validQuote(message.b, message.B, message.a, message.A, "stream");
            if (quote) onQuote(symbol, "Gemini", quote);
            return;
          }
          if (venue === "Bitstamp") {
            if (message.event === "bts:request_reconnect") { ws.close(); return; }
            if (message.event !== "data") return;
            const symbol = String(message.channel || "").replace(/^order_book_/, "").replace(/usd$/i, "").toUpperCase() as SymbolName;
            if (!universe.assets.includes(symbol)) return;
            const depth = message.data as { bids?: unknown[][]; asks?: unknown[][] } | undefined;
            const quote = validQuote(depth?.bids?.[0]?.[0], depth?.bids?.[0]?.[1], depth?.asks?.[0]?.[0], depth?.asks?.[0]?.[1], "stream");
            if (quote) onQuote(symbol, "Bitstamp", quote);
            return;
          }
          if (venue === "CEX.IO") {
            if (message.e === "disconnected") { ws.close(); return; }
            if (message.ok !== "ok" || (message.e !== "order_book_subscribe" && message.e !== "order_book_increment")) return;
            const data = message.data as { pair?: string; seqId?: number; bids?: unknown[][]; asks?: unknown[][] } | undefined;
            const symbol = String(data?.pair || "").split("-")[0] as SymbolName;
            if (!universe.assets.includes(symbol) || !supportedPair(symbol, venue)) return;
            if (message.e === "order_book_subscribe") {
              if (!Number.isSafeInteger(data?.seqId)) return;
              cexBooks.set(symbol, { bids: asLevels(data?.bids), asks: asLevels(data?.asks), seqId: data!.seqId! });
              resyncing.delete(symbol);
            } else {
              const book = cexBooks.get(symbol);
              if (!book || data?.seqId !== book.seqId + 1) {
                cexBooks.delete(symbol);
                onStale?.(symbol, venue);
                if (!resyncing.has(symbol)) {
                  resyncing.add(symbol);
                  ws.send(JSON.stringify({ e: "order_book_subscribe", oid: `${symbol}-${Date.now()}`, data: { pair: `${symbol}-USD` } }));
                }
                return;
              }
              book.seqId = data!.seqId!;
              for (const [rows, levels] of [[data?.bids, book.bids], [data?.asks, book.asks]] as [unknown[][] | undefined, Map<number, number>][]) {
                for (const row of rows || []) {
                  if (!Array.isArray(row)) continue;
                  const px = Number(row[0]), size = Number(row[1]);
                  if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(size) || size < 0) continue;
                  if (size === 0) levels.delete(px); else levels.set(px, size);
                }
              }
            }
            const book = cexBooks.get(symbol);
            if (!book) return;
            const bid = bestOf(book.bids, "bid"), ask = bestOf(book.asks, "ask");
            const quote = validQuote(bid?.[0], bid?.[1], ask?.[0], ask?.[1], "stream");
            if (quote) onQuote(symbol, "CEX.IO", quote);
            return;
          }
          if (venue === "OKX US") {
            const arg = message.arg as { channel?: string; instId?: string } | undefined;
            if (arg?.channel !== "bbo-tbt" || !Array.isArray(message.data)) return;
            const symbol = String(arg.instId || "").split("-")[0] as SymbolName;
            if (!universe.assets.includes(symbol)) return;
            const depth = (message.data as { bids?: unknown[][]; asks?: unknown[][] }[])[0];
            const quote = validQuote(depth?.bids?.[0]?.[0], depth?.bids?.[0]?.[1], depth?.asks?.[0]?.[0], depth?.asks?.[0]?.[1], "stream");
            if (quote) onQuote(symbol, "OKX US", quote);
            return;
          }
          if (venue === "Crypto.com") {
            if (message.method === "public/heartbeat") {
              ws.send(JSON.stringify({ id: message.id, method: "public/respond-heartbeat" }));
              return;
            }
            const result = message.result as { channel?: string; instrument_name?: string; data?: Record<string, unknown>[] } | undefined;
            if (result?.channel !== "ticker" || !Array.isArray(result.data)) return;
            for (const tick of result.data) {
              const symbol = String(tick.i || result.instrument_name || "").split("_")[0] as SymbolName;
              if (!universe.assets.includes(symbol)) continue;
              const quote = validQuote(tick.b, tick.bs, tick.k, tick.ks, "stream");
              if (quote) onQuote(symbol, "Crypto.com", quote);
            }
            return;
          }
          if (venue === "Kraken") {
            if (message.channel !== "ticker" || !Array.isArray(message.data)) return;
            for (const ticker of message.data as Record<string, unknown>[]) {
              const symbol = String(ticker.symbol || "").split("/")[0] as SymbolName;
              if (!universe.assets.includes(symbol)) continue;
              const quote = validQuote(ticker.bid, ticker.bid_qty, ticker.ask, ticker.ask_qty, "stream");
              if (quote) onQuote(symbol, "Kraken", quote);
            }
            return;
          }
          const symbol = String(message.product_id || "").split("-")[0] as SymbolName;
          if (!universe.assets.includes(symbol)) return;
          if (message.type === "snapshot") {
            books.set(symbol, { bids: asLevels(message.bids), asks: asLevels(message.asks) });
          } else if (message.type === "l2update") {
            const book = books.get(symbol);
            if (!book || !Array.isArray(message.changes)) return;
            for (const change of message.changes as unknown[][]) {
              if (!Array.isArray(change)) continue;
              const levels = change[0] === "buy" ? book.bids : change[0] === "sell" ? book.asks : null;
              if (!levels) continue;
              const price = Number(change[1]), size = Number(change[2]);
              if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) continue;
              if (size === 0) levels.delete(price); else levels.set(price, size);
            }
          } else return;
          const book = books.get(symbol);
          if (!book) return;
          const bid = bestOf(book.bids, "bid"), ask = bestOf(book.asks, "ask");
          const quote = validQuote(bid?.[0], bid?.[1], ask?.[0], ask?.[1], "stream");
          if (quote) onQuote(symbol, "Coinbase", quote);
        } catch { /* Ignore malformed exchange messages; the REST fallback remains available. */ }
      };
      // Node's WebSocket fires error again from inside close() on a failed connection; close once.
      let closing = false;
      ws.onerror = () => { if (closing) return; closing = true; ws.close(); };
      ws.onclose = () => { if (socket === ws) { socket = null; books.clear(); cexBooks.clear(); for (const asset of assets) onStale?.(asset, venue); if (heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer = undefined; schedule(); } };
    };
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
    return () => page?.removeEventListener("visibilitychange", visibility);
  };

  const cleanups: (() => void)[] = [];
  if (universe.venues.includes("Coinbase")) cleanups.push(connect("Coinbase", "wss://ws-feed.exchange.coinbase.com"));
  if (universe.venues.includes("Kraken")) cleanups.push(connect("Kraken", "wss://ws.kraken.com/v2"));
  if (universe.venues.includes("Gemini")) cleanups.push(connect("Gemini", "wss://ws.gemini.com"));
  if (universe.venues.includes("Bitstamp")) cleanups.push(connect("Bitstamp", "wss://ws.bitstamp.net"));
  if (universe.venues.includes("CEX.IO")) cleanups.push(connect("CEX.IO", "wss://trade.cex.io/api/spot/ws-public"));
  if (universe.venues.includes("OKX US")) cleanups.push(connect("OKX US", "wss://wsus.okx.com:8443/ws/v5/public"));
  if (universe.venues.includes("Crypto.com")) cleanups.push(connect("Crypto.com", "wss://stream.crypto.com/exchange/v1/market"));
  return () => {
    stopped = true;
    cleanups.forEach((cleanup) => cleanup());
    timers.forEach((timer) => clearTimeout(timer));
    sockets.forEach((socket) => socket.close());
  };
}
