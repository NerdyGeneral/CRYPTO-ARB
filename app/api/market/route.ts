import { NextResponse } from "next/server";
import { emptyMarkets, supportedPair, symbols, venues } from "@/lib/market";
import { fetchBook } from "@/lib/exchanges";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const selectedSymbols = symbols.filter((symbol) => (query.get("assets") || symbols.join(",")).split(",").includes(symbol));
  const selectedVenues = venues.filter((venue) => (query.get("venues") || venues.join(",")).split(",").includes(venue));
  const requested = query.get("pairs")?.split(",");
  const pairs = selectedSymbols.flatMap((symbol) => selectedVenues.filter((venue) =>
    supportedPair(symbol, venue) && (!requested || requested.includes(`${symbol}:${venue}`)))
    .map((venue) => ({ symbol, venue })));
  if (pairs.length > 36) return NextResponse.json({ error: "Too many pairs; request up to 36 at once" }, { status: 400 });
  if (pairs.filter(({ venue }) => venue === "CEX.IO").length > 4)
    return NextResponse.json({ error: "Request up to four CEX.IO pairs at once" }, { status: 400 });
  const results: Awaited<ReturnType<typeof fetchBook>>[] = [];
  const pending = pairs.map(({ symbol, venue }) => fetchBook(symbol, venue).then((result) => { results.push(result); }));
  // Return the quotes already received even if an exchange stalls in a preview or edge region.
  await Promise.race([Promise.all(pending), new Promise<void>((resolve) => setTimeout(resolve, 4500))]);
  const markets = emptyMarkets();
  const errors: string[] = [];
  const failedPairs: string[] = [];
  for (const item of results) {
    if (item.book) markets[item.symbol][item.venue] = item.book;
    if (item.error) { errors.push(item.error); failedPairs.push(`${item.symbol}:${item.venue}`); }
  }
  if (results.length < pending.length) errors.push(`${pending.length - results.length} quote requests timed out`);
  return NextResponse.json({ generatedAt: Date.now(), markets, errors, failedPairs }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
