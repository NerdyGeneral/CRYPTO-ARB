import type { Market, OrderRules } from "./markets";
import type { Leg, Opportunity } from "./opportunities";

// The immediate-or-cancel limit orders a trade's legs would be sent as. These only build requests: nothing
// here sends anything, and live sending isn't built.

// Use decimal integer arithmetic so arbitrary increments (0.125, 0.00025, 1e-8) stay exact.
// These helpers run when preparing an order, not on the quote-processing path.
const decimal = (value: number) => {
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const places = fraction.length - Number(exponent);
  const coefficient = BigInt(`${whole}${fraction}`);
  return places < 0 ? { coefficient: coefficient * BigInt(10) ** BigInt(-places), places: 0 } : { coefficient, places };
};
const stepDecimals = (step: number) => decimal(step).places;
const quantize = (value: number, step: number, up: boolean) => {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(step) || step <= 0) throw new RangeError("Order values must be finite and increments positive");
  const v = decimal(value), s = decimal(step), places = Math.max(v.places, s.places);
  const numerator = v.coefficient * BigInt(10) ** BigInt(places - v.places);
  const denominator = s.coefficient * BigInt(10) ** BigInt(places - s.places);
  const units = numerator / denominator + (up && numerator % denominator !== BigInt(0) ? BigInt(1) : BigInt(0));
  return Number(`${units * s.coefficient}e-${s.places}`);
};
export const floorToStep = (value: number, step: number) => quantize(value, step, false);
export const ceilToStep = (value: number, step: number) => quantize(value, step, true);

// Both sides of a cross-exchange trade must execute the same base quantity. Taking the smaller of two
// independent roundings is insufficient for different lots, e.g. 0.03 and 0.02 require multiples of 0.06.
export function floorToCommonStep(value: number, steps: number[]): number {
  if (!steps.length) return value;
  if (steps.some((step) => !Number.isFinite(step) || step <= 0)) throw new RangeError("Order increments must be positive");
  const parts = steps.map(decimal), places = Math.max(...parts.map((p) => p.places));
  const gcd = (a: bigint, b: bigint): bigint => { while (b !== BigInt(0)) { const next = a % b; a = b; b = next; } return a; };
  const common = parts.map((p) => p.coefficient * BigInt(10) ** BigInt(places - p.places))
    .reduce((a, b) => a / gcd(a, b) * b);
  return floorToStep(value, Number(`${common}e-${places}`));
}
export const formatStep = (value: number, step: number) => {
  if (!Number.isFinite(step) || step <= 0) throw new RangeError("Order increment must be positive");
  return value.toFixed(Math.min(100, stepDecimals(step)));
};

// Preserve the quoted worst acceptable price: never increase a buy limit or reduce a sell limit.
export function normalizeLeg(leg: Leg, rules: OrderRules | undefined): Leg {
  if (!rules) return { ...leg };
  return { ...leg, qty: floorToStep(leg.qty, rules.lot),
    price: leg.side === "buy" ? floorToStep(leg.price, rules.tick) : ceilToStep(leg.price, rules.tick) };
}

// Whether a leg would be accepted: its size rounded down to the exchange's lot must still clear the minimum
// size and value, and rounding mustn't shrink it enough to unbalance the trade. Exchanges whose rules aren't
// published in their public listing pass unchecked.
export function checkLeg(leg: Leg, rules: OrderRules | undefined): { qty: number; price: number; problem: string | null } {
  if (![leg.qty, leg.price].every((n) => Number.isFinite(n) && n > 0)) return { qty: 0, price: 0, problem: "Invalid order quantity or price" };
  if (!rules) return { qty: leg.qty, price: leg.price, problem: null };
  if (![rules.lot, rules.tick].every((n) => Number.isFinite(n) && n > 0)) return { qty: 0, price: 0, problem: "Invalid exchange order increments" };
  const { qty, price } = normalizeLeg(leg, rules);
  if (qty <= 0 || qty < rules.minQty) return { qty, price, problem: `Below ${leg.venue}'s minimum order size (${rules.minQty} ${leg.base})` };
  if (price <= 0 || qty * price < rules.minNotional) return { qty, price, problem: `Below ${leg.venue}'s minimum order value (${rules.minNotional} ${leg.quote})` };
  if (leg.qty - qty > leg.qty * 0.01) return { qty, price, problem: `${leg.venue}'s lot size would cut the order by over 1%` };
  return { qty, price, problem: null };
}

