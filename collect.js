// One-shot collector for static hosting: fetches all four venues once and writes public/data.json.
// Used by the GitHub Actions workflow. Run locally with: node collect.js  (MOCK=1 for fake data)
const fs = require("fs");
const path = require("path");
const v = require("./server.js");

const jobs = {
  sodex: () => v.fetchSodex(),
  variational: () => v.fetchVariational(),
  txflow: () => v.fetchTxflow(),
  lighter: () => v.fetchLighter(),
};

(async () => {
  const state = {};
  await Promise.all(
    Object.entries(jobs).map(async ([name, fn]) => {
      try {
        state[name] = { ok: true, error: null, updated: Date.now(), rows: await fn() };
      } catch (e) {
        state[name] = { ok: false, error: String(e.message || e), updated: 0, rows: {} };
      }
    })
  );
  const venues = {};
  const syms = new Set();
  for (const [k, s] of Object.entries(state)) {
    venues[k] = { ok: s.ok, error: s.error, updated: s.updated, count: Object.keys(s.rows).length };
    Object.keys(s.rows).forEach((x) => syms.add(x));
    console.log(`${k}: ${s.ok ? s.count || venues[k].count + " markets" : "FAILED " + s.error}`);
  }
  const symbols = [...syms].map((sym) => {
    const o = { sym };
    for (const [k, s] of Object.entries(state)) if (s.rows[sym]) o[k] = s.rows[sym];
    return o;
  });
  if (!Object.values(venues).some((x) => x.ok)) {
    console.error("All venues failed; keeping the previous data.json");
    process.exit(1);
  }
  fs.writeFileSync(path.join(__dirname, "public", "data.json"), JSON.stringify({ now: Date.now(), static: true, venues, symbols }));
  console.log("wrote public/data.json with", symbols.length, "symbols");
  process.exit(0);
})();
