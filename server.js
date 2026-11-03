// Funding Spreads: pulls funding rates from Sodex, Variational, TxFlow and Lighter,
// normalizes them to an hourly rate and serves them to public/index.html.
// No dependencies. Needs Node 18+ (built-in fetch).
//
//   node server.js            -> http://localhost:3000
//   MOCK=1 node server.js     -> fake data in each exchange's documented shape (for testing the page)

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const MOCK = process.env.MOCK === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- venue endpoints ----------
const SODEX_BASE = process.env.SODEX_BASE || "https://mainnet-gw.sodex.dev";
// Sodex's perps market-list path could not be confirmed from public docs, so several are tried in order.
// Set SODEX_PATH to pin the right one once you know it.
const SODEX_PATHS = process.env.SODEX_PATH
  ? [process.env.SODEX_PATH]
  : ["/api/v1/perps/markets/symbols", "/api/v1/perps/markets", "/api/v1/perps/symbols"];
const SODEX_INTERVAL_H = Number(process.env.SODEX_INTERVAL_H || 1);

const VARIATIONAL_URL =
  "https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/v2/stats";
const LIGHTER_URL = "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates";
const TXFLOW_URL = process.env.TXFLOW_URL || "https://rpc.txflow.com/info";
const TXFLOW_VERSION = process.env.TXFLOW_API_VERSION || "2026-08-16";

