import type { Market, OrderRules } from "./markets";
import type { Leg } from "./opportunities";

// The immediate-or-cancel limit orders a trade's legs would be sent as. These only build requests: nothing
// here sends anything, and live sending isn't built.

// Decimal places a step needs: 0.01 -> 2, 0.5 -> 1, 0.25 -> 2, 1e-8 -> 8, 5 -> 0.
const stepDecimals = (step: number) => {
  const order = Math.round(-Math.log10(step));
  return Math.max(0, order + (Math.abs(step * 10 ** order - 1) < 1e-9 ? 0 : 1));
};

// Rounds down to a whole number of steps without floating-point residue.
export function floorToStep(value: number, step: number) {
  const decimals = Math.min(12, stepDecimals(step));
  return Number((Math.floor(value / step + 1e-9) * step).toFixed(decimals));
}

export const formatStep = (value: number, step: number) => value.toFixed(Math.min(12, stepDecimals(step)));

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

// Kraken WebSocket v2 add_order, sent over the authenticated socket (wss://ws-auth.kraken.com/v2).
export function krakenAddOrder(leg: Leg, market: Market, o: { token: string; reqId: number; clientOrderId?: string; validate?: boolean }) {
  const qty = market.rules ? floorToStep(leg.qty, market.rules.lot) : leg.qty;
  return {
    method: "add_order",
    params: {
      order_type: "limit", side: leg.side, order_qty: qty, symbol: market.ws, limit_price: leg.price, time_in_force: "ioc",
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
        limit_price: rules ? formatStep(leg.price, rules.tick) : String(leg.price),
      } },
    },
  };
}
