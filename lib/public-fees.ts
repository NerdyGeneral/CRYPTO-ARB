import type { Venue } from "./market";

// Public first-tier spot taker schedules. Account tiers, negotiated pricing and
// pair-specific promotions require authenticated account data and are not inferred here.
export const publicFeeSources: Partial<Record<Venue, string>> = {
  Coinbase: "https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees",
  Kraken: "https://www.kraken.com/features/fee-schedule",
  Gemini: "https://www.gemini.com/cryptopedia/what-fees-do-crypto-exchanges-charge",
  "CEX.IO": "https://cex.io/en-US/buy-tether-usdt",
  bitFlyer: "https://bitflyer.com/en-us/commission",
};

export function parsePublishedTaker(venue: Venue, html: string): number | null {
  const page = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ");
  let matched: RegExpMatchArray | null = null;
  if (venue === "Coinbase") matched = page.match(/\$0K\s*-\s*\$10K\s+(\d+(?:\.\d+)?)\s*bps/i);
  if (venue === "Kraken") matched = page.match(/Tier 1\s*\|?\s*\$0\+.{0,120}?(\d+(?:\.\d+)?)\s*%\s*\|?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (venue === "Gemini") matched = page.match(/fees start at.{0,100}?(\d+(?:\.\d+)?)\s*%\s*taker\s*at\s*\$0/i);
  if (venue === "CEX.IO") matched = page.match(/Standard maker fees start at.{0,100}?taker fees start at\s*(\d+(?:\.\d+)?)\s*%/i);
  if (venue === "bitFlyer") matched = page.match(/BTC\/USD Trading Fees.{0,200}?\$0\s*-\s*Less than \$50,000\s+(\d+(?:\.\d+)?)\s*%/i);
  if (!matched) return null;
  const number = Number(venue === "Kraken" ? matched[2] : matched[1]);
  const rate = venue === "Coinbase" ? number / 100 : number;
  return Number.isFinite(rate) && rate >= 0 && rate <= 2 ? rate : null;
}
