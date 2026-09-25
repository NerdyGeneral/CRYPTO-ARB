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

**Results** are saved in an `arbiter-data` folder next to the exe:

- `trades.csv` — every paper trade
- `hourly.csv` — one summary row per hour: scans, trades, P&L, best net and suspect gaps
- `session.json` — balance and counters
- `config.json` — settings: coins, exchanges, budget, minimum profit, fees, buffer, and `maxGap`. Restart after editing.

Routes whose raw gap is above `maxGap` (default 2%) are shown as suspect and never traded. Gaps that large almost always mean the two listings cannot be arbitraged, for example because transfers are paused or they are different tokens.

For development, `pnpm engine` bundles and runs the engine with Node without packaging it.

This archive contains source code and package definitions. It excludes dependencies, generated builds, local session data, tokens and the deployed Site's project identifier. The included `.openai/hosting.json` has only empty optional binding declarations for a fresh deployment.
