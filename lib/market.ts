export type Venue = "Coinbase" | "Kraken" | "Gemini" | "Bitstamp" | "CEX.IO" | "Crypto.com" | "bitFlyer" | "OKX US";
export type SymbolName = "BTC" | "ETH" | "SOL" | "XRP" | "DOGE" | "LTC" | "ADA" | "AVAX" | "LINK" | "XLM" | "BCH" | "UNI" | "AAVE" | "DOT" | "SHIB" | "SUI" | "HBAR" | "PEPE" | "NEAR" | "ETC" | "ATOM" | "TRX" | "OP" | "ARB" | "ALGO" | "APT" | "FIL" | "GRT" | "ICP" | "POL" | "ENS" | "BONK" | "BAT" | "CRV" | "FET" | "JUP" | "LDO" | "MANA" | "SEI" | "XTZ";
export type Quote = { bid: number; bidSize: number; ask: number; askSize: number; receivedAt: number; source: "stream" | "poll" };
export type Snapshot = {
  generatedAt: number;
  markets: Record<SymbolName, Partial<Record<Venue, Quote>>>;
  errors: string[];
  failedPairs?: string[];
};
export type Universe = { assets: SymbolName[]; venues: Venue[] };
export type PublicFee = { rate: number; checkedAt: number; url: string };
export type PublicFeesResponse = { checkedAt: number; rates: Partial<Record<Venue, PublicFee>>; errors: string[] };
export type Settings = {
  budget: number; minNet: number; coinbaseFee: number; krakenFee: number;
  geminiFee: number; bitstampFee: number; cexFee: number; cryptoComFee: number; bitflyerFee: number; okxFee: number; buffer: number; maxGap: number;
};
export type Route = {
  key: string; symbol: SymbolName; buy: Venue; sell: Venue; ask: number; bid: number;
  quantity: number; notional: number; grossPct: number; net: number; netPct: number;
  buyFee: number; sellFee: number; movementCost: number;
  ageMs: number; streamLegs: number; indicative: boolean; suspect: boolean;
};
export type Trade = Route & { id: string; time: number };
export type Session = { balance: number; scans: number; tradeCount: number; trades: Trade[] };

export const symbols: SymbolName[] = ["BTC", "ETH", "SOL", "XRP", "DOGE", "LTC", "ADA", "AVAX", "LINK", "XLM", "BCH", "UNI", "AAVE", "DOT", "SHIB", "SUI", "HBAR", "PEPE", "NEAR", "ETC", "ATOM", "TRX", "OP", "ARB", "ALGO", "APT", "FIL", "GRT", "ICP", "POL", "ENS", "BONK", "BAT", "CRV", "FET", "JUP", "LDO", "MANA", "SEI", "XTZ"];
export const venues: Venue[] = ["Coinbase", "Kraken", "Gemini", "Bitstamp", "CEX.IO", "bitFlyer", "OKX US", "Crypto.com"];
export const defaultUniverse: Universe = { assets: symbols.slice(0, 16), venues: venues.filter((venue) => venue !== "Crypto.com") };
// These US USD spot books are limited; don't request or count nonexistent pairs.
const geminiUsd = new Set<SymbolName>(["BTC", "ETH", "SOL", "XRP", "DOGE", "LTC", "AVAX", "LINK", "BCH", "UNI", "AAVE", "DOT", "SHIB", "SUI", "PEPE", "ATOM", "TRX", "OP", "ARB", "FIL", "GRT", "POL", "ENS", "BONK", "BAT", "CRV", "FET", "JUP", "MANA", "XTZ"]);
const cexUsd = new Set<SymbolName>(symbols.filter((symbol) => symbol !== "HBAR" && symbol !== "ETC"));
const coinbaseUsd = new Set<SymbolName>(symbols.filter((symbol) => symbol !== "TRX" && symbol !== "JUP"));
const bitstampUsd = new Set<SymbolName>(symbols.filter((symbol) => symbol !== "FIL" && symbol !== "ENS"));
const cryptoComUsd = new Set<SymbolName>(symbols.filter((symbol) => symbol !== "TRX"));
export const supportedPair = (symbol: SymbolName, venue: Venue) =>
  venue === "bitFlyer" ? symbol === "BTC" || symbol === "ETH" :
  venue === "OKX US" ? symbol === "BTC" || symbol === "ETH" || symbol === "SOL" :
  venue === "Gemini" ? geminiUsd.has(symbol) :
  venue === "CEX.IO" ? cexUsd.has(symbol) :
  venue === "Coinbase" ? coinbaseUsd.has(symbol) :
  venue === "Bitstamp" ? bitstampUsd.has(symbol) :
  venue === "Crypto.com" ? cryptoComUsd.has(symbol) : true;
