# Funding Spreads

Live funding-rate comparison across Sodex, Variational, TxFlow and Lighter. For every symbol listed on two or more venues it shows the annualized rate on each, the best long and short venue, the spread, and days to break even on your round-trip cost.

## Free hosting on GitHub Pages (no server, no cost)

GitHub runs `collect.js` every 10 minutes, saves the rates to `public/data.json`, and publishes the page. You pay nothing and need no computer left on.

1. Create a free account at github.com and make a **new public repository** (free Pages need a public repo; nothing in here is secret).
2. Click **Add file > Upload files**, drag in the *contents* of this folder (including the hidden `.github` folder: unzip first, then drag everything, or use the GitHub Desktop app if hidden folders won't drag), and commit to the `main` branch.
3. Open **Settings > Pages**, and under **Source** choose **GitHub Actions**.
4. Open the **Actions** tab, pick **Update funding data and publish site**, and press **Run workflow**. After about a minute your site is live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.

The data is up to about 10 to 15 minutes old on this setup, since GitHub schedules runs loosely. The Sodex and Lighter notes under "Not verified" still apply: open the Actions run log to see each venue's result, and the status chips on the page show any error.

## Run on your own computer

```
node server.js          # Node 18+, no install step
# open http://localhost:3000
```

`MOCK=1 node server.js` serves fake data in each exchange's documented shape, to try the page without the network.

To put it online, deploy this folder to any Node host (Render, Railway, Fly, a VPS). It needs only `node server.js` and the `PORT` variable.

## Why a server

Browsers block most exchange APIs (CORS), and TxFlow needs about 240 per-market calls, so the server collects the data and the page reads one `/api/funding` endpoint.

## Sources and units

| Venue | Endpoint | Rate unit used |
|---|---|---|
| Variational | `GET /metadata/v2/stats` | `funding.last.interval_rate`, per `interval_seconds` |
| Lighter | `GET /api/v1/funding-rates` (rows where `exchange` is `lighter`) | `rate`, treated as per hour |
| TxFlow | `POST rpc.txflow.com/info`: `perpMeta`, then `marketTicker` per market | `fundingRate` in percent per `settlementIntervalMs` |
| Sodex | `mainnet-gw.sodex.dev` perps market list | `fundingRate`, treated as a fraction per hour |

Everything is converted to an hourly fraction, then annualized as hourly x 8760. Positive funding means longs pay shorts.

## Not verified

These were not testable from the build environment, so check them on first run. The status chips at the top of the page show each venue's state and any error text.

- **Sodex path.** The exact perps market-list path is not in public docs. The server tries `/api/v1/perps/markets/symbols`, `/api/v1/perps/markets` and `/api/v1/perps/symbols`. Pin the right one with `SODEX_PATH=/your/path`. Interval defaults to 1 hour (`SODEX_INTERVAL_H`).
- **Lighter unit.** Lighter's `funding-rates` feed is treated as an hourly rate. Compare one symbol against the Lighter app.
- **TxFlow API version.** The `x-api-version` header defaults to `2026-08-16`. Override with `TXFLOW_API_VERSION`. TxFlow's API is marked Beta.
- **TxFlow refresh.** A full sweep takes about 30 seconds because of its 10 requests/second limit, so TxFlow numbers update slower than the others.
