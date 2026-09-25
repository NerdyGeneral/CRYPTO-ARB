import type { Venue } from "./market";

// Checks whether a suspect gap (a raw gap above maxGap) could actually be captured, using public data:
//  - token identity: CoinGecko maps each exchange's ticker to a coin, which exposes two different tokens
//    that share a symbol (e.g. Litentry vs Lighter, both "LIT");
//  - price anomaly: CoinGecko flags tickers whose price is an outlier against the rest of the market;
//  - transfers: whether the buy exchange allows withdrawals and the sell exchange allows deposits;
//  - duration: real arbitrage gaps close within minutes, so a gap that lasts hours has a reason.

export type CheckLevel = "blocked" | "warning" | "ok" | "unknown";
export type Check = { level: CheckLevel; text: string };
export type VerdictKind = "different-tokens" | "transfers-blocked" | "price-anomaly" | "no-barrier-found" | "unverified";
export type Verdict = { kind: VerdictKind; summary: string; checks: Check[]; checkedAt: number };
export type Fetcher = (url: string, init?: RequestInit) => Promise<unknown>;

export const coingeckoExchange: Partial<Record<Venue, string>> = {
  Coinbase: "gdax", Kraken: "kraken", Gemini: "gemini", Bitstamp: "bitstamp", "CEX.IO": "cex",
  "Binance.US": "binance_us", bitFlyer: "bitflyer", "Crypto.com": "crypto_com",
};

export type Transfer = { deposit: boolean | null; withdrawal: boolean | null; name?: string };

// Public deposit/withdrawal status, where the exchange publishes it; null when it does not.
export async function transferStatus(venue: Venue, coin: string, get: Fetcher): Promise<Transfer | null> {
  if (venue === "Kraken") {
    const body = await get(`https://api.kraken.com/0/public/Assets?asset=${coin === "BTC" ? "XBT" : coin}`) as { result?: Record<string, { status?: string }> };
    const status = body.result && Object.values(body.result)[0]?.status;
    if (!status) return null;
    return {
      deposit: status === "enabled" || status === "deposit_only",
      withdrawal: status === "enabled" || status === "withdrawal_only",
    };
  }
  if (venue === "Coinbase") {
    const body = await get(`https://api.exchange.coinbase.com/currencies/${coin}`) as { name?: string; status?: string; supported_networks?: { status?: string }[] };
    if (!body.status) return null;
    const open = body.status === "online" && (body.supported_networks || []).some((n) => n.status === "online");
    return { deposit: open, withdrawal: open, name: body.name };
  }
  if (venue === "Bitstamp") {
    const list = await get("https://www.bitstamp.net/api/v2/currencies/") as { currency: string; name: string; deposit: string; withdrawal: string }[];
    const row = list.find((c) => c.currency === coin);
    return row ? { deposit: row.deposit === "Enabled", withdrawal: row.withdrawal === "Enabled", name: row.name } : null;
  }
  if (venue === "CEX.IO") {
    const body = await get("https://trade.cex.io/api/spot/rest-public/get_currencies_info",
      { method: "POST", body: JSON.stringify({ currencies: [coin] }), headers: { "Content-Type": "application/json" } }) as { data?: { currency: string; walletDeposit: boolean; walletWithdrawal: boolean }[] };
    const row = body.data?.find((c) => c.currency === coin);
    return row ? { deposit: row.walletDeposit, withdrawal: row.walletWithdrawal } : null;
  }
  return null;
}

export type Listing = { id: string; name: string; anomaly: boolean; stale: boolean; target: string };
export type TokenMap = { candidates: { id: string; name: string }[]; byExchange: Record<string, Listing[]> };

// Which CoinGecko coin each exchange's ticker for `coin` belongs to. `get` is expected to pace its requests.
export async function tokenMap(coin: string, get: Fetcher): Promise<TokenMap> {
  const search = await get(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(coin)}`) as { coins?: { id: string; name: string; symbol: string; market_cap_rank: number | null }[] };
  const candidates = (search.coins || []).filter((c) => c.symbol.toUpperCase() === coin.toUpperCase())
    .sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9)).slice(0, 4).map(({ id, name }) => ({ id, name }));
  const exchanges = Object.values(coingeckoExchange).join(",");
  const byExchange: Record<string, Listing[]> = {};
  for (const candidate of candidates) {
    const body = await get(`https://api.coingecko.com/api/v3/coins/${candidate.id}/tickers?exchange_ids=${exchanges}`) as { tickers?: { base: string; target: string; is_anomaly: boolean; is_stale: boolean; market: { identifier: string } }[] };
    for (const t of body.tickers || []) {
      if (t.base.toUpperCase() !== coin.toUpperCase()) continue;
      (byExchange[t.market.identifier] ||= []).push({ id: candidate.id, name: candidate.name, anomaly: t.is_anomaly, stale: t.is_stale, target: t.target });
    }
  }
  return { candidates, byExchange };
}

