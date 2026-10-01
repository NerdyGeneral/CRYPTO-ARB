import { exchangeTime, quoteSequence, validQuote, type Quote, type QuoteProvenance, type SymbolName, type Venue } from "./market";
import { keyOf, usdMarket, type Market } from "./markets";

// Public REST order books. Shared by the market API route and the background engine.
const headers = { Accept: "application/json", "User-Agent": "arbiter-live/0.1" }; // Coinbase intermittently rejects requests without a User-Agent (HTTP 400).
type Levels = { bids?: unknown[][]; asks?: unknown[][]; ts?: string; seqId?: number; t?: number };
const top = (depth: Levels | undefined, provenance: QuoteProvenance) => validQuote(depth?.bids?.[0]?.[0], depth?.bids?.[0]?.[1], depth?.asks?.[0]?.[0], depth?.asks?.[0]?.[1], "poll", provenance);

export async function fetchMarketBook(market: Market): Promise<Quote> {
  const { venue, rest } = market;
  const url =
    venue === "Coinbase" ? `https://api.exchange.coinbase.com/products/${rest}/book?level=1` :
    venue === "Kraken" ? `https://api.kraken.com/0/public/Depth?pair=${rest}&count=1` :
    venue === "Gemini" ? `https://api.gemini.com/v1/book/${rest}?limit_bids=1&limit_asks=1` :
    venue === "Bitstamp" ? `https://www.bitstamp.net/api/v2/order_book/${rest}/` :
    venue === "CEX.IO" ? "https://trade.cex.io/api/spot/rest-public/get_order_book" :
    venue === "bitFlyer" ? `https://api.bitflyer.com/v1/getboard?product_code=${rest}` :
    venue === "OKX US" ? `https://us.okx.com/api/v5/market/books?instId=${rest}&sz=1` :
    venue === "Binance.US" ? `https://api.binance.us/api/v3/ticker/bookTicker?symbol=${rest}` :
    `https://api.crypto.com/exchange/v1/public/get-book?instrument_name=${rest}&depth=1`;
  const requestStartedAt = Date.now();
  const response = await fetch(url, {
    method: venue === "CEX.IO" ? "POST" : "GET",
    headers: venue === "CEX.IO" ? { ...headers, "Content-Type": "application/json" } : headers,
    ...(venue === "CEX.IO" ? { body: JSON.stringify({ pair: rest }) } : {}),
    cache: "no-store", signal: AbortSignal.timeout(3500),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  let book: Quote | null;
  if (venue === "Coinbase") {
    if (body.auction_mode === true) throw new Error("auction mode");
    book = top(body as Levels, { requestStartedAt, sequence: quoteSequence(body.sequence) });
  } else if (venue === "Kraken") {
    if (Array.isArray(body.error) && body.error.length) throw new Error(String(body.error[0]));
    const result = body.result as Record<string, Levels>;
    // Kraken's per-level timestamps describe orders, not the age of this REST snapshot.
    book = top(result && Object.values(result)[0], { requestStartedAt });
  } else if (venue === "Gemini" || venue === "bitFlyer") {
    const size = venue === "Gemini" ? "amount" : "size";
    const bids = body.bids as Record<string, unknown>[], asks = body.asks as Record<string, unknown>[];
    book = validQuote(bids?.[0]?.price, bids?.[0]?.[size], asks?.[0]?.price, asks?.[0]?.[size], "poll", { requestStartedAt });
  } else if (venue === "Bitstamp") {
    book = top(body as Levels, { requestStartedAt, exchangeAt: body.microtimestamp !== undefined ? exchangeTime(body.microtimestamp, "microseconds") : exchangeTime(body.timestamp, "seconds") });
  } else if (venue === "CEX.IO") {
    if (body.ok !== "ok") throw new Error("instrument unavailable");
    book = top(body.data as Levels, { requestStartedAt, sequence: quoteSequence((body.data as { seqId?: number })?.seqId) });
  } else if (venue === "OKX US") {
    if (body.code !== "0") throw new Error("instrument unavailable");
    const depth = (body.data as Levels[])?.[0];
    book = top(depth, { requestStartedAt, exchangeAt: exchangeTime(depth?.ts, "milliseconds"), sequence: quoteSequence(depth?.seqId) });
  } else if (venue === "Binance.US") {
    book = validQuote(body.bidPrice, body.bidQty, body.askPrice, body.askQty, "poll", { requestStartedAt });
  } else {
    if (body.code !== 0) throw new Error("instrument unavailable");
    const depth = (body.result as { data?: Levels[] })?.data?.[0];
    book = top(depth, { requestStartedAt, exchangeAt: exchangeTime(depth?.t, "milliseconds") });
  }
  if (!book) throw new Error("invalid book");
  return book;
}

export async function fetchBook(symbol: SymbolName, venue: Venue): Promise<{ symbol: SymbolName; venue: Venue; book?: Quote; error?: string }> {
  try { return { symbol, venue, book: await fetchMarketBook(usdMarket(symbol, venue)) }; }
  catch { return { symbol, venue, error: `${venue} ${symbol} quote unavailable` }; }
}

// Venues with an endpoint that returns the best bid and ask, with sizes, for many markets at once.
export const batchVenues: Venue[] = ["Kraken", "Binance.US", "OKX US"];

export async function fetchBatchBooks(venue: Venue, markets: Market[]): Promise<Map<string, Quote>> {
  const quotes = new Map<string, Quote>();
  const get = async <T>(url: string): Promise<{ body: T; requestStartedAt: number }> => {
    const requestStartedAt = Date.now();
    const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { body: await response.json() as T, requestStartedAt };
  };
  if (venue === "Kraken") {
    // Ticker returns the best bid and ask with the volume at that price: [price, whole-lot volume, volume].
    for (let i = 0; i < markets.length; i += 50) {
      const chunk = markets.slice(i, i + 50);
      const { body, requestStartedAt } = await get<{ error?: string[]; result?: Record<string, { a: string[]; b: string[] }> }>(`https://api.kraken.com/0/public/Ticker?pair=${chunk.map((m) => m.rest).join(",")}`);
      if (body.error?.length) throw new Error(body.error[0]);
      for (const market of chunk) {
        const ticker = body.result?.[market.batch || market.rest];
        const quote = ticker && validQuote(ticker.b[0], ticker.b[2], ticker.a[0], ticker.a[2], "poll", { requestStartedAt });
        if (quote) quotes.set(keyOf(market), quote);
      }
    }
  } else if (venue === "Binance.US") {
    const { body: rows, requestStartedAt } = await get<{ symbol: string; bidPrice: string; bidQty: string; askPrice: string; askQty: string }[]>("https://api.binance.us/api/v3/ticker/bookTicker");
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    for (const market of markets) {
      const row = bySymbol.get(market.rest);
      const quote = row && validQuote(row.bidPrice, row.bidQty, row.askPrice, row.askQty, "poll", { requestStartedAt });
      if (quote) quotes.set(keyOf(market), quote);
    }
  } else if (venue === "OKX US") {
    const { body, requestStartedAt } = await get<{ code?: string; data?: { instId: string; bidPx: string; bidSz: string; askPx: string; askSz: string; ts?: string }[] }>("https://us.okx.com/api/v5/market/tickers?instType=SPOT");
    if (body.code !== "0") throw new Error("instruments unavailable");
    const byId = new Map((body.data || []).map((row) => [row.instId, row]));
    for (const market of markets) {
      const row = byId.get(market.rest);
      const quote = row && validQuote(row.bidPx, row.bidSz, row.askPx, row.askSz, "poll", { requestStartedAt, exchangeAt: exchangeTime(row.ts, "milliseconds") });
      if (quote) quotes.set(keyOf(market), quote);
    }
  } else throw new Error(`${venue} has no batch endpoint`);
  return quotes;
}