// ---------- helpers ----------
async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { accept: "application/json", "user-agent": "funding-spreads/1.0", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}${new URL(url).pathname}`);
  return res.json();
}
const num = (x) => {
  const n = typeof x === "string" ? parseFloat(x) : x;
  return Number.isFinite(n) ? n : null;
};
const baseSymbol = (s) =>
  String(s).toUpperCase().replace(/[-_/](PERP|USDC|USDT|USD)$/i, "").replace(/[-_/](PERP|USDC|USDT|USD)$/i, "");

// Each adapter returns { SYMBOL: { hourly, mark, intervalH } }.
// hourly = funding rate per hour as a fraction (0.0001 = 0.01%). Positive means longs pay shorts.

async function fetchSodex() {
  if (MOCK) return mock.sodex();
  let lastErr;
  for (const p of SODEX_PATHS) {
    try {
      const j = await getJSON(SODEX_BASE + p);
      const arr = Array.isArray(j) ? j : j.data;
      if (!Array.isArray(arr) || !arr.length) throw new Error(`empty list at ${p}`);
      const out = {};
      for (const it of arr) {
        const name = it.name || it.symbol || it.displayName;
        const r = num(it.fundingRate);
        if (!name || r === null) continue;
        out[baseSymbol(name)] = { hourly: r / SODEX_INTERVAL_H, mark: num(it.markPrice), intervalH: SODEX_INTERVAL_H };
      }
      if (!Object.keys(out).length) throw new Error(`no funding fields at ${p}`);
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchVariational() {
  if (MOCK) return mock.variational();
  const j = await getJSON(VARIATIONAL_URL);
  const out = {};
  for (const l of j.listings || []) {
    if (l.contract_type !== "perpetual" || !l.funding || !l.funding.last) continue;
    const per = num(l.funding.last.interval_rate);
    const secs = num(l.funding.interval_seconds);
    if (per === null || !secs) continue;
    const intervalH = secs / 3600;
    out[baseSymbol(l.ticker)] = { hourly: per / intervalH, mark: num(l.mark_price), intervalH };
  }
  return out;
}

async function fetchLighter() {
  if (MOCK) return mock.lighter();
  const j = await getJSON(LIGHTER_URL);
  const out = {};
  for (const r of j.funding_rates || []) {
    if (r.exchange !== "lighter") continue;
    const v = num(r.rate);
    if (v === null) continue;
    out[baseSymbol(r.symbol)] = { hourly: v, mark: null, intervalH: 1 };
  }
  return out;
}

// TxFlow has no bulk funding call: list instruments with perpMeta, then marketTicker once per instrument.
let txMeta = { at: 0, list: [] };
async function txPost(body) {
  const j = await getJSON(TXFLOW_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-version": TXFLOW_VERSION },
    body: JSON.stringify(body),
  });
  if (j.success === false) throw new Error(`TxFlow code ${j.code}: ${j.message || "error"}`);
  return j.data;
}
async function fetchTxflow(onPartial) {
  if (MOCK) return mock.txflow();
  if (Date.now() - txMeta.at > 10 * 60 * 1000 || !txMeta.list.length) {
    const meta = await txPost({ type: "perpMeta", includeDelisted: false });
    txMeta = {
      at: Date.now(),
      list: (meta.universe || []).filter((u) => !u.delisted && !u.haltTrading).map((u) => ({ id: u.index, base: u.baseCurrency })),
    };
  }
  const out = {};
  let failures = 0;
  for (const m of txMeta.list) {
    try {
      const t = await txPost({ type: "marketTicker", instrumentId: m.id });
      const pct = num(t.fundingRate);
      const ms = num(t.settlementIntervalMs);
      if (pct !== null && ms) {
        const intervalH = ms / 3600000;
        out[baseSymbol(m.base)] = { hourly: pct / 100 / intervalH, mark: num(t.markPx), intervalH };
        if (onPartial && Object.keys(out).length % 20 === 0) onPartial({ ...out });
      }
    } catch (e) {
      if (++failures > 10 && !Object.keys(out).length) throw e;
    }
    await sleep(125); // stays under TxFlow's documented 10 req/s limit
  }
  if (!Object.keys(out).length) throw new Error("no markets returned");
  return out;
}

// ---------- refresh loops ----------
const state = {};
for (const k of ["sodex", "variational", "txflow", "lighter"]) state[k] = { ok: false, error: "loading", updated: 0, rows: {} };

function loop(name, fn, everyMs) {
  const run = async () => {
    try {
      const rows = await fn((partial) => {
        state[name].rows = partial;
        state[name].updated = Date.now();
        state[name].ok = true;
        state[name].error = null;
      });
      state[name] = { ok: true, error: null, updated: Date.now(), rows };
    } catch (e) {
      state[name].ok = Object.keys(state[name].rows).length > 0 && Date.now() - state[name].updated < 120000;
      state[name].error = String(e.message || e);
    }
    setTimeout(run, everyMs);
  };
  run();
}
function snapshot() {
  const venues = {};
  const syms = new Set();
  for (const [k, v] of Object.entries(state)) {
    venues[k] = { ok: v.ok, error: v.error, updated: v.updated, count: Object.keys(v.rows).length };
    Object.keys(v.rows).forEach((s) => syms.add(s));
  }
  const symbols = [...syms].map((sym) => {
    const o = { sym };
    for (const [k, v] of Object.entries(state)) if (v.rows[sym]) o[k] = v.rows[sym];
    return o;
  });
  return { now: Date.now(), venues, symbols };
}

// ---------- mock data (shapes copied from each exchange's docs) ----------
const mock = {
  sodex: async () => ({ BTC: { hourly: 0.000012, mark: 81900, intervalH: 1 }, ETH: { hourly: -0.000004, mark: 2250, intervalH: 1 }, XAUT: { hourly: 0.00005, mark: 4166, intervalH: 1 } }),
  variational: async () => ({ BTC: { hourly: 0.00008246 / 8, mark: 81949, intervalH: 8 }, ETH: { hourly: 0.0001 / 8, mark: 2251, intervalH: 8 }, SOL: { hourly: -0.00006 / 4, mark: 160, intervalH: 4 } }),
  txflow: async () => ({ BTC: { hourly: 0.00125 / 100, mark: 83388, intervalH: 1 }, ETH: { hourly: 0.0002 / 100, mark: 2252, intervalH: 1 }, SOL: { hourly: 0.002 / 100, mark: 160.2, intervalH: 1 } }),
  lighter: async () => ({ BTC: { hourly: 0.000013, mark: null, intervalH: 1 }, ETH: { hourly: -0.00002, mark: null, intervalH: 1 }, SOL: { hourly: 0.00001, mark: null, intervalH: 1 } }),
};

module.exports = { fetchSodex, fetchVariational, fetchLighter, fetchTxflow };

// Started after everything above is defined (skipped when collect.js imports this file).
if (require.main === module) {
  loop("sodex", fetchSodex, 15000);
  loop("variational", fetchVariational, 15000);
  loop("lighter", fetchLighter, 15000);
  loop("txflow", fetchTxflow, 5000);
}

// ---------- http ----------
const indexPath = path.join(__dirname, "public", "index.html");
if (require.main === module) http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/funding") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(snapshot()));
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return fs.createReadStream(indexPath).pipe(res);
    }
    res.writeHead(404).end("not found");
  })
  .listen(PORT, () => console.log(`Funding Spreads on http://localhost:${PORT}${MOCK ? " (MOCK data)" : ""}`));
