import type { Market, OrderRules } from "./markets";
import type { Leg } from "./opportunities";

// The immediate-or-cancel limit orders a trade's legs would be sent as. These only build requests: nothing
// here sends anything, and live sending isn't built.

// Decimal places a step needs: 0.01 -> 2, 0.5 -> 1, 0.25 -> 2, 0.125 -> 3, 1e-8 -> 8, 5 -> 0 (at most 12).
const stepDecimals = (step: number) => {
  for (let d = 0; d < 12; d++) {
    const scaled = step * 10 ** d;
    if (Math.round(scaled) >= 1 && Math.abs(scaled - Math.round(scaled)) < 1e-9 * scaled) return d;
  }
  return 12;
};

// Allowance for floating-point residue in a count of steps, a few units of precision at its size.
const slack = (n: number) => 1e-9 + Math.abs(n) * 1e-15;

// Rounds down (or up) to a whole number of steps without floating-point residue.
export function floorToStep(value: number, step: number) {
  const n = value / step;
  return Number((Math.floor(n + slack(n)) * step).toFixed(stepDecimals(step)));
}
export function ceilToStep(value: number, step: number) {
  const n = value / step;
  return Number((Math.ceil(n - slack(n)) * step).toFixed(stepDecimals(step)));
}

export const formatStep = (value: number, step: number) => value.toFixed(stepDecimals(step));

// A leg's limit price on the exchange's tick, never worse than the quoted price the trade was priced at:
// a buy rounds down and a sell rounds up. Book prices are already on the tick, so this only removes residue.
export const limitPrice = (leg: Leg, tick: number) => (leg.side === "buy" ? floorToStep : ceilToStep)(leg.price, tick);

// Whether a leg would be accepted: its size rounded down to the exchange's lot must still clear the minimum
// size and value, and rounding mustn't shrink it enough to unbalance the trade. Exchanges whose rules aren't
// published in their public listing pass unchecked.
export function checkLeg(leg: Leg, rules: OrderRules | undefined): { qty: number; problem: string | null } {
  if (!rules) return { qty: leg.qty, problem: null };
  const qty = floorToStep(leg.qty, rules.lot);
  if (qty <= 0 || qty < rules.minQty) return { qty, problem: `Below ${leg.venue}'s minimum order size (${rules.minQty} ${leg.base})` };
  if (qty * leg.price < rules.minNotional) return { qty, problem: `Below ${leg.venue}'s minimum order value (${rules.minNotional} ${leg.quote})` };
  if (leg.qty - qty > leg.qty * 0.01) return { qty, problem: `${leg.venue}'s lot size would cut the order by over 1%` };
  return { qty, problem: null };
}

// Whether a trade's legs would all be accepted, and the size to send each one at. A cross-exchange trade buys
// and sells the same amount of the coin, so both legs are rounded to one size that is a whole number of every
// exchange's lot; rounding each on its own could leave the two sides unequal and the difference unhedged.
// Triangle legs are in different assets and are each rounded to their own lot.
export function checkTrade(trade: { kind: "cross" | "triangle"; legs: Leg[] }, rulesFor: (leg: Leg) => OrderRules | undefined): { qtys: number[]; problem: string | null } {
  const rules = trade.legs.map(rulesFor);
  if (trade.kind !== "cross") {
    const checked = trade.legs.map((leg, i) => checkLeg(leg, rules[i]));
    return { qtys: checked.map((c) => c.qty), problem: checked.find((c) => c.problem)?.problem ?? null };
  }
  const wanted = Math.min(...trade.legs.map((leg) => leg.qty));
  const lots = rules.flatMap((r) => (r ? [r.lot] : []));
  const qty = lots.length ? floorToStep(wanted, Math.max(...lots)) : wanted;
  const qtys = trade.legs.map(() => qty);
  if (lots.some((lot) => floorToStep(qty, lot) !== qty)) {
    return { qtys, problem: `Lot sizes on ${trade.legs.map((leg) => leg.venue).join(" and ")} don't divide into a common order size` };
  }
  for (const [i, leg] of trade.legs.entries()) {
    const problem = checkLeg({ ...leg, qty }, rules[i]).problem;
    if (problem) return { qtys, problem };
  }
  if (wanted - qty > wanted * 0.01) return { qtys, problem: `Lot sizes on ${trade.legs.map((leg) => leg.venue).join(" and ")} would cut the order by over 1%` };
  return { qtys, problem: null };
}

// Kraken WebSocket v2 add_order, sent over the authenticated socket (wss://ws-auth.kraken.com/v2). Pass each leg
// with the size checkTrade gave it, so both sides of a cross-exchange trade go out equal.
export function krakenAddOrder(leg: Leg, market: Market, o: { token: string; reqId: number; clientOrderId?: string; validate?: boolean }) {
  const qty = market.rules ? floorToStep(leg.qty, market.rules.lot) : leg.qty;
  return {
    method: "add_order",
    params: {
      order_type: "limit", side: leg.side, order_qty: qty, symbol: market.ws, limit_price: market.rules ? limitPrice(leg, market.rules.tick) : leg.price, time_in_force: "ioc",
      token: o.token, ...(o.clientOrderId ? { cl_ord_id: o.clientOrderId } : {}), ...(o.validate ? { validate: true } : {}),
    },
    req_id: o.reqId,
  };
}

// Coinbase Advanced Trade create order. Its only immediate-or-cancel limit order is sor_limit_ioc.
export function coinbaseCreateOrder(leg: Leg, market: Market, clientOrderId: string) {
  const rules = market.rules;
  const qty = rules ? floorToStep(leg.qty, rules.lot) : leg.qty;
  return {
    method: "POST", host: "api.coinbase.com", path: "/api/v3/brokerage/orders",
    body: {
      client_order_id: clientOrderId, product_id: market.rest, side: leg.side === "buy" ? "BUY" : "SELL",
      order_configuration: { sor_limit_ioc: {
        base_size: rules ? formatStep(qty, rules.lot) : String(qty),
        limit_price: rules ? formatStep(limitPrice(leg, rules.tick), rules.tick) : String(leg.price),
      } },
    },
  };
}