const minutes = (ms: number) => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${(ms / 3_600_000).toFixed(1)} h`;

export function judge(input: {
  coin: string; buy: { venue: Venue; quote: string }; sell: { venue: Venue; quote: string };
  tokens: TokenMap | null; buyTransfer: Transfer | null; sellTransfer: Transfer | null; ageMs: number | null; now: number;
}): Verdict {
  const { coin, buy, sell, tokens } = input;
  const checks: Check[] = [];
  let kind: VerdictKind | null = null;

  // Token identity and CoinGecko's outlier flag.
  const listings = (venue: Venue) => tokens?.byExchange[coingeckoExchange[venue] || ""] || [];
  const nameOf = (id: string) => tokens?.candidates.find((c) => c.id === id)?.name || id;
  const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Where CoinGecko doesn't track an exchange's ticker, the name the exchange itself publishes can still
  // identify the token, if it matches exactly one CoinGecko coin with this symbol.
  const notes: Check[] = [];
  const idsOn = (venue: Venue, transfer: Transfer | null) => {
    const ids = [...new Set(listings(venue).map((l) => l.id))];
    if (ids.length || !tokens || !transfer?.name) return ids;
    const named = tokens.candidates.filter((c) => plain(c.name) === plain(transfer.name!));
    if (named.length !== 1) return ids;
    notes.push({ level: "unknown", text: `CoinGecko doesn't track ${venue}'s ${coin}; ${venue} calls it “${transfer.name}”, taken as ${named[0].name}.` });
    return [named[0].id];
  };
  const buyIds = idsOn(buy.venue, input.buyTransfer), sellIds = idsOn(sell.venue, input.sellTransfer);
  let tokenOk = false;
  if (!tokens) checks.push({ level: "unknown", text: "Couldn't reach CoinGecko to compare the tokens." });
  else if (buyIds.length === 1 && sellIds.length === 1 && buyIds[0] !== sellIds[0]) {
    checks.push({ level: "blocked", text: `Different tokens: ${buy.venue}'s ${coin} is ${nameOf(buyIds[0])}, ${sell.venue}'s ${coin} is ${nameOf(sellIds[0])}.` });
    kind = "different-tokens";
  } else {
    const shared = buyIds.find((id) => sellIds.includes(id));
    if (shared) { checks.push({ level: "ok", text: `Same token on both exchanges (${nameOf(shared)}).` }); tokenOk = true; }
    for (const [venue, ids] of [[buy.venue, buyIds], [sell.venue, sellIds]] as const)
      if (!ids.length) checks.push({ level: "unknown", text: `CoinGecko doesn't list ${coin} on ${venue}, so the token couldn't be confirmed there.` });
    for (const side of [buy, sell]) {
      const own = listings(side.venue).filter((l) => !shared || l.id === shared);
      const flagged = own.find((l) => l.target === side.quote && l.anomaly) || own.find((l) => l.anomaly);
      if (flagged) {
        checks.push({ level: "warning", text: `CoinGecko flags ${side.venue}'s ${coin}/${flagged.target} price as an outlier against the rest of the market.` });
        kind ||= "price-anomaly";
      }
    }
  }
  checks.push(...notes);

  // Moving the coin from the buy exchange to the sell exchange.
  let transfersOk = true, transfersKnown = true;
  const need = [
    [input.buyTransfer?.withdrawal, `Withdrawals of ${coin} from ${buy.venue}`],
    [input.sellTransfer?.deposit, `Deposits of ${coin} to ${sell.venue}`],
  ] as const;
  for (const [open, what] of need) {
    if (open === false) { checks.push({ level: "blocked", text: `${what} are disabled.` }); transfersOk = false; }
    else if (open === true) checks.push({ level: "ok", text: `${what} are open.` });
    else { checks.push({ level: "unknown", text: `${what}: status not published without an account.` }); transfersKnown = false; }
  }
  if (!transfersOk && (!kind || kind === "price-anomaly")) kind = "transfers-blocked";
  const names = [input.buyTransfer?.name && `${buy.venue} calls it “${input.buyTransfer.name}”`, input.sellTransfer?.name && `${sell.venue} calls it “${input.sellTransfer.name}”`].filter(Boolean);
  if (names.length === 2 && input.buyTransfer!.name !== input.sellTransfer!.name) checks.push({ level: "unknown", text: `${names.join("; ")}.` });

  // How long the gap has been there (not tracked for routes checked because they were paper-traded).
  if (input.ageMs !== null) {
    if (input.ageMs > 30 * 60_000) checks.push({ level: "warning", text: `The gap has lasted ${minutes(input.ageMs)}. Real arbitrage gaps close within minutes, so something is likely stopping traders.` });
    else checks.push({ level: "ok", text: `The gap appeared ${minutes(input.ageMs)} ago.` });
  }

  kind ||= tokenOk && transfersOk && transfersKnown ? "no-barrier-found" : "unverified";
  const summary = {
    "different-tokens": "Not a real gap: two different tokens share this symbol",
    "transfers-blocked": "Can't be captured: transfers are closed",
    "price-anomaly": "Not trustworthy: one exchange's price is an outlier",
    "no-barrier-found": "No barrier found: could be genuine, but check withdrawal times and fees first",
    unverified: "Couldn't fully verify: see the checks below",
  }[kind];
  return { kind, summary, checks, checkedAt: input.now };
}
