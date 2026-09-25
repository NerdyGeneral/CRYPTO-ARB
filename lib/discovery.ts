import type { Venue } from "./market";
import { isDollarStable, keyOf, makeMarket, type Market } from "./markets";

// Finds what each exchange lists from its public endpoints, so the engine is not limited to a
// hand-maintained coin list, and ranks coins by combined 24h dollar volume.

export const dollarQuotes = ["USD", "USDT", "USDC"];
export const crossQuotes = ["BTC", "ETH"];
const wanted = new Set([...dollarQuotes, ...crossQuotes]);

// Stablecoins, fiat and pegged tokens are never ranked as coins to trade.
const notCoins = new Set(["USD", "USDT", "USDC", "DAI", "PYUSD", "GUSD", "USDP", "TUSD", "BUSD", "FDUSD", "RLUSD", "USDS", "USDG", "USD1",
  "USDE", "EURC", "EURCV", "EUROP", "EUR", "GBP", "AUD", "CAD", "CHF", "JPY", "SGD", "BRL", "TRY", "AED", "INR", "USDQ", "USDR", "USDD", "AUSD"]);

export type Listing = { markets: Market[]; volumeUsd: Record<string, number>; fetchedAt: number; errors: string[] };

const headers = { Accept: "application/json", "User-Agent": "arbiter-live/0.1" };
async function get<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000), ...init });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
const krakenAsset = (name: string) => ({ XBT: "BTC", XDG: "DOGE" })[name] || name;

