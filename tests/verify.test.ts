import assert from "node:assert/strict";
import { test } from "node:test";
import { judge, tokenMap, transferStatus, type Fetcher, type TokenMap } from "../lib/verify";

// Responses shaped like the live APIs.
const responses: Record<string, unknown> = {
  "https://api.kraken.com/0/public/Assets?asset=LIT": { error: [], result: { LIT: { altname: "LIT", status: "enabled" } } },
  "https://api.kraken.com/0/public/Assets?asset=EGLD": { error: [], result: { EGLD: { altname: "EGLD", status: "deposit_only" } } },
  "https://www.bitstamp.net/api/v2/currencies/": [
    { currency: "LIT", name: "Lighter", deposit: "Enabled", withdrawal: "Enabled" },
    { currency: "EGLD", name: "MultiversX", deposit: "Disabled", withdrawal: "Enabled" },
  ],
  "https://trade.cex.io/api/spot/rest-public/get_currencies_info": { ok: "ok", data: [{ currency: "FET", walletDeposit: true, walletWithdrawal: false }] },
  "https://api.coingecko.com/api/v3/search?query=LIT": { coins: [
    { id: "litentry", name: "Litentry", symbol: "LIT", market_cap_rank: 1587 },
    { id: "lighter", name: "Lighter", symbol: "LIT", market_cap_rank: 73 },
    { id: "litecoin-wrapped", name: "Other", symbol: "WLIT", market_cap_rank: 5 },
  ] },
};
const tickers = (base: string, list: [string, string, boolean][]) => ({ tickers: list.map(([exchange, target, anomaly]) => ({ base, target, is_anomaly: anomaly, is_stale: false, market: { identifier: exchange } })) });
responses["https://api.coingecko.com/api/v3/coins/lighter/tickers?exchange_ids=gdax,kraken,gemini,bitstamp,cex,binance_us,bitflyer,crypto_com"] = tickers("LIT", [["bitstamp", "USD", false]]);
responses["https://api.coingecko.com/api/v3/coins/litentry/tickers?exchange_ids=gdax,kraken,gemini,bitstamp,cex,binance_us,bitflyer,crypto_com"] = tickers("LIT", [["kraken", "USD", false], ["kraken", "EUR", false]]);
const get: Fetcher = async (url) => { if (!(url in responses)) throw new Error(`unexpected ${url}`); return responses[url]; };
const now = 10_000_000;

test("reads public transfer status from Kraken, Bitstamp and CEX.IO", async () => {
  assert.deepEqual(await transferStatus("Kraken", "EGLD", get), { deposit: true, withdrawal: false });
  assert.deepEqual(await transferStatus("Bitstamp", "EGLD", get), { deposit: false, withdrawal: true, name: "MultiversX" });
  assert.deepEqual(await transferStatus("CEX.IO", "FET", get), { deposit: true, withdrawal: false });
  assert.equal(await transferStatus("Gemini", "FET", get), null);
});

test("LIT on Kraken and Bitstamp are different tokens", async () => {
  const tokens = await tokenMap("LIT", get);
  assert.deepEqual(tokens.candidates.map((c) => c.id), ["lighter", "litentry"]);
  const verdict = judge({ coin: "LIT", buy: { venue: "Kraken", quote: "USD" }, sell: { venue: "Bitstamp", quote: "USD" }, tokens,
    buyTransfer: await transferStatus("Kraken", "LIT", get), sellTransfer: await transferStatus("Bitstamp", "LIT", get), ageMs: 3 * 3_600_000, now });
  assert.equal(verdict.kind, "different-tokens");
  assert.match(verdict.checks[0].text, /Kraken's LIT is Litentry, Bitstamp's LIT is Lighter/);
});

test("an exchange CoinGecko doesn't track is identified by the name it publishes", async () => {
  // CoinGecko lists Lighter on Coinbase and Kraken under the ticker LIGHTER, and not on Bitstamp at all.
  const tokens: TokenMap = {
    candidates: [{ id: "lighter", name: "Lighter" }, { id: "litentry", name: "Litentry" }],
    byExchange: { kraken: [{ id: "litentry", name: "Litentry", anomaly: false, stale: false, target: "USD" }] },
  };
  const verdict = judge({ coin: "LIT", buy: { venue: "Kraken", quote: "USD" }, sell: { venue: "Bitstamp", quote: "USD" }, tokens,
    buyTransfer: await transferStatus("Kraken", "LIT", get), sellTransfer: await transferStatus("Bitstamp", "LIT", get), ageMs: 60_000, now });
  assert.equal(verdict.kind, "different-tokens");
  assert.ok(verdict.checks.some((c) => /Bitstamp calls it “Lighter”, taken as Lighter/.test(c.text)));
  assert.ok(verdict.checks.some((c) => /Kraken's LIT is Litentry, Bitstamp's LIT is Lighter/.test(c.text)));
});

const sameToken = (anomalyOn?: string): TokenMap => ({
  candidates: [{ id: "fetch-ai", name: "Artificial Superintelligence Alliance" }],
  byExchange: {
    kraken: [{ id: "fetch-ai", name: "ASI", anomaly: anomalyOn === "kraken", stale: false, target: "USD" }],
    gemini: [{ id: "fetch-ai", name: "ASI", anomaly: false, stale: false, target: "USD" }],
    bitstamp: [{ id: "fetch-ai", name: "ASI", anomaly: false, stale: false, target: "USD" }],
  },
});

test("closed deposits on the sell side block the route", () => {
  const verdict = judge({ coin: "EGLD", buy: { venue: "Kraken", quote: "USD" }, sell: { venue: "Bitstamp", quote: "USD" }, tokens: sameToken(),
    buyTransfer: { deposit: true, withdrawal: true }, sellTransfer: { deposit: false, withdrawal: true }, ageMs: 60_000, now });
  assert.equal(verdict.kind, "transfers-blocked");
  assert.ok(verdict.checks.some((c) => c.level === "blocked" && /Deposits of EGLD to Bitstamp are disabled/.test(c.text)));
});

test("a price CoinGecko flags as an outlier is not trusted", () => {
  const verdict = judge({ coin: "FET", buy: { venue: "Gemini", quote: "USD" }, sell: { venue: "Kraken", quote: "USD" }, tokens: sameToken("kraken"),
    buyTransfer: null, sellTransfer: { deposit: true, withdrawal: true }, ageMs: 5 * 3_600_000, now });
  assert.equal(verdict.kind, "price-anomaly");
  assert.ok(verdict.checks.some((c) => /Kraken's FET\/USD price as an outlier/.test(c.text)));
  assert.ok(verdict.checks.some((c) => c.level === "warning" && /lasted 5.0 h/.test(c.text)));
});

test("same token, open transfers and a fresh gap find no barrier", () => {
  const verdict = judge({ coin: "FET", buy: { venue: "Bitstamp", quote: "USD" }, sell: { venue: "Kraken", quote: "USD" }, tokens: sameToken(),
    buyTransfer: { deposit: true, withdrawal: true }, sellTransfer: { deposit: true, withdrawal: true }, ageMs: 5 * 60_000, now });
  assert.equal(verdict.kind, "no-barrier-found");
  assert.equal(judge({ coin: "FET", buy: { venue: "Gemini", quote: "USD" }, sell: { venue: "Kraken", quote: "USD" }, tokens: null,
    buyTransfer: null, sellTransfer: null, ageMs: 60_000, now }).kind, "unverified");
});
