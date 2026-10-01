import type { Leg } from "./opportunities";
import type { LegFill } from "./shadow";

// Spot paper balances are local to an exchange. Reservations lock the order's maximum
// input; they neither move assets between exchanges nor allow one concurrent leg to
// spend the proceeds of another. Persist this entire object before simulated execution.
export type PortfolioState = {
  version: 1;
  balances: Record<string, Record<string, number>>;
  reservations: Record<string, { legs: Leg[] }>;
  completed: Record<string, { status: "settled" | "cancelled"; fingerprint: string }>;
};
export type PortfolioCheck = { ok: boolean; reason?: string };
export type PortfolioResult = PortfolioCheck & { state: PortfolioState; duplicate?: boolean };
type Amounts = Map<string, Map<string, number>>;

const validKey = (key: string) => typeof key === "string" && key.length > 0 &&
  key !== "__proto__" && key !== "constructor" && key !== "prototype";
const finitePositive = (n: number) => Number.isFinite(n) && n > 0;
// Relative floating-point tolerance, small enough not to forgive real shortfalls in tiny assets.
const tolerance = (a: number, b: number) => Number.EPSILON * 32 * Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
const exceeds = (a: number, b: number) => a - b > tolerance(a, b);
const legKey = (leg: Leg) => `${leg.market}|${leg.side}`;
const inputAsset = (leg: Leg) => leg.side === "buy" ? leg.quote : leg.base;
const inputAmount = (leg: Leg, quantity = leg.qty, price = leg.price) =>
  leg.side === "buy" ? quantity * price * (1 + leg.fee) : quantity;
