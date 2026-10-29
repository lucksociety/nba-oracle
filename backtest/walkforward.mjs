#!/usr/bin/env node
// Chronological walk-forward backtest of the prediction engine (protocol Sections 13-14).
// For every game of season S, the model is rebuilt using ONLY games played before that date (season S) plus the
// complete prior season S-1; home-court / B2B / residual calibration is fitted on season S-1 only. No market data.
// Modes: --mode team      : team ratings + schedule only (no availability information)
//        --mode absences  : regulars who did not appear in the box score are fed in as OUT (proxy for the official
//                           inactive list, which /nba now reads ~1 h before tip). Uses post-game box scores ONLY to
//                           know who was absent, never results.
// Usage: DATA_DIR=/workspace/bt-data node backtest/walkforward.mjs --season 2026 --mode absences --sims 0|N --priors '{"shrinkK":{...}}' --out f.json
import fs from 'node:fs/promises';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { PRIORS, buildModel, prepareGame, replacementRates, hashSeed } from '../js/engine.js';
import { calibrate } from '../scripts/build-data.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = process.env.DATA_DIR || '/workspace/bt-data';
const S = Number(arg('season', 2026)), MODE = arg('mode', 'absences'), SIMS = Number(arg('sims', 0));
const over = JSON.parse(arg('priors', '{}'));
const deepAssign = (t, s) => { for (const [k, v] of Object.entries(s)) { if (v && typeof v === 'object' && !Array.isArray(v)) deepAssign(t[k] ||= {}, v); else t[k] = v; } };
deepAssign(PRIORS, over.PRIORS || over);
const calOver = over.cal || {};
const read = async f => JSON.parse(await fs.readFile(`${DIR}/${f}`, 'utf8'));
const [gamesCur, gamesPrior, playersPrior, teams, lines] = await Promise.all([read(`games-${S}.json`), read(`games-${S - 1}.json`), read(`players-${S - 1}.json`), read('teams.json'), read(`cache/lines-${S}.json`)]);
const cal = { ...calibrate(gamesPrior.games), ...calOver };
if (calOver.hcaScale) cal.homeCourtPts *= calOver.hcaScale;
const repl = replacementRates(playersPrior);
const abbr = id => teams[id]?.abbr;

// point-in-time player aggregates for season S (same layout as players-*.json)
const agg = {}; const teamGames = {}; const lastGames = {}; // lastGames[t] = list of Sets of athlete ids per game
function addGame(g) {
  for (const t of [g.h, g.a]) teamGames[t] = (teamGames[t] || 0) + 1;
  for (const [t, rows] of Object.entries(g.pl || {})) {
    agg[t] ||= {}; (lastGames[t] ||= []).push(new Set(rows.map(r => r[0])));
    for (const r of rows) { const a = agg[t][r[0]] ||= [r[0], r[1], 0, ...Array(17).fill(0), '']; a[2] += 1; for (let k = 2; k <= 17; k++) a[k + 1] += r[k]; a[19] += r[18]; a[20] = g.d; }
  }
}
const playersNow = () => ({ season: S, teamGames: { ...teamGames }, teams: Object.fromEntries(Object.entries(agg).map(([t, m]) => [t, Object.values(m).map(r => r.slice())])) });

const byDate = {};
for (const [id, g] of Object.entries(lines)) (byDate[g.d] ||= []).push({ id, ...g });
const dates = Object.keys(byDate).sort();
const recentAll = gamesCur.games.map(g => ({ date: g[1], homeId: g[2], awayId: g[3], homeAbbr: abbr(g[2]), periods: g[6] }));
const priorRows = {}; for (const [t, rows] of Object.entries(playersPrior.teams)) for (const r of rows) priorRows[r[0]] = r;

const recs = []; const jobs = [];
for (const d of dates) {
  const data = { calibration: cal, teams, gamesCurrent: gamesCur, gamesPrior, playersCurrent: playersNow(), playersPrior };
  const model = buildModel(data, d);
  const recent = recentAll.filter(r => r.date < d && r.date >= new Date(Date.parse(d) - 10 * 864e5).toISOString().slice(0, 10));
  for (const g of byDate[d]) {
    if (!model.teams[g.h] || !model.teams[g.a]) continue;
    const ev = { id: g.id, shortName: `${abbr(g.a)} @ ${abbr(g.h)}`, neutral: !!g.n, home: { id: g.h, abbr: abbr(g.h) }, away: { id: g.a, abbr: abbr(g.a) } };
    let injuries = { teams: {} };
    if (MODE === 'absences') for (const t of [g.h, g.a]) {
      const played = new Set((g.pl?.[t] || []).map(r => r[0])); if (!played.size) continue;
      const recentIds = new Set((lastGames[t] || []).slice(-10).flatMap(s => [...s]));
      const cands = Object.values(agg[t] || {}).filter(r => recentIds.has(r[0]) && r[3] / r[2] >= 12 && !played.has(r[0]));
      injuries.teams[t] = cands.map(r => ({ athleteId: r[0], name: r[1], status: 'Out', typeName: 'INJURY_STATUS_OUT', comment: '' }));
    }
    const prep = prepareGame(ev, { model, data, injuries, recentGames: recent, applyInjuries: MODE === 'absences', repl, date: d });
    const P = prep.params;
    recs.push({ id: g.id, d, h: g.h, a: g.a, hA: abbr(g.h), aA: abbr(g.a), hs: g.hs, as: g.as, mM: P.targetPts.home - P.targetPts.away, mT: P.targetPts.home + P.targetPts.away,
      gH: model.teams[g.h].gCur, gA: model.teams[g.a].gCur, out: MODE === 'absences' ? [g.h, g.a].map(t => (injuries.teams[t] || []).length) : null });
    if (SIMS) jobs.push({ i: recs.length - 1, params: P, N: SIMS, seed: hashSeed(`bt-${g.id}`) });
  }
  for (const g of byDate[d]) addGame(g);
}
if (SIMS) {
  await new Promise((resolve, reject) => {
    const nW = Math.min(jobs.length, os.availableParallelism?.() || 8); let next = 0, done = 0;
    for (let k = 0; k < nW; k++) {
      const w = new Worker(new URL('../scripts/sim-thread.mjs', import.meta.url));
      const feed = () => { if (next >= jobs.length) { w.terminate(); return; } w.postMessage(jobs[next++]); };
      w.on('message', m => { const s = m.s; Object.assign(recs[m.i], { pH: s.homeWin, eM: s.expMarginHome, eT: s.expTotal, medM: s.medMarginHome, medT: s.medTotal, iM: s.iMarginHome, iT: s.iTotal, sdM: s.sdMargin, sdT: s.sdTotal, mh: m.marginHist, th: m.totalHist });
        if (++done === jobs.length) resolve(); feed(); });
      w.on('error', reject); feed();
    }
  });
}
const out = arg('out', `/workspace/bt-out/wf-${S}-${MODE}.json`);
await fs.mkdir(out.replace(/\/[^/]+$/, ''), { recursive: true });
await fs.writeFile(out, JSON.stringify({ season: S, mode: MODE, sims: SIMS, priors: over, cal: { hca: cal.homeCourtPts, b2b: cal.backToBackPts, sdM: cal.marginResidualSD, sdT: cal.totalResidualSD }, recs }));
console.log(`season ${S} ${MODE}: ${recs.length} games -> ${out}`);
