import type { Venue } from "./market";

// Public first-tier spot taker schedules. Account tiers, negotiated pricing and
// pair-specific promotions require authenticated account data and are not inferred here.
// Coinbase is not read: its retail (Advanced) schedule blocks automated requests, and the
// institutional Exchange schedule understates what retail accounts pay.
export const publicFeeSources: Partial<Record<Venue, string>> = {
  Kraken: "https://www.kraken.com/features/fee-schedule",
  Gemini: "https://www.gemini.com/fees/activetrader-fee-schedule",
  "CEX.IO": "https://cex.io/en-US/buy-tether-usdt",
  bitFlyer: "https://bitflyer.com/en-us/commission",
};

// Where to check each estimate by hand, including venues whose schedules are not read.
export const feeScheduleLinks: Partial<Record<Venue, string>> = {
  ...publicFeeSources,
  Coinbase: "https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees",
  Bitstamp: "https://www.bitstamp.net/fee-schedule/",
  "OKX US": "https://www.okx.com/en-us/fees",
  "Crypto.com": "https://crypto.com/exchange/document/fees-limits",
  "Binance.US": "https://www.binance.us/fees",
};

export function parsePublishedTaker(venue: Venue, html: string): number | null {
  const page = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&ge;/gi, "≥")
    .replace(/\s+/g, " ");
  let matched: RegExpMatchArray | null = null;
  if (venue === "Kraken") matched = page.match(/Tier 1\s*\|?\s*\$0\+.{0,120}?(\d+(?:\.\d+)?)\s*%\s*\|?\s*(\d+(?:\.\d+)?)\s*%/i);
  // Spot rows read maker, taker, 30-day volume, asset balance; the entry row is "≥ $0 ≥ $0".
  if (venue === "Gemini") matched = page.match(/(\d+(?:\.\d+)?)\s*%\s+(\d+(?:\.\d+)?)\s*%\s+≥\s*\$0\s+≥\s*\$0/);
  if (venue === "CEX.IO") matched = page.match(/Standard maker fees start at.{0,100}?taker fees start at\s*(\d+(?:\.\d+)?)\s*%/i);
  if (venue === "bitFlyer") matched = page.match(/BTC\/USD Trading Fees.{0,200}?\$0\s*-\s*Less than \$50,000\s+(\d+(?:\.\d+)?)\s*%/i);
  if (!matched) return null;
  const rate = Number(venue === "Kraken" || venue === "Gemini" ? matched[2] : matched[1]);
  return Number.isFinite(rate) && rate >= 0 && rate <= 2 ? rate : null;
}
