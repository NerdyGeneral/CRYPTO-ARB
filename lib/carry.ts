import type { Venue } from "./market";

// Spot vs futures carry: hold a coin and short the same amount of its perpetual future, so price moves cancel
// out and the position collects the funding that longs pay shorts while the future trades above spot.
// Futures here are Coinbase Financial Markets' US perpetual-style contracts (venue "cde"): funding accrues every
// hour at roughly (futures − spot premium over the hour) / 24, and positive funding is paid by longs to shorts.

export const HOURS_PER_YEAR = 24 * 365;

export type Perp = {
  id: string; coin: string; contractSize: number; price: number; index: number;
  // Last settled hourly funding rate (a fraction) and when it settled.
  fundingRate: number; fundingTime: number; intervalHours: number;
  // Overnight margin a short needs, as a fraction of its notional (the stricter of Coinbase's two rates).
  shortMargin: number;
  openInterest: number; volume24h: number;
};
export type Dated = { id: string; coin: string; contractSize: number; price: number; expiry: number; shortMargin: number; volume24h: number };
export type Book = { bid: number; ask: number; bidSize: number; askSize: number; at: number };
export type SpotSide = { venue: Venue; bid: number; ask: number; bidSize: number; askSize: number; fee: number; at: number };

type Product = {
  product_id: string; price: string; volume_24h?: string; trading_disabled?: boolean; is_disabled?: boolean; cancel_only?: boolean;
  future_product_details?: {
    venue?: string; contract_size?: string; contract_root_unit?: string; contract_expiry?: string; non_crypto?: boolean;
    funding_interval?: string | null; funding_rate?: string; funding_time?: string | null; index_price?: string; open_interest?: string;
    intraday_margin_rate?: { short_margin_rate?: string }; overnight_margin_rate?: { short_margin_rate?: string };
  } | null;
};

const num = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? n : NaN; };

// Reads Coinbase's public futures product list. Only crypto contracts on Coinbase's US derivatives exchange
// that are open for trading are kept; perpetuals are the ones with a funding interval.
export function parseFutures(body: unknown): { perps: Perp[]; dated: Dated[] } {
  const products = ((body as { products?: Product[] })?.products || []);
  const perps: Perp[] = [], dated: Dated[] = [];
  for (const p of products) {
    const f = p.future_product_details;
    if (!f || f.venue !== "cde" || f.non_crypto || p.trading_disabled || p.is_disabled || p.cancel_only) continue;
    const coin = String(f.contract_root_unit || "").toUpperCase(), contractSize = num(f.contract_size), price = num(p.price);
    const margins = [num(f.overnight_margin_rate?.short_margin_rate), num(f.intraday_margin_rate?.short_margin_rate)].filter((m) => m > 0);
    if (!coin || !(contractSize > 0) || !(price > 0) || !margins.length) continue;
    const shortMargin = Math.max(...margins), volume24h = num(p.volume_24h) || 0;
    const interval = /^(\d+)s$/.exec(String(f.funding_interval || ""));
    if (interval) {
      const fundingRate = num(f.funding_rate), fundingTime = Date.parse(String(f.funding_time || "")), index = num(f.index_price);
      if (!Number.isFinite(fundingRate) || !Number.isFinite(fundingTime) || !(index > 0) || Number(interval[1]) <= 0) continue;
      perps.push({ id: p.product_id, coin, contractSize, price, index, fundingRate, fundingTime, intervalHours: Number(interval[1]) / 3600,
        shortMargin, openInterest: num(f.open_interest) || 0, volume24h });
    } else {
      const expiry = Date.parse(String(f.contract_expiry || ""));
      if (Number.isFinite(expiry)) dated.push({ id: p.product_id, coin, contractSize, price, expiry, shortMargin, volume24h });
    }
  }
  return { perps, dated };
}

// Some contracts are priced per 1,000 coins (e.g. SHIB, PEPE); this is how many coins one unit of the
// futures price stands for, found by comparing it with the coin's spot price.
export function coinsPerPriceUnit(futuresPrice: number, spotPrice: number) {
  const ratio = futuresPrice / spotPrice;
  return ratio > 30 ? 10 ** Math.round(Math.log10(ratio)) : 1;
}