async function listVenue(venue: Venue): Promise<Market[]> {
  const pair = (base: string, quote: string, names?: Partial<Pick<Market, "rest" | "ws" | "batch">>) =>
    wanted.has(quote) && base !== quote ? [makeMarket(venue, base, quote, names)] : [];
  switch (venue) {
    case "Coinbase": {
      const rows = await get<{ id: string; base_currency: string; quote_currency: string; status: string; trading_disabled: boolean; cancel_only: boolean; auction_mode: boolean }[]>("https://api.exchange.coinbase.com/products");
      return rows.filter((r) => r.status === "online" && !r.trading_disabled && !r.cancel_only && !r.auction_mode)
        .flatMap((r) => pair(r.base_currency, r.quote_currency, { rest: r.id, ws: r.id }));
    }
    case "Kraken": {
      const body = await get<{ result: Record<string, { altname: string; wsname?: string; status: string }> }>("https://api.kraken.com/0/public/AssetPairs");
      return Object.entries(body.result).filter(([, r]) => r.status === "online" && r.wsname?.includes("/")).flatMap(([id, r]) => {
        const [base, quote] = r.wsname!.split("/").map(krakenAsset);
        return pair(base, quote, { rest: r.altname, ws: `${base}/${quote}`, batch: id });
      });
    }
    case "Gemini": {
      const symbols = await get<string[]>("https://api.gemini.com/v1/symbols");
      return symbols.filter((s) => !/perp$/.test(s)).flatMap((s) => {
        if (/(gusd|rlusd)$/.test(s)) return [];
        const quote = ["usdc", "usdt", "usd", "btc", "eth"].find((q) => s.endsWith(q) && s.length > q.length);
        return quote ? pair(s.slice(0, -quote.length).toUpperCase(), quote.toUpperCase(), { rest: s, ws: s }) : [];
      });
    }
    case "Bitstamp": {
      const rows = await get<{ name: string; url_symbol: string; trading: string }[]>("https://www.bitstamp.net/api/v2/trading-pairs-info/");
      return rows.filter((r) => r.trading === "Enabled").flatMap((r) => {
        const [base, quote] = r.name.split("/");
        return pair(base, quote, { rest: r.url_symbol, ws: r.url_symbol });
      });
    }
    case "CEX.IO": {
      const body = await get<{ ok: string; data: { base: string; quote: string }[] }>("https://trade.cex.io/api/spot/rest-public/get_pairs_info",
        { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
      return body.data.flatMap((r) => pair(r.base, r.quote));
    }
    case "Binance.US": {
      const body = await get<{ symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string }[] }>("https://api.binance.us/api/v3/exchangeInfo");
      return body.symbols.filter((r) => r.status === "TRADING").flatMap((r) => pair(r.baseAsset, r.quoteAsset, { rest: r.symbol, ws: r.symbol.toLowerCase() }));
    }
    case "Crypto.com": {
      const body = await get<{ result: { data: { symbol: string; base_ccy: string; quote_ccy: string; inst_type: string; tradable: boolean }[] } }>("https://api.crypto.com/exchange/v1/public/get-instruments");
      return body.result.data.filter((r) => r.inst_type === "CCY_PAIR" && r.tradable).flatMap((r) => pair(r.base_ccy, r.quote_ccy, { rest: r.symbol, ws: r.symbol }));
    }
    // bitFlyer USA lists two USD books. OKX's public API mixes in markets US accounts cannot trade,
    // so only the USD books the app has always used are kept.
    case "bitFlyer": return ["BTC", "ETH"].flatMap((base) => pair(base, "USD"));
    case "OKX US": return ["BTC", "ETH", "SOL"].flatMap((base) => pair(base, "USD"));
  }
}

// 24h dollar volume per coin from the venues that publish it in one request.
async function volumes(): Promise<Record<string, number>> {
  const total: Record<string, number> = {};
  const add = (base: string, quote: string, usd: number) => {
    if (dollarQuotes.includes(quote) && Number.isFinite(usd) && usd > 0) total[base] = (total[base] || 0) + usd;
  };
  const sources: Promise<void>[] = [
    get<Record<string, { stats_24hour?: { volume: string; last: string } }>>("https://api.exchange.coinbase.com/products/stats").then((rows) => {
      for (const [id, row] of Object.entries(rows)) { const [b, q] = id.split("-"); add(b, q, Number(row.stats_24hour?.volume) * Number(row.stats_24hour?.last)); }
    }),
    get<{ result: Record<string, { v: string[]; c: string[] }> }>("https://api.kraken.com/0/public/Ticker").then(async (body) => {
      const pairs = (await get<{ result: Record<string, { wsname?: string }> }>("https://api.kraken.com/0/public/AssetPairs")).result;
      for (const [id, row] of Object.entries(body.result)) {
        const [b, q] = (pairs[id]?.wsname || "").split("/").map(krakenAsset);
        if (b && q) add(b, q, Number(row.v[1]) * Number(row.c[0]));
      }
    }),
    get<{ symbol: string; quoteVolume: string }[]>("https://api.binance.us/api/v3/ticker/24hr").then(async (rows) => {
      const info = await get<{ symbols: { symbol: string; baseAsset: string; quoteAsset: string }[] }>("https://api.binance.us/api/v3/exchangeInfo");
      const bySymbol = new Map(info.symbols.map((s) => [s.symbol, s]));
      for (const row of rows) { const s = bySymbol.get(row.symbol); if (s) add(s.baseAsset, s.quoteAsset, Number(row.quoteVolume)); }
    }),
    get<{ pair?: string; volume: string; last: string }[]>("https://www.bitstamp.net/api/v2/ticker/").then((rows) => {
      for (const row of rows) { const [b, q] = (row.pair || "").split("/"); if (b && q) add(b, q, Number(row.volume) * Number(row.last)); }
    }),
    get<{ result: { data: { i: string; vv: string }[] } }>("https://api.crypto.com/exchange/v1/public/get-tickers").then((body) => {
      for (const row of body.result.data) { const [b, q] = row.i.split("_"); if (b && q) add(b, q, Number(row.vv)); }
    }),
  ];
  await Promise.allSettled(sources);
  return total;
}

export async function discover(venues: Venue[]): Promise<Listing> {
  const errors: string[] = [];
  const [listed, volumeUsd] = await Promise.all([
    Promise.all(venues.map((venue) => listVenue(venue).catch((error: Error) => { errors.push(`${venue} listings unavailable (${error.message})`); return [] as Market[]; }))),
    volumes(),
  ]);
  return { markets: listed.flat(), volumeUsd, fetchedAt: Date.now(), errors };
}

export type Selection = { coins: string[]; markets: Market[] };

// Coins listed against a dollar quote on at least two tradable venues, ranked by volume. BTC, ETH and the
// dollar stablecoins' own USD books are always included because every conversion and triangle needs them.
export function selectMarkets(listing: Listing, options: {
  tradableVenues: Venue[]; topCoins: number; include?: string[]; exclude?: string[]; triangular: boolean;
}): Selection {
  const exclude = new Set(options.exclude || []);
  const venuesByCoin = new Map<string, Set<Venue>>();
  for (const m of listing.markets) {
    if (!dollarQuotes.includes(m.quote) || notCoins.has(m.base) || !options.tradableVenues.includes(m.venue)) continue;
    venuesByCoin.set(m.base, (venuesByCoin.get(m.base) || new Set()).add(m.venue));
  }
  const ranked = [...venuesByCoin].filter(([coin, set]) => set.size >= 2 && !exclude.has(coin))
    .sort(([a], [b]) => (listing.volumeUsd[b] || 0) - (listing.volumeUsd[a] || 0)).map(([coin]) => coin);
  const coins = [...new Set(["BTC", "ETH", ...ranked.slice(0, options.topCoins), ...(options.include || [])])].filter((coin) => !exclude.has(coin));
  const coinSet = new Set(coins);
  const seen = new Set<string>();
  const markets = listing.markets.filter((m) => {
    const keep =
      (coinSet.has(m.base) && dollarQuotes.includes(m.quote)) ||
      (options.triangular && coinSet.has(m.base) && crossQuotes.includes(m.quote) && (coinSet.has(m.quote))) ||
      (isDollarStable(m.base) && dollarQuotes.includes(m.quote));
    const key = keyOf(m);
    if (!keep || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Most-traded first, so venues that subscribe slowly (CEX.IO) bring the important books up first.
  const rank = (m: Market) => isDollarStable(m.base) ? -1 : coins.indexOf(m.base);
  markets.sort((a, b) => rank(a) - rank(b));
  return { coins, markets };
}
