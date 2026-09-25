import type { Venue } from "./market";

// One order book: a base asset priced in a quote currency on one exchange, with the names that
// exchange uses for it over REST and over its websocket feed.
export type Market = {
  venue: Venue;
  base: string;
  quote: string;
  rest: string;
  ws: string;
  // Key used by a venue's all-markets endpoint when it differs from `rest` (Kraken's canonical pair name).
  batch?: string;
};

export const marketKey = (venue: Venue, base: string, quote: string) => `${venue}|${base}/${quote}`;
export const keyOf = (market: Market) => marketKey(market.venue, market.base, market.quote);

// Dollar stablecoins that can stand in for USD once converted at their live rate.
export const dollarStablecoins = ["USDT", "USDC"] as const;
export const isDollarStable = (asset: string) => (dollarStablecoins as readonly string[]).includes(asset);

// Exchange-native names for a pair. Kraken's REST names come from its listing when discovered;
// the default only needs to cover the USD pairs the web page uses.
export function makeMarket(venue: Venue, base: string, quote: string, names: Partial<Pick<Market, "rest" | "ws" | "batch">> = {}): Market {
  const joined = `${base}${quote}`;
  const [rest, ws] =
    venue === "Coinbase" || venue === "CEX.IO" || venue === "OKX US" ? [`${base}-${quote}`, `${base}-${quote}`] :
    venue === "Kraken" ? [`${base === "BTC" ? "XBT" : base}${quote === "BTC" ? "XBT" : quote}`, `${base}/${quote}`] :
    venue === "Gemini" || venue === "Bitstamp" ? [joined.toLowerCase(), joined.toLowerCase()] :
    venue === "Binance.US" ? [joined, joined.toLowerCase()] :
    [`${base}_${quote}`, `${base}_${quote}`]; // bitFlyer, Crypto.com
  return { venue, base, quote, rest, ws, ...names };
}

export const usdMarket = (symbol: string, venue: Venue) => makeMarket(venue, symbol, "USD");
