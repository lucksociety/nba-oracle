#!/usr/bin/env node
// STAGE 2 — runs only AFTER scripts/predict.mjs has frozen out/predictions.json.
// Verifies the SHA-256 of the frozen predictions, deep-freezes them in memory, then fetches Jupiter
// prediction-market prices and computes edges. Output: out/bets.json. Never writes to predictions.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fetchNbaEvents, matchEvent, evaluateGame, depthAtAsk, RULES, JUP_BASE } from '../js/markets-jupiter.js';

const ROOT = new URL('../', import.meta.url);
const body = await fs.readFile(new URL('out/predictions.json', ROOT), 'utf8');
const expected = (await fs.readFile(new URL('out/predictions.sha256', ROOT), 'utf8')).trim();
const sha = crypto.createHash('sha256').update(body).digest('hex');
if (sha !== expected) throw new Error(`Frozen predictions hash mismatch (${sha} != ${expected}) — refusing to compare`);
const deepFreeze = (o) => { Object.values(o).forEach(v => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
const pred = deepFreeze(JSON.parse(body));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const headers = process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {};
const gap = process.env.JUPITER_API_KEY ? 250 : 2100; // keyless limit 0.5 req/s
let last = 0;
async function fetchJSON(url) {
  for (let i = 0; i < 4; i++) {
    const wait = last + gap - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
    const r = await fetch(url, { headers });
    if (r.ok) return r.json();
    if (i === 3 || (r.status !== 429 && r.status < 500)) throw new Error(`${url} -> HTTP ${r.status}`);
    await sleep(3000 * (i + 1));
  }
}

const fetchedAt = new Date().toISOString();
let events = [], error = null;
try { events = await fetchNbaEvents(fetchJSON); } catch (e) { error = e.message; }
const games = [];
for (const g of pred.games) {
  const ev = error ? null : matchEvent(g, events);
  const r = evaluateGame(g, ev);
  if (error) r.noMarketReason = `Jupiter API error: ${error}`;
  r.started = g.status?.state !== 'pre';
  r.best = null;
  if (r.started) r.noBetReason = `Game ${g.status?.state === 'post' ? 'final' : 'in progress'} at prediction time — pregame model not valid for live markets`;
  else if (!ev) r.noBetReason = r.noMarketReason;
  else {
    const q = r.candidates.filter(c => c.qualifies);
    for (const c of q.slice(0, 3)) { // confirm executable depth at the quoted ask for the top candidates
      try { const book = await fetchJSON(`${JUP_BASE}/orderbook/${c.marketId}`); c.depth = depthAtAsk(book, c.ask); }
      catch (e) { c.depth = null; c.depthError = e.message; }
      if (c.depth == null || c.depth >= RULES.minDepthContracts) { r.best = c; break; }
    }
    if (!r.best) {
      const top = r.candidates.filter(c => c.cost != null && c.twoSided).sort((a, b) => b.edge - a.edge)[0];
      const topP = r.candidates.filter(c => c.cost != null && c.twoSided && c.modelProb > RULES.minModelProb).sort((a, b) => b.edge - a.edge)[0];
      r.noBetReason = !r.candidates.length ? 'Jupiter event has no open full-game moneyline/spread/total markets'
        : q.length ? 'Qualifying bets lacked order-book depth at the quoted price'
        : topP ? `No bet with model >50% AND positive edge (best >50% option ${topP.label}: model ${(topP.modelProb * 100).toFixed(1)}% vs cost ${(topP.cost * 100).toFixed(1)}¢)`
        : top ? `No bet with model >50% AND positive edge` : 'No two-sided (quoted bid & ask) market';
    }
  }
  r.candidates = r.candidates.filter(c => c.twoSided).slice(0, 8); // keep output compact
  games.push(r);
}
const out = { stage: 'comparison', predictionsSha256: sha, date: pred.date, fetchedAt, source: `${JUP_BASE} (keyless=${!process.env.JUPITER_API_KEY})`, jupiterEventsSeen: events.length, error, rules: RULES,
  feeModel: 'Jupiter documented fee: 0.07 x price x (1-price) per contract (matches their published fee table; rounded up to the cent per order)', games };
await fs.writeFile(new URL('out/bets.json', ROOT), JSON.stringify(out, null, 1));
console.log(`[compare] ${pred.date}: predictions sha256 verified; ${events.length} Jupiter NBA events scanned${error ? ' (ERROR ' + error + ')' : ''}`);
for (const r of games) console.log(`  ${r.matchup}: ${r.best ? `BET ${r.best.label} @ ${r.best.ask.toFixed(2)} model ${(r.best.modelProb * 100).toFixed(1)}% edge ${(r.best.edge * 100).toFixed(1)}` : 'NO BET — ' + r.noBetReason}  [ML ${r.coverage.moneyline} SP ${r.coverage.spreads} TOT ${r.coverage.totals}]`);
