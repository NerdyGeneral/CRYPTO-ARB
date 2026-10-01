# Arbiter Live — paper crypto arbitrage scanner

This repository contains a browser scanner and an unattended Node/Windows paper engine. They read public market data. **Neither places real exchange orders.** Quote estimates, simulated execution results and actual exchange profit are different things; this application reports the first two.

## Run locally

Use Node.js 22.13 or later and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm engine
```

The engine dashboard opens at `http://127.0.0.1:4173`. Keep the engine process running; the dashboard can be closed without stopping the engine. For the browser application, run `pnpm dev` and open `http://localhost:5173`. `pnpm build` compiles that application. The browser page remains a quote-only estimator: its local-storage results do not use the standalone engine's funded simulation or authoritative audit journal. Browser scanning requires an active page. The funded execution simulation, per-venue inventory and audit corrections described below apply to the standalone engine and its local dashboard.

To build the Windows executable, run `pnpm build:exe`; output is written to `release/`. Existing published binaries may predate changes in this checkout. The executable is not code-signed. Put it in its own folder and keep its console process running. Windows keep-awake and optional sign-in startup settings are available in the dashboard. A minimized window does not stop the engine; shutdown, sleep, lost connectivity and process termination still interrupt it.

## Markets and reaction speed

The engine discovers public listings from selected exchanges at startup and periodically refreshes them. Its default universe selects 150 high-volume coins listed on at least two venues, with explicit include/exclude settings. Coverage and availability change with listings, API responses, regional access and rate limits. Cached listings are identified on the dashboard. Crypto.com bundle estimates remain indicative and are excluded from paper execution.

Cross-exchange routes compare buy and sell books, including USD, USDT and USDC markets where usable conversion books exist. Triangles start and end in USD on one exchange. The scanner uses bid/ask prices and displayed size, configured fees, a movement buffer, freshness checks and applicable order-size rules. A profitable quote is only a candidate: inventory, reservations, book validity, minimum sizes, conversion liquidity and audit storage can block it.

Price events re-evaluate affected routes through a route index; a periodic full scan supplies broader checks. The dashboard's decision timing measures local processing after a quote reaches the engine. It does not include every delay between the exchange producing a quote and an exchange accepting an order.

**Latency is an assumption, not an execution measurement.** Public API probes supply a measured round-trip distribution. The execution simulation uses the public-probe p95 plus order-preparation time. Public probes are not authenticated order acknowledgements and do not establish achievable fill latency, queue priority or future network conditions. No benchmark here guarantees production trading speed.

## Paper inventory and execution

A new spot account starts with USD distributed across the selected venues. Coins and stablecoins are not fabricated. A cross-exchange buy needs available quote currency at its buy venue; its sale needs the coin already held at the selling venue. Pending reservations prevent concurrent routes from spending the same assets. Assets do not automatically transfer between venues.

Use **Overview → Paper inventory** to prepare holdings:

1. Select a fresh direct USD market and choose buy or sell.
2. Enter a quantity in base-coin units, not a USD budget.
3. Submit a simulated inventory trade. It uses existing venue balances, current book depth, configured fees and order rules, and records the result in the audit log.

The panel shows held, reserved and available amounts separately. Inventory preparation can reduce portfolio equity because of fees and spreads. A route can remain visible while blocked for insufficient inventory; that is expected behavior, not permission to invent balances.

Cross-exchange legs are simulated concurrently with independent funding. **Triangle legs are sequential:** each leg uses only assets produced by the previous leg after fees. The next leg is rechecked against its book and order rules. Incomplete execution leaves its actual paper inventory and unresolved exposure visible.

IOC simulations only fill at their limit or better, up to evidenced size. Unwind and stablecoin conversion steps require their own usable prices and depth. Missing, stale or insufficient exit evidence must not turn an unknown result into a zero-dollar loss or a completed profit. Fee currency is recorded; configured fee assumptions are not personalized exchange commission statements.

## Reading the results