// Collateral has to be at least this multiple of the overnight margin requirement to open.
export const MARGIN_HEADROOM = 1.25;

export type CarryOptions = {
  futuresFee: number; // taker fee per side, as a fraction
  marginBuffer: number; // collateral held against the short, as a fraction of its notional
  holdDays: number; // how long a position is expected to stay open, to spread the round-trip costs
  capital: number; // most capital to put into this position (spot cost plus collateral)
};

export type CarryQuote = {
  contracts: number; spotQty: number; notional: number; capital: number;
  roundTripPct: number; fundingApr: number; netApr: number; netAprOnCapital: number; breakEvenHours: number | null;
  basisPct: number; reason: string | null;
};

// What a carry position would cost and earn right now, sized in whole contracts. `fundingApr` is the expected
// funding (a fraction per year); costs are both fees on both legs, in and out, plus crossing each spread.
export function quoteCarry(perp: Perp, book: Book, spot: SpotSide, unit: number, fundingApr: number, o: CarryOptions): CarryQuote {
  const coinsPerContract = perp.contractSize * unit;
  const contractNotional = perp.contractSize * book.bid;
  // Cash one contract ties up: the coins with their fee, the collateral and the futures fee.
  const perContractCapital = coinsPerContract * spot.ask * (1 + spot.fee) + contractNotional * (o.marginBuffer + o.futuresFee);
  const budgetContracts = Math.max(0, Math.floor(o.capital / perContractCapital));
  const futuresContracts = Math.max(0, Math.floor(book.bidSize));
  const spotContracts = Math.max(0, Math.floor(spot.askSize / coinsPerContract));
  const contracts = Math.min(budgetContracts, futuresContracts, spotContracts);
  const spotMid = (spot.bid + spot.ask) / 2, perpMid = (book.bid + book.ask) / 2;
  const roundTripPct = 2 * spot.fee + 2 * o.futuresFee + (spot.ask - spot.bid) / spotMid + (book.ask - book.bid) / perpMid;
  const netApr = fundingApr - roundTripPct * 365 / o.holdDays;
  const hourly = fundingApr / HOURS_PER_YEAR;
  const base = {
    contracts, spotQty: contracts * coinsPerContract, notional: contracts * contractNotional, capital: contracts * perContractCapital,
    roundTripPct, fundingApr, netApr, netAprOnCapital: netApr / (1 + o.marginBuffer), breakEvenHours: hourly > 0 ? roundTripPct / hourly : null,
    basisPct: (book.bid / unit / spot.ask - 1) * 100,
  };
  // Collateral must clear the overnight margin with room for the price to rise before a margin call.
  const reason = o.marginBuffer < perp.shortMargin * MARGIN_HEADROOM
    ? `Needs over ${Math.ceil(perp.shortMargin * MARGIN_HEADROOM * 100)}% collateral (overnight margin is ${Math.round(perp.shortMargin * 100)}%)` :
    budgetContracts < 1 ? `One contract needs $${Math.ceil(perContractCapital).toLocaleString("en-US")}` :
    futuresContracts < 1 ? "Not enough futures size at the best bid" :
    spotContracts < 1 ? `Not enough ${perp.coin} at the best ask on ${spot.venue}` : null;
  return { ...base, reason };
}

export type CarryPosition = {
  id: string; perpId: string; coin: string; spotVenue: Venue; unit: number;
  contracts: number; contractSize: number; spotQty: number; openedAt: number;
  entrySpot: number; entryPerp: number; collateral: number; spotFee: number; futuresFee: number;
  fees: number; funding: number; fundingPayments: number; lastFundingTime: number;
  // Only funding with a settlement-time futures mark may be included in funding.
  unresolvedFundingPayments?: number; legacyFundingEstimate?: number;
  lastMark?: { at: number; mark: Mark };
  closedAt?: number; exitSpot?: number; exitPerp?: number; closeReason?: string; realized?: number;
};

