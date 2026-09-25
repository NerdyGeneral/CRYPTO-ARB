# Arbiter Live — paper crypto arbitrage scanner

Source snapshot: baae3bb558c17d0e40067c1f9aec94671d541083

This is the browser-based paper trading simulator, with 40 selectable USD assets and eight venues. Seven venues provide direct USD spot books; Crypto.com USD-bundle routes are marked indicative and excluded from paper trades. The site calculates net route estimates from fresh best-level quotes, estimated taker fees, a price movement buffer, and available quote size. No real orders are placed.

## Run locally

1. Install Node.js 22.13 or later and pnpm 11.25.0.
2. In this folder run `pnpm install --frozen-lockfile`.
3. Run `pnpm dev` and open `http://localhost:5173`.

`pnpm build` compiles the project. The app needs internet access to reach exchange feeds and public fee schedule pages. Availability depends on the exchanges, their regional access and rate limits. When a fee schedule cannot be fetched, the app labels the rate as an editable estimate. Public entry-tier fees are not personalized account fees; actual rates require each exchange's authorized account data. Paper sessions and preferences stay in that browser's local storage while scanning runs only with the page open.

This archive contains source code and package definitions. It excludes dependencies, generated builds, local session data, tokens and the deployed Site's project identifier. The included `.openai/hosting.json` has only empty optional binding declarations for a fresh deployment.
