#!/usr/bin/env node
// STAGE 2 — runs only AFTER scripts/predict.mjs has frozen out/predictions.json.
// Verifies the SHA-256 of the frozen predictions, deep-freezes them in memory, then fetches prices from
// Jupiter prediction markets (where bets are placed) and Polymarket (Gamma + CLOB: second price source, fallback,
// and order-book liquidity), evaluates every full-game line, and writes out/bets.json. Never writes to predictions.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fetchNbaEvents, matchEvent, RULES, JUP_BASE } from '../js/markets-jupiter.js';
import { GAMMA, CLOB, fetchGammaEventBySlug, fetchGammaNbaGames, adaptGammaEvent, fetchBooks, evaluateCombined } from '../js/markets-polymarket.js';

const ROOT = new URL('../', import.meta.url);
const body = await fs.readFile(new URL('out/predictions.json', ROOT), 'utf8');
const expected = (await fs.readFile(new URL('out/predictions.sha256', ROOT), 'utf8')).trim();
const sha = crypto.createHash('sha256').update(body).digest('hex');
if (sha !== expected) throw new Error(`Frozen predictions hash mismatch (${sha} != ${expected}) — refusing to compare`);
const deepFreeze = (o) => { Object.values(o).forEach(v => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
const pred = deepFreeze(JSON.parse(body));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function limited(gapMs, headers = {}) {
  let last = 0;
  return async (url, init = {}) => {
    for (let i = 0; i < 4; i++) {
      const wait = last + gapMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
      const r = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) }).catch(e => ({ ok: false, status: 0, err: e }));
      if (r.ok) return r.json();
      if (i === 3 || (r.status !== 429 && r.status !== 0 && r.status < 500)) throw new Error(`${url.split('?')[0]} -> HTTP ${r.status || r.err?.message}`);
      await sleep(2500 * (i + 1));
    }
  };
}
const jupFetch = limited(process.env.JUPITER_API_KEY ? 250 : 2100, process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}); // keyless 0.5 req/s
const polyGet = limited(150);
const polyPost = (url, payload) => polyGet(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

const fetchedAt = new Date().toISOString();
let jEvents = [], jError = null, gList = null, pError = null;
try { jEvents = await fetchNbaEvents(jupFetch); } catch (e) { jError = e.message; }

const pct = (x) => (x * 100).toFixed(1);
const games = []; const priceDiffs = [];
for (const g of pred.games) {
  const jEv = jError ? null : matchEvent(g, jEvents);
  let gEv = null;
  try {
    if (jEv?.metadata?.slug) gEv = await fetchGammaEventBySlug(polyGet, jEv.metadata.slug);
    if (!gEv) { gList ??= (await fetchGammaNbaGames(polyGet, pred.date)).map(adaptGammaEvent); const a = matchEvent(g, gList); gEv = a ? await fetchGammaEventBySlug(polyGet, a.slug) : null; }
  } catch (e) { pError = e.message; }
  let books = new Map();
  if (gEv) {
    const toks = gEv.markets.filter(m => ['moneyline', 'spreads', 'totals'].includes(m.sportsMarketType) && !m.closed).flatMap(m => JSON.parse(m.clobTokenIds || '[]'));
    try { books = await fetchBooks(polyPost, toks); } catch (e) { pError = e.message; }
  }
  const r = evaluateCombined(g, jEv, gEv, books);
  // V1.3 direction guard: if ANY >50% line backing the same direction (home side, away side, over, under) shows an edge
  // above RULES.maxEdge, the model and market disagree too much on that game for any line in that direction to be
  // trusted (re-pricing the same disagreement on an alternate line does not make it credible). Backtest: backtest/README.md.
  const blockedDirs = new Set(r.candidates.filter(c => c.cost != null && c.modelProb > RULES.minModelProb && c.edge > RULES.maxEdge).map(c => c.side));
  for (const c of r.candidates) if (blockedDirs.has(c.side) && c.qualifies) { c.qualifies = false; c.fails = [...(c.fails || []), `another ${c.side} line shows edge > ${RULES.maxEdge * 100} pts — model/market disagreement too large to trust`]; }
  r.blockedDirections = [...blockedDirs];
  const tipPassed = !Number.isFinite(Date.parse(g.tip)) || Date.now() >= Date.parse(g.tip);
  r.started = g.status?.state !== 'pre' || tipPassed; r.best = null;
  for (const c of r.candidates) if (c.jupiter && c.polymarket) priceDiffs.push({ d: c.jupiter.ask - c.polymarket.ask, game: r.matchup, label: c.label });
  if (tipPassed) r.noBetReason = 'Scheduled tip has passed or is unavailable — pregame forecast is not valid for live markets';
  else if (r.started) r.noBetReason = `Game ${g.status?.state === 'post' ? 'final' : 'in progress'} at prediction time — pregame model not valid for live markets`;
  else if (!jEv && !gEv) r.noBetReason = `No NBA markets found on Jupiter${jError ? ` (API error: ${jError})` : ''} or Polymarket${pError ? ` (API error: ${pError})` : ''}`;
  else {
    const q = r.candidates.filter(c => c.qualifies);
    r.best = q[0] || null;
    if (r.best?.conditionId) { // confirm the fee curve from the CLOB (authoritative) for the chosen market
      try { const cm = await polyGet(`${CLOB}/clob-markets/${r.best.conditionId}`); r.best.polymarketFeeCurve = cm.fd || null; } catch { /* informational */ }
    }
    if (!r.best) {
      const priced = r.candidates.filter(c => c.cost != null);
      const inBand = c => c.modelProb > RULES.minModelProb && c.edge >= RULES.minEdge && c.edge <= RULES.maxEdge && c.ask <= RULES.maxPrice;
      const topP = priced.filter(inBand)[0];
      const topBig = priced.filter(c => c.modelProb > RULES.minModelProb && c.edge > RULES.maxEdge)[0];
      const topSmall = priced.filter(c => c.modelProb > RULES.minModelProb && c.edge > 0 && c.edge < RULES.minEdge)[0];
      const topAny = priced.filter(c => c.modelProb > RULES.minModelProb)[0];
      r.noBetReason = !r.candidates.length ? 'No open full-game moneyline/spread/total markets'
        : topP && !blockedDirs.has(topP.side) ? `Every line inside the bet rules failed the liquidity filters (best: ${topP.label} ${pct(topP.modelProb)}% vs ${pct(topP.cost)}¢ — ${topP.fails.join(', ')})`
        : blockedDirs.size ? `Model/market disagreement too large to trust (a >50% line backing ${[...blockedDirs].join(' / ')} shows edge > ${RULES.maxEdge * 100} pts${topBig ? `, e.g. ${topBig.label} ${pct(topBig.modelProb)}% vs ${pct(topBig.cost)}¢, +${pct(topBig.edge)} pts` : ''}) — usually missing news, not value`
        : topBig || topSmall ? `No >50% line with edge in the ${RULES.minEdge * 100}–${RULES.maxEdge * 100} pt band${topBig ? ` (largest: ${topBig.label} ${pct(topBig.modelProb)}% vs ${pct(topBig.cost)}¢, +${pct(topBig.edge)} pts — too far from the market to trust)` : ''}${topSmall ? `${topBig ? ';' : ''} (small: ${topSmall.label} +${pct(topSmall.edge)} pts < ${RULES.minEdge * 100} pt minimum)` : ''}`
        : topAny ? `No line with model >50% AND positive edge (best >50% option ${topAny.label}: model ${pct(topAny.modelProb)}% vs cost ${pct(topAny.cost)}¢ on ${topAny.venue})`
        : 'No priced line with model >50%';
    }
  }
  // top 3 alternatives (after the best) among >50% lines, ranked by edge — for sanity checks
  r.alternatives = r.candidates.filter(c => c !== r.best && c.cost != null && c.modelProb > RULES.minModelProb).slice(0, 3);
  r.candidatesTotal = r.candidates.length;
  r.candidates = r.candidates.filter(c => c.cost != null && c.twoSided).slice(0, 8); // keep output compact
  games.push(r);
}
const ad = priceDiffs.map(x => Math.abs(x.d));
const priceComparison = { pairs: priceDiffs.length, identical: ad.filter(x => x < 0.005).length, meanAbsDiffCents: ad.length ? +(ad.reduce((s, x) => s + x, 0) / ad.length * 100).toFixed(2) : null,
  maxAbsDiffCents: ad.length ? +(Math.max(...ad) * 100).toFixed(1) : null, jupiterHigher: priceDiffs.filter(x => x.d >= 0.005).length, jupiterLower: priceDiffs.filter(x => x.d <= -0.005).length };
const out = { stage: 'comparison', predictionsSha256: sha, date: pred.date, fetchedAt,
  sources: { jupiter: `${JUP_BASE} (keyless=${!process.env.JUPITER_API_KEY})`, polymarketGamma: GAMMA, polymarketClob: CLOB },
  jupiterEventsSeen: jEvents.length, error: jError && pError ? `${jError}; ${pError}` : null, jupiterError: jError, polymarketError: pError, rules: RULES,
  feeModel: { jupiter: 'ceil-to-cent(0.07 x C x p x (1-p)) — Jupiter published fee table', polymarket: 'C x rate x (p(1-p))^exponent from each market feeSchedule (CLOB fd); NBA game markets currently rate 0 ("zero_fees"); 0.05 sports default if absent' },
  pricing: 'Edge uses the Jupiter executable ask + Jupiter fee; Polymarket ask + Polymarket fee only when Jupiter has no usable two-sided quote. Liquidity from Polymarket CLOB depth within 1¢ of the best ask.',
  priceComparison, games };
await fs.writeFile(new URL('out/bets.json', ROOT), JSON.stringify(out, null, 1));

console.log(`[compare] ${pred.date}: predictions sha256 verified; Jupiter events ${jEvents.length}${jError ? ' (ERROR ' + jError + ')' : ''}; Polymarket${pError ? ' ERROR ' + pError : ' ok'}`);
const fmt = (c) => `${c.label} ${pct(c.modelProb)}% | Jup ${c.jupiter ? `${pct(c.jupiter.ask)}+${pct(c.jupiter.fee)}=${pct(c.jupiter.cost)}¢ e${c.jupiter.edge >= 0 ? '+' : ''}${pct(c.jupiter.edge)}` : '—'} | Poly ${c.polymarket ? `${pct(c.polymarket.ask)}+${pct(c.polymarket.fee)}=${pct(c.polymarket.cost)}¢ e${c.polymarket.edge >= 0 ? '+' : ''}${pct(c.polymarket.edge)}` : '—'} | depth ${c.depth == null ? '—' : Math.round(c.depth)}${c.venue && c.venue !== 'Jupiter' ? ` [priced on ${c.venue}]` : ''}${c.fails?.length ? ` ✗ ${c.fails.join(', ')}` : ' ✓'}`;
for (const r of games) {
  const cv = r.coverage;
  console.log(`  ${r.matchup}: ${r.best ? `BET [${r.best.venue}] ${fmt(r.best)}` : 'NO BET — ' + r.noBetReason}`);
  console.log(`     evaluated ${cv.evaluated} outcomes: ML ${cv.moneyline} · spreads ${cv.spreads} sides / ${cv.spreadLines} markets · totals ${cv.totals} sides / ${cv.totalLines} lines · priced Jup ${cv.jupiterPriced} / Poly ${cv.polymarketPriced}${r.unparsed ? ` · unparsed ${r.unparsed}` : ''}${r.idMismatches ? ` · id mismatches ${r.idMismatches}` : ''}`);
  r.alternatives.forEach((c, i) => console.log(`     alt${i + 1}: ${fmt(c)}`));
}
console.log(`  price comparison (same outcome, Jupiter ask vs Polymarket CLOB ask): ${JSON.stringify(priceComparison)}`);
