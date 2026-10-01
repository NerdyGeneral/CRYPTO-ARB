import type { Quote, Venue } from "./market";
import { isDollarStable } from "./markets";
import type { Leg, Opportunity } from "./opportunities";

// These are simulated executions against observed books, not exchange-confirmed fills.
export type LegFill = { leg: Leg; filledQty: number; price: number | null; feeAmount: number; feeCurrency: string; book: Quote | null; observedAt: number };
export type ShadowOutcome = "filled" | "partial" | "missed";
export type AssetCashflow = { venue: Venue; currency: string; amount: number };
export type Exposure = AssetCashflow & { reason: string };
export type ConversionBook = { market: string; quote: Quote; fee: number };
export type ShadowResult = {
  execution: "simulated";
  outcome: ShadowOutcome; expectedNet: number; realizedNet: number | null; filledFraction: number;
  // An incomplete result's USD cash flow is NOT profit: unresolved assets still have value or liabilities.
  knownNet: number; accountingComplete: boolean;
  unwound: string[]; fills: LegFill[]; unwindFills: LegFill[]; conversionFills: LegFill[];
  cashflows: AssetCashflow[]; unresolved: Exposure[];
};

const FULL = 1 - 1e-12;
const EPS = 1e-12;

export function fillLeg(leg: Leg, book: Quote | undefined): LegFill {
  const evidence = { book: book ? { ...book } : null, observedAt: Date.now() };
  const empty = { leg, filledQty: 0, price: null, feeAmount: 0, feeCurrency: leg.quote, ...evidence };
  if (!book || !Number.isFinite(leg.qty) || leg.qty <= 0 || !Number.isFinite(leg.price) || leg.price <= 0
    || !Number.isFinite(leg.fee) || leg.fee < 0) return empty;
  const price = leg.side === "buy" ? book.ask : book.bid;
  const size = leg.side === "buy" ? book.askSize : book.bidSize;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0
    || (leg.side === "buy" ? price > leg.price : price < leg.price)) return empty;
  const filledQty = Math.min(leg.qty, size);
  return { leg, filledQty, price, feeAmount: filledQty * price * leg.fee, feeCurrency: leg.quote, ...evidence };
}

