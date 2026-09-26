# Arbiter Live — paper crypto arbitrage scanner

Source snapshot: baae3bb558c17d0e40067c1f9aec94671d541083

This is the browser-based paper trading simulator, with 40 selectable USD assets and eight venues. Seven venues provide direct USD spot books; Crypto.com USD-bundle routes are marked indicative and excluded from paper trades. The site calculates net route estimates from fresh best-level quotes, estimated taker fees, a price movement buffer, and available quote size. No real orders are placed.

## Run locally

1. Install Node.js 22.13 or later and pnpm 11.25.0.
2. In this folder run `pnpm install --frozen-lockfile`.
3. Run `pnpm dev` and open `http://localhost:5173`.

`pnpm build` compiles the project. The app needs internet access to reach exchange feeds and public fee schedule pages. Availability depends on the exchanges, their regional access and rate limits. When a fee schedule cannot be fetched, the app labels the rate as an editable estimate. Public entry-tier fees are not personalized account fees; actual rates require each exchange's authorized account data. Paper sessions and preferences stay in that browser's local storage while scanning runs only with the page open.

## Windows paper engine (runs unattended)

The web page only scans while it is open and visible. `ArbiterPaper.exe` runs the same scanner and paper bot in the background, so it keeps going while the window is minimized or the PC is locked. It still places no real orders.

**Get it:** download `ArbiterPaper.exe` from the repository's *Releases* page (`paper-engine-latest`), or build it with `pnpm build:exe` (output in `release/`).

**Run it:**

1. Put `ArbiterPaper.exe` in its own folder, for example `Documents\Arbiter`, and double-click it. Windows SmartScreen may warn that the app is unrecognized because it is not code-signed; choose *More info → Run anyway*.
2. A console window opens and the dashboard opens in your browser at `http://127.0.0.1:4173`. Keep the console window open; closing it stops the engine (progress is saved).
3. While it runs, it asks Windows not to sleep. The screen can still turn off. Leave the PC plugged in.
4. Optional: tick *Start automatically when I sign in to Windows* on the Settings tab. It adds a shortcut to your Startup folder that opens the engine minimized, so it comes back after a Windows Update restart (Windows signs you back in after an update restart if *Use my sign-in info to automatically finish setting up* is on, under Settings → Accounts → Sign-in options).