// Opens at the spot ask and the futures bid, paying both taker fees.
export function openCarry(id: string, perp: Perp, book: Book, spot: SpotSide, unit: number, contracts: number, o: CarryOptions, now: number): CarryPosition {
  const spotQty = contracts * perp.contractSize * unit, shortNotional = contracts * perp.contractSize * book.bid;
  return {
    id, perpId: perp.id, coin: perp.coin, spotVenue: spot.venue, unit, contracts, contractSize: perp.contractSize, spotQty, openedAt: now,
    entrySpot: spot.ask, entryPerp: book.bid, collateral: shortNotional * o.marginBuffer, spotFee: spot.fee, futuresFee: o.futuresFee,
    fees: spotQty * spot.ask * spot.fee + shortNotional * o.futuresFee, funding: 0, fundingPayments: 0, lastFundingTime: now, unresolvedFundingPayments: 0,
  };
}

// Cash put in at the open: the coins bought (with their fee) plus the collateral and the futures fee.
export const openingCost = (p: CarryPosition) => p.spotQty * p.entrySpot * (1 + p.spotFee) + p.collateral + p.contracts * p.contractSize * p.entryPerp * p.futuresFee;

// Requires the futures mark for that specific settlement, never a current spot index.
export function fundingPayment(p: CarryPosition, rate: number, settlementMark: number) {
  return p.contracts * p.contractSize * settlementMark * rate;
}

// Persisted counters survive pruning the recent closed-position display list.
export type CarryAccounting = {
  version: 1; lifetimeFees: number; confirmedFunding: number;
  unresolvedFundingPayments: number; historyComplete: boolean;
  legacyFundingEstimate: number;
};

export type Mark = {
  spotPnl: number; shortPnl: number; exitFees: number; value: number; net: number;
  marginRatio: number; riseToMarginCall: number;
};

// Value if closed now (coins sold at the bid, short bought back at the ask, both fees paid), and how far the
// futures price could rise before the short's account falls below its margin requirement. Funding is paid
// into the futures account, so it counts toward the margin.
export function markCarry(p: CarryPosition, spotBid: number, perpAsk: number, shortMargin: number): Mark {
  const k = p.contracts * p.contractSize;
  const spotPnl = p.spotQty * (spotBid - p.entrySpot);
  const shortPnl = k * (p.entryPerp - perpAsk);
  const exitFees = p.spotQty * spotBid * p.spotFee + k * perpAsk * p.futuresFee;
  const value = p.spotQty * spotBid * (1 - p.spotFee) + p.collateral + shortPnl + p.funding - k * perpAsk * p.futuresFee;
  const equity = p.collateral + p.funding + shortPnl;
  const callPrice = (p.collateral + p.funding + k * p.entryPerp) / (k * (1 + shortMargin));
  return {
    spotPnl, shortPnl, exitFees, value, net: value - openingCost(p),
    marginRatio: equity / (k * perpAsk), riseToMarginCall: callPrice / perpAsk - 1,
  };
}

// Average of the settled hourly rates since `since`, as a yearly rate; null with too few settlements.
export function trailingApr(history: { time: number; rate: number }[], since: number, minSamples: number) {
  const recent = history.filter((h) => h.time >= since);
  if (recent.length < minSamples) return null;
  return recent.reduce((sum, h) => sum + h.rate, 0) / recent.length * HOURS_PER_YEAR;
}

// Dated futures: short the future and hold the coin to expiry, locking in the gap between them.
export function quoteDated(d: Dated, book: Book, spot: SpotSide, unit: number, now: number, o: Pick<CarryOptions, "futuresFee" | "marginBuffer">) {
  const days = (d.expiry - now) / 86_400_000;
  const basisPct = (book.bid / unit / spot.ask - 1) * 100;
  // In: spot fee and futures fee; at expiry: the coin is sold (spot fee) and the future settles in cash.
  const costsPct = (2 * spot.fee + 2 * o.futuresFee + (spot.ask - spot.bid) / ((spot.ask + spot.bid) / 2)) * 100;
  const netPct = basisPct - costsPct;
  const netApr = days > 0 ? netPct / 100 * 365 / days : null;
  return { days, basisPct, netPct, netApr, netAprOnCapital: netApr === null ? null : netApr / (1 + o.marginBuffer) };
}