// The portfolio applies every per-venue cash flow. For economic P&L, matched base inventory on different
// venues offsets (it remains inventory there); only unmatched base exposure is unwound. Stablecoin flows
// do NOT offset between venues: restoring each venue's stablecoin balance needs its own USD conversion.
// A conversion callback supplies an executable, fresh, local currency/USD book and its explicit fee.
// No callback/book or inadequate depth leaves the result unresolved, rather than inventing a fill.
export function settle(opportunity: Opportunity, fills: LegFill[], unwindBook: (market: string) => Quote | undefined,
  conversionBook?: (venue: Venue, currency: string) => ConversionBook | undefined): ShadowResult {
  const balances = new Map<string, AssetCashflow>();
  const id = (venue: Venue, currency: string) => `${venue}|${currency}`;
  const add = (venue: Venue, currency: string, amount: number) => {
    const key = id(venue, currency);
    balances.set(key, { venue, currency, amount: (balances.get(key)?.amount || 0) + amount });
  };
  const apply = ({ leg, filledQty, price, feeAmount, feeCurrency }: LegFill) => {
    if (!filledQty || price === null) return;
    const direction = leg.side === "buy" ? 1 : -1;
    add(leg.venue, leg.base, direction * filledQty);
    add(leg.venue, leg.quote, -direction * filledQty * price);
    add(leg.venue, feeCurrency, -feeAmount);
  };
  fills.forEach(apply);
  const total = (currency: string) => [...balances.values()].filter((b) => b.currency === currency).reduce((n, b) => n + b.amount, 0);
  const reasons = new Map<string, string>();
  // A displayed level cannot be consumed again by another unwind/conversion in this settlement.
  const remaining = new Map<string, number>();
  const consume = (leg: Leg, book: Quote): LegFill => {
    const key = `${leg.market}|${leg.side}`;
    const available = remaining.get(key) ?? (leg.side === "buy" ? book.askSize : book.bidSize);
    const result = fillLeg(leg, { ...book, [leg.side === "buy" ? "askSize" : "bidSize"]: available });
    remaining.set(key, available - result.filledQty);
    return result;
  };
  const unwound: string[] = [], unwindFills: LegFill[] = [], conversionFills: LegFill[] = [];
  // A triangle unwind can produce another non-dollar currency. Iterate until no further fill is possible.
  for (let pass = 0; pass <= opportunity.legs.length; pass++) {
    let progressed = false;
    const currencies = new Set([...balances.values()].map((b) => b.currency));
    for (const currency of currencies) {
      if (currency === "USD" || isDollarStable(currency)) continue;
      for (const balance of [...balances.values()].filter((b) => b.currency === currency)) {
        const amount = total(currency), current = balances.get(id(balance.venue, currency))!.amount;
        if (Math.abs(amount) < EPS || Math.sign(current) !== Math.sign(amount)) continue;
        const candidates = opportunity.legs.filter((leg) => leg.venue === balance.venue && leg.base === currency);
        const source = candidates.find((l) => l.quote === "USD" || isDollarStable(l.quote)) || candidates[candidates.length - 1];
        const key = id(balance.venue, currency);
        if (!source) { reasons.set(key, "No unwind market on the venue holding the exposure"); continue; }
        const book = unwindBook(source.market);
        if (!book) { reasons.set(key, "No fresh unwind book"); continue; }
        const side = amount > 0 ? "sell" : "buy";
        const leg = { ...source, side, qty: Math.min(Math.abs(amount), Math.abs(current)),
          price: side === "sell" ? book.bid : book.ask, size: side === "sell" ? book.bidSize : book.askSize } satisfies Leg;
        const fill = consume(leg, book);
        reasons.set(key, "Insufficient executable unwind depth");
        if (!fill.filledQty) continue;
        apply(fill); unwindFills.push(fill); progressed = true;
        unwound.push(`${side === "sell" ? "sold" : "bought back"} ${fill.filledQty.toPrecision(4)} ${currency} on ${leg.venue}`);
      }
    }
    if (!progressed) break;
  }
  // These fills are separately auditable simulated conversions, never a midpoint valuation or $1 fallback.
  for (const balance of [...balances.values()]) {
    if (!isDollarStable(balance.currency) || Math.abs(balance.amount) < EPS) continue;
    const key = id(balance.venue, balance.currency);
    const conversion = conversionBook?.(balance.venue, balance.currency);
    if (!conversion || conversion.market !== `${balance.venue}|${balance.currency}/USD`) {
      reasons.set(key, "No fresh same-venue USD conversion book"); continue;
    }
    const side = balance.amount > 0 ? "sell" : "buy", book = conversion.quote;
    const leg: Leg = { venue: balance.venue, pair: `${balance.currency}/USD`, base: balance.currency, quote: "USD", side,
      price: side === "sell" ? book.bid : book.ask, market: conversion.market,
      size: side === "sell" ? book.bidSize : book.askSize, qty: Math.abs(balance.amount), fee: conversion.fee };
    const fill = consume(leg, book);
    reasons.set(key, "Insufficient executable USD conversion depth");
    if (fill.filledQty) { apply(fill); conversionFills.push(fill); }
  }
  const unresolved: Exposure[] = [];
  for (const currency of new Set([...balances.values()].map((b) => b.currency))) {
    if (currency === "USD") continue;
    const own = [...balances.values()].filter((b) => b.currency === currency);
    if (isDollarStable(currency)) {
      for (const b of own) if (Math.abs(b.amount) >= EPS) unresolved.push({ ...b, reason: reasons.get(id(b.venue, currency)) || "USD conversion incomplete" });
      continue;
    }
    let outstanding = total(currency);
    for (const b of own) {
      if (Math.abs(outstanding) < EPS || Math.sign(b.amount) !== Math.sign(outstanding)) continue;
      const amount = Math.sign(outstanding) * Math.min(Math.abs(outstanding), Math.abs(b.amount));
      unresolved.push({ ...b, amount, reason: reasons.get(id(b.venue, currency)) || "Unmatched asset exposure" });
      outstanding -= amount;
    }
  }
  const cashflows = [...balances.values()].filter((b) => Math.abs(b.amount) >= EPS);
  const knownNet = total("USD"), accountingComplete = unresolved.length === 0;
  const fractions = fills.map((f) => f.leg.qty ? f.filledQty / f.leg.qty : 0);
  const filledFraction = fractions.length ? Math.min(...fractions) : 0;
  const outcome: ShadowOutcome = fractions.length && fractions.every((f) => f >= FULL) ? "filled" : fractions.every((f) => f === 0) ? "missed" : "partial";
  return { execution: "simulated", outcome, expectedNet: opportunity.net, realizedNet: accountingComplete ? knownNet : null,
    knownNet, accountingComplete, filledFraction, unwound, fills, unwindFills, conversionFills, cashflows, unresolved };
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
  get(venue: string) { return this.percentile(venue, 0.5); }
  percentile(venue: string, p: number) {
    const list = this.samples.get(venue);
    if (!list?.length) return this.fallbackMs;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }
  measured(venue: string) { return (this.samples.get(venue)?.length || 0) > 0; }
}