// Normalize one shared cross-route base quantity before reservation, logging, or shadow execution.
// Per-unit costs are unchanged by quantity normalization, so all dollar estimates scale together.
export function normalizeCrossOpportunity(opportunity: Opportunity, rulesFor: (leg: Leg) => OrderRules | undefined):
  { opportunity: Opportunity | null; problem: string | null } {
  if (opportunity.kind !== "cross") return { opportunity: null, problem: "Expected a cross-exchange route" };
  const originalQty = opportunity.legs[0]?.qty;
  if (!(originalQty > 0) || opportunity.legs.length !== 2 || opportunity.legs.some((leg) => leg.qty !== originalQty))
    return { opportunity: null, problem: "Cross-exchange legs must have equal positive quantities" };
  const rules = opportunity.legs.map(rulesFor);
  // Validate input before decimal arithmetic, which intentionally rejects invalid increments.
  for (let i = 0; i < opportunity.legs.length; i++) {
    const checked = checkLeg(opportunity.legs[i], rules[i]);
    if (checked.problem) return { opportunity: null, problem: checked.problem };
  }
  const qty = floorToCommonStep(originalQty, rules.flatMap((rule) => rule ? [rule.lot] : []));
  const legs = opportunity.legs.map((leg, i) => normalizeLeg({ ...leg, qty }, rules[i]));
  for (let i = 0; i < legs.length; i++) {
    const checked = checkLeg({ ...opportunity.legs[i], qty }, rules[i]);
    if (checked.problem) return { opportunity: null, problem: checked.problem };
    if (legs[i].qty !== qty) return { opportunity: null, problem: "Cross-exchange lot sizes do not match" };
    if (legs[i].price !== opportunity.legs[i].price) return { opportunity: null, problem: `${legs[i].venue}'s book price does not align with its order tick` };
  }
  if (originalQty - qty > originalQty * 0.01) return { opportunity: null, problem: "Shared lot size would cut the order by over 1%" };
  const fraction = qty / originalQty;
  return { opportunity: { ...opportunity, legs, notional: opportunity.notional * fraction, net: opportunity.net * fraction,
    fees: opportunity.fees * fraction, conversion: opportunity.conversion * fraction, buffer: opportunity.buffer * fraction }, problem: null };
}

// Kraken WebSocket v2 add_order, sent over the authenticated socket (wss://ws-auth.kraken.com/v2).
export function krakenAddOrder(leg: Leg, market: Market, o: { token: string; reqId: number; clientOrderId?: string; validate?: boolean }) {
  const { qty, price } = normalizeLeg(leg, market.rules);
  return {
    method: "add_order",
    params: {
      order_type: "limit", side: leg.side, order_qty: qty, symbol: market.ws, limit_price: price, time_in_force: "ioc",
      token: o.token, ...(o.clientOrderId ? { cl_ord_id: o.clientOrderId } : {}), ...(o.validate ? { validate: true } : {}),
    },
    req_id: o.reqId,
  };
}

// Coinbase Advanced Trade create order. Its only immediate-or-cancel limit order is sor_limit_ioc.
export function coinbaseCreateOrder(leg: Leg, market: Market, clientOrderId: string) {
  const rules = market.rules;
  const { qty, price } = normalizeLeg(leg, rules);
  return {
    method: "POST", host: "api.coinbase.com", path: "/api/v3/brokerage/orders",
    body: {
      client_order_id: clientOrderId, product_id: market.rest, side: leg.side === "buy" ? "BUY" : "SELL",
      order_configuration: { sor_limit_ioc: {
        base_size: rules ? formatStep(qty, rules.lot) : String(qty),
        limit_price: rules ? formatStep(price, rules.tick) : String(price),
      } },
    },
  };
}
