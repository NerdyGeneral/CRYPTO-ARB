import { validQuote, type Quote, type SymbolName, type Venue } from "./market";

// Shared by the market API route and the background engine.
const pairFor = (symbol: SymbolName, venue: Venue) => {
  if (venue === "Coinbase") return `${symbol}-USD`;
  if (venue === "Kraken") return `${symbol === "BTC" ? "XBT" : symbol}USD`;
  if (venue === "Crypto.com") return `${symbol}_USD`;
  return `${symbol.toLowerCase()}usd`;
};

export async function fetchBook(symbol: SymbolName, venue: Venue): Promise<{ symbol: SymbolName; venue: Venue; book?: Quote; error?: string }> {
  const pair = pairFor(symbol, venue);
  try {
    const url = venue === "Coinbase"
      ? `https://api.exchange.coinbase.com/products/${pair}/book?level=1`
      : venue === "Kraken"
        ? `https://api.kraken.com/0/public/Depth?pair=${pair}&count=1`
        : venue === "Gemini"
          ? `https://api.gemini.com/v1/book/${pair}?limit_bids=1&limit_asks=1`
          : venue === "Bitstamp"
            ? `https://www.bitstamp.net/api/v2/order_book/${pair}/`
            : venue === "CEX.IO"
              ? "https://trade.cex.io/api/spot/rest-public/get_order_book"
            : venue === "bitFlyer"
              ? `https://api.bitflyer.com/v1/getboard?product_code=${symbol}_USD`
              : venue === "OKX US"
                ? `https://us.okx.com/api/v5/market/books?instId=${symbol}-USD&sz=1`
                : `https://api.crypto.com/exchange/v1/public/get-book?instrument_name=${pair}&depth=1`;
    const response = await fetch(url, {
      method: venue === "CEX.IO" ? "POST" : "GET",
      // Coinbase intermittently rejects requests without a User-Agent (HTTP 400).
      headers: { Accept: "application/json", "User-Agent": "arbiter-live/0.1", ...(venue === "CEX.IO" ? { "Content-Type": "application/json" } : {}) },
      ...(venue === "CEX.IO" ? { body: JSON.stringify({ pair: `${symbol}-USD` }) } : {}),
      cache: "no-store", signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    let book: Quote | null;
    if (venue === "Coinbase") {
      if (body.auction_mode === true) throw new Error("auction mode");
      const bids = body.bids as unknown[][];
      const asks = body.asks as unknown[][];
      book = validQuote(bids?.[0]?.[0], bids?.[0]?.[1], asks?.[0]?.[0], asks?.[0]?.[1], "poll");
    } else if (venue === "Kraken") {
      if (Array.isArray(body.error) && body.error.length) throw new Error(String(body.error[0]));
      const result = body.result as Record<string, { bids: unknown[][]; asks: unknown[][] }>;
      const depth = result && Object.values(result)[0];
      book = validQuote(depth?.bids?.[0]?.[0], depth?.bids?.[0]?.[1], depth?.asks?.[0]?.[0], depth?.asks?.[0]?.[1], "poll");
    } else if (venue === "Gemini") {
      const bids = body.bids as { price: unknown; amount: unknown }[];
      const asks = body.asks as { price: unknown; amount: unknown }[];
      book = validQuote(bids?.[0]?.price, bids?.[0]?.amount, asks?.[0]?.price, asks?.[0]?.amount, "poll");
    } else if (venue === "Bitstamp") {
      const bids = body.bids as unknown[][];
      const asks = body.asks as unknown[][];
      book = validQuote(bids?.[0]?.[0], bids?.[0]?.[1], asks?.[0]?.[0], asks?.[0]?.[1], "poll");
    } else if (venue === "CEX.IO") {
      if (body.ok !== "ok") throw new Error("instrument unavailable");
      const depth = body.data as { bids?: unknown[][]; asks?: unknown[][] } | undefined;
      book = validQuote(depth?.bids?.[0]?.[0], depth?.bids?.[0]?.[1], depth?.asks?.[0]?.[0], depth?.asks?.[0]?.[1], "poll");
    } else if (venue === "bitFlyer") {
      const bids = body.bids as { price: unknown; size: unknown }[];
      const asks = body.asks as { price: unknown; size: unknown }[];
      book = validQuote(bids?.[0]?.price, bids?.[0]?.size, asks?.[0]?.price, asks?.[0]?.size, "poll");
    } else if (venue === "OKX US") {
      if (body.code !== "0") throw new Error("instrument unavailable");
      const depth = (body.data as { bids: unknown[][]; asks: unknown[][] }[])?.[0];
      book = validQuote(depth?.bids?.[0]?.[0], depth?.bids?.[0]?.[1], depth?.asks?.[0]?.[0], depth?.asks?.[0]?.[1], "poll");
    } else {
      if (body.code !== 0) throw new Error("instrument unavailable");
      const result = body.result as { data?: { bids: unknown[][]; asks: unknown[][] }[] };
      const depth = result?.data?.[0];
      book = validQuote(depth?.bids?.[0]?.[0], depth?.bids?.[0]?.[1], depth?.asks?.[0]?.[0], depth?.asks?.[0]?.[1], "poll");
    }
    if (!book) throw new Error("invalid book");
    return { symbol, venue, book };
  } catch {
    return { symbol, venue, error: `${venue} ${symbol} quote unavailable` };
  }
}