const orderData = (leg: Leg) => [leg.venue, leg.market, leg.base, leg.quote, leg.side, leg.qty, leg.price, leg.fee];
const orderFingerprint = (legs: Leg[]) => JSON.stringify(legs.map(orderData).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const fillData = (fill: LegFill) => [...orderData(fill.leg), fill.filledQty, fill.price, fill.feeAmount, fill.feeCurrency];
const fillFingerprint = (fills: LegFill[]) => JSON.stringify(fills.map(fillData).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;

function legProblem(leg: Leg): string | undefined {
  if (![leg.venue, leg.market, leg.base, leg.quote].every(validKey) || leg.base === leg.quote)
    return "Invalid venue, market, or asset";
  if (leg.side !== "buy" && leg.side !== "sell") return "Invalid order side";
  if (!finitePositive(leg.qty) || !finitePositive(leg.price) || !Number.isFinite(leg.fee) || leg.fee < 0 || leg.fee > 1)
    return "Quantity, price, and quote-currency fee must be finite and valid";
  if (!finitePositive(inputAmount(leg))) return "Order input is not finite";
}

function add(amounts: Amounts, venue: string, asset: string, amount: number) {
  const atVenue = amounts.get(venue) || new Map<string, number>();
  atVenue.set(asset, (atVenue.get(asset) || 0) + amount);
  amounts.set(venue, atVenue);
}

function required(legs: Leg[]): Amounts {
  const amounts: Amounts = new Map();
  for (const leg of legs) add(amounts, leg.venue, inputAsset(leg), inputAmount(leg));
  return amounts;
}

function held(state: PortfolioState, venue: string, asset: string): number {
  const value = own(own(state.balances, venue) || {}, asset) ?? 0;
  return Number.isFinite(value) && value >= 0 ? value : NaN;
}

export function initialPortfolio(startingBalance: number, venues: readonly string[]): PortfolioState {
  if (!Number.isFinite(startingBalance) || startingBalance < 0) throw new RangeError("Starting USD must be finite and nonnegative");
  const unique = [...new Set(venues)];
  if (!unique.length || !unique.every(validKey)) throw new RangeError("At least one valid venue is required");
  const balances: PortfolioState["balances"] = {};
  const share = startingBalance / unique.length;
  let remaining = startingBalance;
  unique.forEach((venue, index) => {
    const amount = index === unique.length - 1 ? Math.max(0, remaining) : share;
    balances[venue] = { USD: amount };
    remaining -= amount;
  });
  return { version: 1, balances, reservations: {}, completed: {} };
}

export function available(state: PortfolioState, venue: string, asset: string): number {
  let locked = 0;
  for (const reservation of Object.values(state.reservations)) for (const leg of reservation.legs)
    if (leg.venue === venue && inputAsset(leg) === asset) locked += inputAmount(leg);
  const balance = held(state, venue, asset);
  if (!Number.isFinite(locked) || !Number.isFinite(balance) || exceeds(locked, balance)) return 0;
  return Math.max(0, balance - locked);
}

export function canReserve(state: PortfolioState, legs: Leg[]): PortfolioCheck {
  if (!legs.length) return { ok: false, reason: "No order legs to reserve" };
  const seen = new Set<string>();
  for (const leg of legs) {
    const problem = legProblem(leg);
    if (problem) return { ok: false, reason: problem };
    if (seen.has(legKey(leg))) return { ok: false, reason: "Duplicate market and side in reservation" };
    seen.add(legKey(leg));
  }
  for (const [venue, assets] of required(legs)) for (const [asset, amount] of assets) {
    if (!Number.isFinite(amount) || exceeds(amount, available(state, venue, asset)))
      return { ok: false, reason: `Insufficient ${asset} on ${venue}` };
  }
  return { ok: true };
}

export function reserve(state: PortfolioState, tradeId: string, legs: Leg[]): PortfolioResult {
  if (!validKey(tradeId)) return { ok: false, state, reason: "Invalid transaction ID" };
  if (own(state.completed, tradeId)) return { ok: false, state, reason: "Transaction ID already completed" };
  const existing = own(state.reservations, tradeId);
  if (existing) return orderFingerprint(existing.legs) === orderFingerprint(legs)
    ? { ok: true, state, duplicate: true }
    : { ok: false, state, reason: "Transaction ID already reserves different orders" };
  const check = canReserve(state, legs);
  if (!check.ok) return { ...check, state };
  return { ok: true, state: { ...state, reservations: { ...state.reservations, [tradeId]: { legs: legs.map((leg) => ({ ...leg })) } } } };
}

function apply(state: PortfolioState, tradeId: string, fills: LegFill[], reserved: boolean): PortfolioResult {
  if (!validKey(tradeId)) return { ok: false, state, reason: "Invalid transaction ID" };
  const fingerprint = fillFingerprint(fills);
  const completed = own(state.completed, tradeId);
  if (completed) return completed.status === "settled" && completed.fingerprint === fingerprint
    ? { ok: true, state, duplicate: true }
    : { ok: false, state, reason: "Transaction ID already completed with another result" };
  const reservation = own(state.reservations, tradeId);
  if (reserved && !reservation) return { ok: false, state, reason: "No reservation for transaction" };
  if (!reserved && reservation) return { ok: false, state, reason: "Settle this reserved transaction instead" };
  const requested = new Map(reservation?.legs.map((leg) => [legKey(leg), leg]) || []);
  const seen = new Set<string>(), debits: Amounts = new Map(), credits: Amounts = new Map();
  for (const fill of fills) {
    const { leg, filledQty, price, feeAmount, feeCurrency } = fill;
    const problem = legProblem(leg);
    if (problem) return { ok: false, state, reason: problem };
    const identity = legKey(leg), order = requested.get(identity);
    if (seen.has(identity)) return { ok: false, state, reason: "Duplicate fill leg; aggregate its execution fills first" };
    seen.add(identity);
    if (reserved && (!order || JSON.stringify(orderData(order)) !== JSON.stringify(orderData(leg))))
      return { ok: false, state, reason: "Fill does not match reserved order" };
    if (!Number.isFinite(filledQty) || filledQty < 0 || exceeds(filledQty, leg.qty))
      return { ok: false, state, reason: "Invalid filled quantity" };
    if (!Number.isFinite(feeAmount) || feeAmount < 0 || !validKey(feeCurrency))
      return { ok: false, state, reason: "Invalid actual commission" };
    if (filledQty === 0) {
      if (price !== null && !finitePositive(price)) return { ok: false, state, reason: "Invalid unfilled order price" };
      if (feeAmount !== 0) return { ok: false, state, reason: "Unfilled paper order has a commission" };
      continue;
    }
    if (price === null || !finitePositive(price) || (leg.side === "buy" ? exceeds(price, leg.price) : exceeds(leg.price, price)))
      return { ok: false, state, reason: "Fill price violates the IOC limit" };
    let debit = leg.side === "buy" ? filledQty * price : filledQty;
    let credit = leg.side === "buy" ? filledQty : filledQty * price;
    const outputAsset = leg.side === "buy" ? leg.base : leg.quote;
    // An acquired-asset fee is withheld from proceeds. Fees in any third asset
    // require that asset on this venue; they are never silently valued as USD.
    if (feeCurrency === inputAsset(leg)) debit += feeAmount;
    else if (feeCurrency === outputAsset) {
      if (feeAmount > credit) add(debits, leg.venue, feeCurrency, feeAmount - credit);
      credit = Math.max(0, credit - feeAmount);
    } else if (feeAmount > 0) add(debits, leg.venue, feeCurrency, feeAmount);
    if (!Number.isFinite(debit) || !Number.isFinite(credit)) return { ok: false, state, reason: "Fill cash flow is not finite" };
    add(debits, leg.venue, inputAsset(leg), debit);
    add(credits, leg.venue, outputAsset, credit);
  }
  // Release only this transaction's locks for the affordability check. Proceeds are
  // credited after every input passes, preserving independence of concurrent orders.
  const reservations = { ...state.reservations };
  if (reserved) delete reservations[tradeId];
  const unlocked = { ...state, reservations };
  for (const [venue, assets] of debits) for (const [asset, amount] of assets) {
    if (!Number.isFinite(amount) || exceeds(amount, available(unlocked, venue, asset)))
      return { ok: false, state, reason: `Insufficient ${asset} on ${venue} for actual fills` };
  }
  const balances = Object.fromEntries(Object.entries(state.balances).map(([venue, assets]) => [venue, { ...assets }]));
  for (const [venue, assets] of debits) for (const [asset, amount] of assets)
    (balances[venue] ||= {})[asset] = Math.max(0, held(state, venue, asset) - amount);
  for (const [venue, assets] of credits) for (const [asset, amount] of assets) {
    const balance = own(balances[venue] || {}, asset) ?? 0;
    if (!Number.isFinite(balance + amount)) return { ok: false, state, reason: "Resulting balance is not finite" };
    (balances[venue] ||= {})[asset] = balance + amount;
  }
  return { ok: true, state: { ...state, balances, reservations,
    completed: { ...state.completed, [tradeId]: { status: "settled", fingerprint } } } };
}

// Final IOC outcomes: absent/zero fills release unused reservations. Partial fills
// leave their acquired assets in the portfolio until a separately evidenced exit.
export const settle = (state: PortfolioState, tradeId: string, fills: LegFill[]): PortfolioResult => apply(state, tradeId, fills, true);

// For evidenced, already simulated conversion/unwind fills, not a way to bypass
// affordability. Concurrent inputs must be funded before any output is credited.
export const applyFills = (state: PortfolioState, tradeId: string, fills: LegFill[]): PortfolioResult => apply(state, tradeId, fills, false);

// A triangle is a sequence, not three independently funded concurrent orders.
// Isolate the first reserved input and make each later leg spend only assets in
// that transaction wallet. No intermediate output becomes globally available
// until the caller commits this immutable result with the audit record.
export function settleSequence(state: PortfolioState, tradeId: string, fills: LegFill[]): PortfolioResult {
  if (!validKey(tradeId)) return { ok: false, state, reason: "Invalid transaction ID" };
  const fingerprint = `sequence:${JSON.stringify(fills.map(fillData))}`;
  const completed = own(state.completed, tradeId);
  if (completed) return completed.status === "settled" && completed.fingerprint === fingerprint
    ? { ok: true, state, duplicate: true }
    : { ok: false, state, reason: "Transaction ID already completed with another result" };
  const reservation = own(state.reservations, tradeId);
  if (!reservation || reservation.legs.length !== 1)
    return { ok: false, state, reason: "Sequential execution must reserve only its first leg" };
  const first = reservation.legs[0], venue = first.venue, asset = inputAsset(first), amount = inputAmount(first);
  const problem = legProblem(first);
  if (problem) return { ok: false, state, reason: problem };
  let wallet: PortfolioState = { version: 1, balances: { [venue]: { [asset]: amount } },
    reservations: { [tradeId]: { legs: [{ ...first }] } }, completed: {} };
  if (!fills.length) {
    const empty = settle(wallet, tradeId, []);
    if (!empty.ok) return { ...empty, state };
    wallet = empty.state;
  }
  for (let index = 0; index < fills.length; index++) {
    const fill = fills[index];
    if (fill.leg.venue !== venue) return { ok: false, state, reason: "Sequential triangle must remain on one venue" };
    if (index > 0) {
      const previous = fills[index - 1].leg;
      if (inputAsset(fill.leg) !== (previous.side === "buy" ? previous.base : previous.quote))
        return { ok: false, state, reason: "Sequential leg must spend its predecessor's output asset" };
    }
    const next = index === 0 ? settle(wallet, tradeId, [fill]) : applyFills(wallet, `${tradeId}:leg:${index}`, [fill]);
    if (!next.ok) return { ok: false, state, reason: `Sequential leg ${index + 1}: ${next.reason}` };
    wallet = next.state;
  }
  const reservations = { ...state.reservations };
  delete reservations[tradeId];
  if (exceeds(amount, available({ ...state, reservations }, venue, asset)))
    return { ok: false, state, reason: "Reserved starting input is no longer available" };
  const balances = { ...state.balances, [venue]: { ...state.balances[venue] } };
  balances[venue][asset] = Math.max(0, held(state, venue, asset) - amount);
  for (const [currency, value] of Object.entries(wallet.balances[venue])) {
    const resulting = (own(balances[venue], currency) ?? 0) + value;
    if (!Number.isFinite(resulting)) return { ok: false, state, reason: "Resulting balance is not finite" };
    balances[venue][currency] = resulting;
  }
  return { ok: true, state: { ...state, balances, reservations,
    completed: { ...state.completed, [tradeId]: { status: "settled", fingerprint } } } };
}

// Only call when the caller knows execution never began. A process restart must
// preserve unknown reservations until their outcome is resolved.
export function cancel(state: PortfolioState, tradeId: string): PortfolioResult {
  const completed = own(state.completed, tradeId);
  if (completed) return completed.status === "cancelled" ? { ok: true, state, duplicate: true }
    : { ok: false, state, reason: "Cannot cancel a settled transaction" };
  if (!validKey(tradeId) || !own(state.reservations, tradeId)) return { ok: false, state, reason: "No reservation for transaction" };
  const reservations = { ...state.reservations };
  delete reservations[tradeId];
  return { ok: true, state: { ...state, reservations,
    completed: { ...state.completed, [tradeId]: { status: "cancelled", fingerprint: "" } } } };
}
