#!/usr/bin/env node
// STAGE-2 ONLY (betting-layer backtest). Downloads historical Polymarket NBA game markets and their pre-game price
// history so the BET-SELECTION rules can be evaluated after the fact. Never imported by the prediction engine.
// Output: $DATA_DIR/polymarket-history.json  { [slug]: { start, title, markets:[{type,q,line,outcomes,resolved,p:{t90,t30}}] } }
import fs from 'node:fs/promises';
const DIR = process.env.DATA_DIR || '/workspace/bt-data';
const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(u, tries = 5) { for (let i = 0; i < tries; i++) { try { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); if (r.status === 429) throw new Error('429'); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } catch (e) { if (i === tries - 1) throw e; await sleep(800 * 2 ** i); } } }
const outFile = `${DIR}/polymarket-history.json`;
const out = JSON.parse(await fs.readFile(outFile, 'utf8').catch(() => '{}'));
const from = Date.parse(process.argv[2] || '2025-10-20'), to = Date.parse(process.argv[3] || new Date().toISOString());
const events = [];
for (let t = from; t < to; t += 3 * 864e5) {
  const a = new Date(t).toISOString(), b = new Date(Math.min(to, t + 3 * 864e5)).toISOString();
  const page = await get(`${GAMMA}/events?series_id=10345&closed=true&limit=200&end_date_min=${a}&end_date_max=${b}`);
  for (const e of page) if (/^nba-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2}$/.test(e.slug) && !out[e.slug]) events.push(e);
}
console.log(`events to fetch: ${events.length}`);
let done = 0, i = 0;
async function work() {
  while (i < events.length) {
    const e = events[i++];
    const mk = (e.markets || []).filter(m => ['moneyline', 'spreads', 'totals'].includes(m.sportsMarketType) && m.clobTokenIds);
    const start = Date.parse((mk[0]?.gameStartTime || e.endDate).replace(' ', 'T').replace('+00', 'Z'));
    if (!Number.isFinite(start)) continue;
    const rec = { start: new Date(start).toISOString(), title: e.title, markets: [] };
    for (const m of mk) {
      const tok = JSON.parse(m.clobTokenIds)[0]; const s = Math.floor(start / 1000);
      let h = [];
      try { h = (await get(`${CLOB}/prices-history?market=${tok}&startTs=${s - 4 * 3600}&endTs=${s}&fidelity=5`)).history || []; } catch { }
      const at = (sec) => { let v = null; for (const x of h) if (x.t <= sec) v = x.p; return v; };
      rec.markets.push({ type: m.sportsMarketType, q: m.question, line: m.line ?? null, outcomes: JSON.parse(m.outcomes || '[]'), resolved: JSON.parse(m.outcomePrices || '[]').map(Number),
        p: { t150: at(s - 9000), t90: at(s - 5400), t30: at(s - 1800) }, n: h.length });
    }
    out[e.slug] = rec;
    if (++done % 50 === 0) { console.log(`${done}/${events.length}`); await fs.writeFile(outFile, JSON.stringify(out)); }
  }
}
await Promise.all(Array.from({ length: 6 }, work));
await fs.writeFile(outFile, JSON.stringify(out));
console.log('done', Object.keys(out).length);
