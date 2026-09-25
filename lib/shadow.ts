import type { Quote } from "./market";
import { isDollarStable } from "./markets";
import type { Leg, Opportunity } from "./opportunities";

// Shadow execution: replays a paper trade as immediate-or-cancel limit orders against the order books as
// they stood when the orders would actually have reached each exchange, one round trip after the decision.
// A leg fills only if the book still offers its price (or better), up to the size shown at the top.
// Whatever does not match up is unwound at the next available prices, so a one-sided fill shows its cost.

export type LegFill = { leg: Leg; filledQty: number; price: number | null };
export type ShadowOutcome = "filled" | "partial" | "missed";
export type ShadowResult = {
  outcome: ShadowOutcome; expectedNet: number; realizedNet: number; filledFraction: number;
  unwound: string[]; fills: LegFill[];
};

const FULL = 0.999;

export function fillLeg(leg: Leg, book: Quote | undefined): LegFill {
  if (!book) return { leg, filledQty: 0, price: null };
  if (leg.side === "buy") {
    if (book.ask > leg.price) return { leg, filledQty: 0, price: null };
    return { leg, filledQty: Math.min(leg.qty, book.askSize), price: book.ask };
  }
  if (book.bid < leg.price) return { leg, filledQty: 0, price: null };
  return { leg, filledQty: Math.min(leg.qty, book.bidSize), price: book.bid };
}

// `dollar(currency, amount)` gives the USD value of one unit of a stablecoin: what it fetches when held
// (amount > 0) or what it costs to replace when spent (amount < 0), conversion cost included.
export function settle(opportunity: Opportunity, fills: LegFill[], unwindBook: (market: string) => Quote | undefined,
  dollar: (currency: string, amount: number) => number): ShadowResult {
  const balances = new Map<string, number>();
  const add = (currency: string, amount: number) => balances.set(currency, (balances.get(currency) || 0) + amount);
  for (const { leg, filledQty, price } of fills) {
    if (!filledQty || price === null) continue;
    if (leg.side === "buy") { add(leg.base, filledQty); add(leg.quote, -filledQty * price * (1 + leg.fee)); }
    else { add(leg.base, -filledQty); add(leg.quote, filledQty * price * (1 - leg.fee)); }
  }
  // Coins left over (bought but not sold, or sold but not bought) are closed out on the market of the leg
  // that traded them, preferring one priced in dollars, at that market's latest price and taker fee.
  const unwound: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const [currency, amount] of [...balances]) {
      if (currency === "USD" || isDollarStable(currency) || Math.abs(amount) < 1e-12) continue;
      const candidates = opportunity.legs.filter((leg) => leg.base === currency);
      const leg = candidates.find((l) => l.quote === "USD" || isDollarStable(l.quote)) || candidates[candidates.length - 1];
      if (!leg) continue;
      // Without a fresh book, fall back to the leg's own price.
      const book = unwindBook(leg.market);
      const bid = book?.bid ?? leg.price, ask = book?.ask ?? leg.price;
      balances.set(currency, 0);
      if (amount > 0) add(leg.quote, amount * bid * (1 - leg.fee));
      else add(leg.quote, amount * ask * (1 + leg.fee));
      unwound.push(`${amount > 0 ? "sold" : "bought back"} ${Math.abs(amount).toPrecision(4)} ${currency} on ${leg.venue}`);
    }
  }
  let realizedNet = 0;
  for (const [currency, amount] of balances) {
    if (currency === "USD") realizedNet += amount;
    else if (isDollarStable(currency)) realizedNet += amount * dollar(currency, amount);
  }
  const fractions = fills.map((f) => f.leg.qty ? f.filledQty / f.leg.qty : 0);
  const filledFraction = fractions.length ? Math.min(...fractions) : 0;
  const outcome: ShadowOutcome = fractions.every((f) => f >= FULL) ? "filled" : fractions.every((f) => f === 0) ? "missed" : "partial";
  return { outcome, expectedNet: opportunity.net, realizedNet: outcome === "missed" ? 0 : realizedNet, filledFraction, unwound, fills };
}

// Round-trip latency per venue from repeated lightweight requests; the median resists one-off stalls.
export class LatencyTracker {
  private readonly samples = new Map<string, number[]>();
  constructor(private readonly fallbackMs = 300, private readonly keep = 15) {}
  record(venue: string, ms: number) {
    const list = this.samples.get(venue) || [];
    list.push(ms);
    if (list.length > this.keep) list.shift();
    this.samples.set(venue, list);
  }
  get(venue: string) {
    const list = this.samples.get(venue);
    if (!list?.length) return this.fallbackMs;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  measured(venue: string) { return (this.samples.get(venue)?.length || 0) > 0; }
}