export const feeKey: Record<Venue, keyof Settings> = {
  Coinbase: "coinbaseFee", Kraken: "krakenFee", Gemini: "geminiFee", Bitstamp: "bitstampFee", "CEX.IO": "cexFee", "Crypto.com": "cryptoComFee", bitFlyer: "bitflyerFee", "OKX US": "okxFee",
};
// Editable assumptions, not promises of an account's actual fee tier. Entry-tier spot taker
// rates as of September 2026: Coinbase Advanced (US) 0.90%, Gemini ActiveTrader 1.20%.
export const defaults: Settings = {
  budget: 50, minNet: 0.25, coinbaseFee: 0.9, krakenFee: 0.8,
  geminiFee: 1.2, bitstampFee: 0.5, cexFee: 0.25, cryptoComFee: 0.5, bitflyerFee: 0.1, okxFee: 0.5, buffer: 0.1,
  // Gaps wider than this almost always mean the two books are not interchangeable (transfers
  // paused, a different token, a halted market), so they are flagged and never paper-traded.
  maxGap: 2,
};
export const settingRange = (key: keyof Settings): [number, number] =>
  key === "budget" ? [5, 100000] : key === "minNet" ? [0, 10000] : key === "maxGap" ? [0.1, 50] : [0, 10];
export const newSession: Session = { balance: 500, scans: 0, tradeCount: 0, trades: [] };
export const money = (n: number, digits = 2) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
export const signedMoney = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;
export const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
export const price = (n: number) => money(n, n < 0.001 ? 10 : n < 1 ? 6 : n < 10 ? 4 : 2);
export const emptyMarkets = (): Snapshot["markets"] => Object.fromEntries(symbols.map((symbol) => [symbol, {}])) as Snapshot["markets"];

export function validQuote(bid: unknown, bidSize: unknown, ask: unknown, askSize: unknown, source: Quote["source"]): Quote | null {
  const values = [bid, bidSize, ask, askSize].map(Number);
  if (values.some((n) => !Number.isFinite(n) || n <= 0) || values[0] >= values[2]) return null;
  return { bid: values[0], bidSize: values[1], ask: values[2], askSize: values[3], receivedAt: Date.now(), source };
}

export function routesFor(snapshot: Snapshot | null, settings: Settings, balance: number, universe: Universe = defaultUniverse, now = Date.now()): Route[] {
  if (!snapshot) return [];
  const result: Route[] = [];
  const fee: Record<Venue, number> = {
    Coinbase: settings.coinbaseFee, Kraken: settings.krakenFee,
    Gemini: settings.geminiFee, Bitstamp: settings.bitstampFee, "CEX.IO": settings.cexFee, "Crypto.com": settings.cryptoComFee,
    bitFlyer: settings.bitflyerFee, "OKX US": settings.okxFee,
  };
  for (const symbol of universe.assets) {
    const book = snapshot.markets[symbol];
    for (const buy of universe.venues) for (const sell of universe.venues) {
      if (buy === sell || !supportedPair(symbol, buy) || !supportedPair(symbol, sell)) continue;
      const entry = book?.[buy], exit = book?.[sell];
      if (!entry || !exit || Math.abs(entry.receivedAt - exit.receivedAt) > 4000) continue;
      if (now - entry.receivedAt > 12000 || now - exit.receivedAt > 12000) continue;
      const slip = settings.buffer / 100;
      const costPerUnit = entry.ask * (1 + fee[buy] / 100 + slip);
      const quantity = Math.min(Math.max(0, Math.min(settings.budget, balance)) / costPerUnit, entry.askSize, exit.bidSize);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity * entry.ask < 5) continue;
      const notional = quantity * costPerUnit;
      const buyFee = quantity * entry.ask * fee[buy] / 100;
      const sellFee = quantity * exit.bid * fee[sell] / 100;
      const movementCost = quantity * (entry.ask + exit.bid) * slip;
      const net = quantity * (exit.bid - entry.ask) - buyFee - sellFee - movementCost;
      result.push({
        key: `${symbol}-${buy}-${sell}`, symbol, buy, sell,
        ask: entry.ask, bid: exit.bid, quantity, notional,
        grossPct: (exit.bid / entry.ask - 1) * 100,
        net, netPct: net / notional * 100, buyFee, sellFee, movementCost,
        ageMs: Math.max(now - entry.receivedAt, now - exit.receivedAt),
        streamLegs: Number(entry.source === "stream") + Number(exit.source === "stream"),
        indicative: buy === "Crypto.com" || sell === "Crypto.com",
        suspect: (exit.bid / entry.ask - 1) * 100 > settings.maxGap,
      });
    }
  }
  return result.sort((a, b) => Number(a.indicative) - Number(b.indicative) || Number(a.suspect) - Number(b.suspect) || b.net - a.net);
}
