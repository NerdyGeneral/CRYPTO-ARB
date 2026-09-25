import { NextResponse } from "next/server";
import { publicFeeSources, parsePublishedTaker } from "@/lib/public-fees";
import type { PublicFeesResponse, Venue } from "@/lib/market";

let cached: { until: number; data: PublicFeesResponse } | null = null;

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  if (!force && cached && cached.until > Date.now())
    return NextResponse.json(cached.data, { headers: { "Cache-Control": "no-store" } });

  const rates: PublicFeesResponse["rates"] = {};
  const errors: string[] = [];
  await Promise.all(Object.entries(publicFeeSources).map(async ([name, url]) => {
    const venue = name as Venue;
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error("source unavailable");
      const rate = parsePublishedTaker(venue, await response.text());
      if (rate === null) throw new Error("schedule format changed");
      rates[venue] = { rate, checkedAt: Date.now(), url };
    } catch { errors.push(`${venue} public fee schedule unavailable`); }
  }));
  const data: PublicFeesResponse = { checkedAt: Date.now(), rates, errors };
  cached = { until: Date.now() + 60 * 60 * 1000, data };
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