**Unattended running.** If an exchange connection goes quiet for 90 seconds (for example after the Wi-Fi drops), it is replaced with a new one; in the meantime, prices are polled. Clicking inside the console window no longer pauses the engine (Windows' QuickEdit selection is turned off for that window). The hour in progress is saved every 10 seconds along with the session, so a restart doesn't lose it.

**What it scans.** On start (and every 12 hours) it reads each exchange's public listings and picks the 150 most-traded coins listed on at least two of Coinbase, Kraken, Gemini, Bitstamp, CEX.IO, Binance.US, bitFlyer and OKX US: about 850 order books priced in USD, USDT, USDC and, for triangles, BTC and ETH. CEX.IO is limited to its 80 highest-volume books because its public API allows about 100 requests a minute. If the exchanges can't be reached it uses the last saved listings.

**Routes it evaluates:**

- *Cross-exchange*: buy a coin on one exchange and sell it on another. Either side can be priced in USD, USDT or USDC. Stablecoin legs are valued at that exchange's live stablecoin/USD price, including the cost of converting back to USD (`conversionFee`, default 0.2%, Kraken's entry rate; cheaper where the exchange's own fee is lower).
- *Triangle*: three trades on one exchange that start and end in USD, for example USD → BTC → ETH → USD or USD → USDT → SOL → USD. No money needs to move between exchanges, but it pays three taker fees.

Every estimate includes each exchange's entry-tier taker fee, conversion costs and the price-movement buffer on every leg, sized to the top of each order book. A paper trade never fills twice against the same unchanged quote, because a real fill would have used that liquidity up. The *Status* column under **Current best routes** says why each route was or wasn't traded: below your minimum profit, loses money after costs, quote already used, traded in the last minute, or next in line (one trade per scan).

**Reaction speed.** Each time a book's best price or size changes, the engine re-checks only the routes that use that book (a route index is built when markets load) and paper-trades at once if one qualifies; the dashboard shows the measured time from price change to decision, typically well under a millisecond. Every route is also rescanned twice a second for the dashboard and for stablecoin rate changes. The realistic replay uses the measured decision time plus 5 ms to prepare orders. *React to each price change instantly* on the Settings tab turns the per-change checks off, leaving only the half-second scan, so the two can be compared on the Accuracy tab.

**Network latency.** Each exchange gets a connection that is kept open and used every 15 seconds, so the Latency column shows true round trips (median and the time 95% of requests beat), not reconnections: measured from a cloud server, a kept-open connection answered Gemini in about 50 ms, a reopened one in over 300 ms. The replay uses these figures, and the same connections are meant for orders once trading is enabled. Coinbase prices come from its `level2_batch` feed, which measured as the fastest public Coinbase book: side by side on the same books, the unbatched Advanced Trade feed showed a new best price about 50 ms later and the ticker channel about 110 ms later.

**Order groundwork (nothing is sent).** For when trading is enabled, the engine can already build the orders a trade's legs would be sent as, without sending them: immediate-or-cancel limit orders over Kraken's authenticated WebSocket (`add_order`) and Coinbase Advanced Trade (`sor_limit_ioc`), signed as each exchange requires (Kraken's signature is checked against Kraken's published example). Legs are sent together rather than one after another. Coinbase's and Kraken's published order rules are read from their listings, and a paper trade whose leg one of them would reject (below the minimum size or value, or cut by more than 1% by lot rounding) isn't taken; the reason shows in the route's Status. Building and signing an order is timed at start (about 0.1 ms) and added to the replay. There's no code that sends an order: that needs trade-enabled API keys and a separate decision to go live.

**Dashboard tabs:**

- *Overview* — balances, current routes with their status, suspect gaps with their verdicts, and each exchange's feed and measured latency.
- *Paper trades* — the reality check for every trade, the trade log and the hourly summary.
- *Accuracy* — how far the paper numbers are from reality (below), with charts by hour.
- *Funding* — the spot vs futures carry (below): Coinbase's US perpetual futures, their funding rates, and a separate paper account holding carry positions.
- *Settings* — every option in a form. Budget, minimum profit, fees, buffer and max gap apply on the next scan; coin and exchange changes reload the markets; start with Windows applies immediately; port, browser and keep-awake apply on the next start; starting balance applies from the next session reset. *Load defaults* fills in the defaults for you to review before saving.

**Realistic results (shadow mode).** Paper trades assume every quote is still there when the order arrives. Shadow mode replays each paper trade as real immediate-or-cancel orders would have landed: each exchange's round trip is measured continuously from your PC, and each leg is checked against that exchange's order book one round trip after the decision. A leg fills only if its price (or better) is still on the book, up to the size shown. The trade is marked *filled*, *one side only* (the other side is sold or bought back at the next prices, fees included) or *missed*. Realistic P&L is what those replays would have made.

**Accuracy tab:**

- *Wouldn't have worked* — share of paper trades that filled on one side only or not at all.
- *Avg estimate error* — average of realistic minus paper profit per trade, with the typical size of the miss.
- *Profit turned loss* — share of trades predicted to make money that would have lost money.
- *Paper profit kept* — realistic profit as a share of paper profit.
- *Suspects that look real* — of the suspect gaps that could be checked, the share where no barrier was found: how often the max-gap rule may be too cautious.
- *Traded routes with a barrier* — every cross-exchange route that gets paper-traded goes through the same check. This is the share where one was found anyway: how often the rule isn't cautious enough. With money already on both exchanges one trade still goes through, but closed transfers or a different token stop you rebalancing, so the gap can't be repeated.

**Suspect gaps.** Routes whose raw gap is above `maxGap` (default 2%) are never traded. Each one is checked automatically, one at a time:

- *Different tokens* — CoinGecko's mapping of each exchange's ticker (or, where CoinGecko doesn't track it, the name the exchange publishes) shows two different coins sharing a symbol, for example Litentry and Lighter, both "LIT".
- *Transfers closed* — the buy exchange has withdrawals off or the sell exchange has deposits off (Kraken, Coinbase, Bitstamp and CEX.IO publish this; Gemini, Binance.US, bitFlyer and OKX need an account to tell).
- *Price outlier* — CoinGecko flags one exchange's price as an outlier against the rest of the market.
- *No barrier found* — none of the above. It could be genuine, but check withdrawal fees and times before trusting it.

When a check finds different tokens, closed transfers or an outlier price, that coin between those two exchanges is blocked from paper trading at any gap, not only above `maxGap`, until a later check finds no barrier. The blocked pairs are listed on the Accuracy tab.

Click a suspect for the individual checks, or *Check now* to re-run them. CoinGecko's free API allows only a few requests a minute, so the first checks take a few minutes after start.

**Funding carry (spot vs futures).** Buy a coin and short the same amount of its perpetual future: price moves cancel out, and while the future trades above spot, the short collects the funding that longs pay. The futures are Coinbase Financial Markets' US perpetual-style contracts (CFTC-regulated, open to US residents), read from Coinbase's public API; funding accrues every hour at roughly the hour's average futures premium over spot divided by 24.

- Each hourly settlement is recorded in `funding.csv` and paid to open positions (contracts × contract size × index price × rate). Hours that settle while the engine is stopped can't be recovered from public data, so they aren't counted; the log notes them.
- The coin is bought on whichever followed exchange is cheapest after its fee, and sold there on exit. Positions are whole contracts (for example 0.01 BTC or 0.1 ETH each), so each needs its coins plus collateral: 100% of the short by default, which means no leverage and, for BTC, room for a 50%+ rise before a margin call. Coins whose overnight margin needs more than 80% of the collateral setting are skipped.
- A position opens once a contract has 6 hours of recorded funding and its expected return clears your minimum. Expected funding is the lower of the last 24 hours' average and the latest hour (only settled rates are used: Coinbase computes funding from its own futures and spot marks, which public prices don't reproduce); the return is after both legs' fees and spreads, in and out, spread over your expected holding time, and is measured on the capital tied up (coins plus collateral).
- It closes when the last 6 hours of funding average below your exit rate, or before the futures price can rise within 10% of a margin call. Closing sells the coins at the bid and buys the short back at the ask, fees included.
- Dated monthly futures are shown for comparison: shorting one and holding the coin to expiry locks in the gap. They aren't paper-traded yet.
- Settings (Funding carry section): capital, positions at once, collateral %, futures fee (Coinbase lists 0.03% taker plus exchange fees; the default is 0.05%), minimum and exit returns, and expected holding time.

**Results** are saved in an `arbiter-data` folder next to the exe:

- `trades.csv` — every paper trade, with its route, size, costs and legs
- `shadow.csv` — every replay: paper and realistic profit, outcome, how much filled, latency and anything unwound
- `verdicts.csv` — every suspect and traded-route check
- `carry.csv` — every carry open, hourly funding payment and close; `carry.json` holds the carry account
- `funding.csv` — every hourly funding rate seen for each US perpetual (kept across session resets)
- `hourly.csv` — one summary row per hour: trades, paper and realistic P&L, estimate error, replay outcomes, best cross-exchange and triangle net, suspect gaps
- `session.json` — balances and counters
- `listings.json` — the last exchange listings
- `config.json` — the settings from the Settings tab. It can also be edited by hand while the engine is stopped.

*Reset session* on the dashboard archives these logs (they are renamed, not deleted) and starts the balances and accuracy figures over.

Scanning uses roughly half of one CPU core and 250 MB of memory.

For development, `pnpm engine` bundles and runs the engine with Node without packaging it.

This archive contains source code and package definitions. It excludes dependencies, generated builds, local session data, tokens and the deployed Site's project identifier. The included `.openai/hosting.json` has only empty optional binding declarations for a fresh deployment.