- **Paper portfolio equity/P&L:** marks current holdings using fresh local USD bids less assumed taker fees. This is a valuation, not a claim that all holdings can liquidate at the displayed price. Missing fresh marks make aggregate equity/P&L unavailable; the dashboard lists the missing marks. Inventory preparation costs are included through holdings.
- **Quoted estimate:** the opportunity calculation before simulated execution. It is not money credited by an exchange.
- **Simulated execution P&L:** the result of the modeled fills and exits. When any result is unresolved, the aggregate is unavailable. The completed-result subtotal is shown separately and must not be read as total account profit.
- **Accuracy metrics:** compare quote estimates with completed simulations. Unresolved results are counted separately and excluded from profit/error calculations that require a known result. A simulated fill is not proof that a real order would have filled.
- **Legacy estimates:** older balances and counters without complete evidence are kept separately. Migration does not retroactively verify them.

The route-status column explains common blocks: missing venue inventory, order minimums, stale/invalid quotes, previously consumed liquidity, insufficient depth, estimated costs, suspect gaps, or unavailable audit storage. Expand a suspect row to see token/transfer/price checks. “No barrier found” only describes those checks; it does not validate a profitable trade.

## Funding carry

The Funding tab uses a separate paper account to model holding spot while shorting Coinbase US perpetual-style futures. Basis changes, fees, funding and margin can still produce losses; the hedge does not guarantee a return.

Entries use whole contracts, are capped by cash and both legs' displayed size, and reserve capital before the next entry. The model uses the stricter published short margin with additional headroom. Forecast returns use observed funding history and modeled round-trip costs; they are estimates, not promised yields.

**Public funding rates are insufficient to confirm funding cash flows.** The public product response used here supplies a current index price, not the applicable settlement-time futures mark required to calculate a payment. The engine therefore records the rate but leaves the payment unresolved. It does not multiply the latest index by an old rate and credit that estimate as confirmed funding. Missed intervals, including intervals crossed before closure, remain unresolved. Market-closure intervals may also need reconciliation rather than assumed payments.

Funding remains excluded from confirmed totals until appropriate settlement evidence exists. This build has no account funding-statement importer. Legacy estimated funding is separated from confirmed accounting; potentially truncated old histories are marked incomplete.

Carry exits require sufficient size on both legs; otherwise the position remains open with an unresolved exit status. When books become stale, the last-known valuation is preserved with its timestamp and an incomplete flag. If no prior mark exists, equity is unavailable. The application never resets an unmarked loss to entry cost. Annualized account returns are withheld when valuation or funding is incomplete.

Futures books are polled with bounded concurrency and spaced requests, prioritizing open positions. Risk checks use the current clock and continue while discovery requests are pending. These checks are a paper margin model, not an exchange liquidation engine. Dated-futures comparisons remain indicative and are not paper-traded.

## Audit and verification

Data is saved in `arbiter-data` beside the executable (the dashboard shows its exact path):

- `audit.jsonl` is the authoritative spot simulation journal: intents, reservations/checkpoints, fill evidence, results and inventory operations. Replay uses stable transaction IDs. Uncommitted paper operations are cancelled after interruption, with recovery recorded; no fills are inferred. Completed simulations with unresolved exposure retain that exposure.
- `session.json` is a checkpoint/cache of the spot account, balances, reservations and counters.
- `trades.csv`, `shadow.csv` and `hourly.csv` are human-readable summaries. They are not the authoritative transaction ledger or proof of exchange execution. Blank/unknown result fields must not be converted to zero.
- `carry.json` holds the separate carry account, last-known marks and cumulative accounting. `carry.csv` records opens, unresolved funding observations and closes.
- `funding.csv` records public funding-rate observations and the current index, not confirmed funding payment amounts.
- `verdicts.csv`, `listings.json` and `config.json` contain public verification results, discovery cache and settings.

Writes are ordered, and audit failures pause new spot execution with a visible error. Reset archives prior session data and creates new paper balances. Preserve the data folder when investigating results. Stopping the engine normally allows pending work and queued writes to drain; a process or machine failure can still leave unresolved work that must be recovered from the journal.

**Actual profit/loss requires exchange evidence:** authenticated order/fill records, fill IDs, actual quantities and prices, commission amounts and currencies, funding cash entries, transfers and venue balance reconciliation. This build does not submit orders or import an exchange execution history. Existing paper CSVs alone cannot establish whether historical trades would have filled or whether actual profit was made. Public fee schedules and user-entered rates are estimates until matched to an account's actual charges.

For development, run `pnpm test` for the regression suite and `pnpm engine` to bundle/run without Windows packaging. Keep API secrets and local account data out of source control.
