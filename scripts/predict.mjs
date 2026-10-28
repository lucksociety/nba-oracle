#!/usr/bin/env node
// STAGE 1 — PREDICTION ENGINE (zero-market). Runs NBA ORACLE V1.2 for one ET date and FREEZES the result.
// This script never imports the stage-2 comparison module and never contacts any odds / prediction-market host
// (enforced by test/firewall.test.mjs). Output: out/predictions.json + out/predictions.sha256.
// Usage: node scripts/predict.mjs [YYYY-MM-DD] [sims]
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { loadInputs, prepareSlate, etToday } from '../js/pipeline.js';
import { buildReport, hashSeed, MODEL_VERSION } from '../js/engine.js';
import { assertNoMarketData } from '../js/firewall.js';

const date = (process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2])) ? process.argv[2] : etToday();
const N = Number(process.argv[3] || process.env.SIMS || 300000);
const ROOT = new URL('../', import.meta.url);
const getJSON = async (u) => {
  if (u.startsWith('data/')) return JSON.parse(await fs.readFile(new URL(u.split('?')[0], ROOT), 'utf8'));
  for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } catch (e) { if (i === 2) throw e; await new Promise(r => setTimeout(r, 700)); } }
};
export const canonical = (o) => JSON.stringify(o);

const t0 = Date.now();
const inputs = await loadInputs(date, getJSON, 'data');
const cutoff = new Date().toISOString();
const slate = prepareSlate(date, inputs);
const seedBase = `oracle-${date}`;
const jobs = slate.games.map((g, i) => ({ i, params: g.prep.params, N, seed: hashSeed(seedBase + ':' + g.ev.id) }));

const results = new Array(jobs.length);
await new Promise((resolve, reject) => {
  if (!jobs.length) return resolve();
  const nW = Math.max(1, Math.min(jobs.length, os.availableParallelism?.() || os.cpus().length));
  let next = 0, done = 0;
  for (let k = 0; k < nW; k++) {
    const w = new Worker(new URL('./sim-thread.mjs', import.meta.url));
    const feed = () => { if (next >= jobs.length) { w.terminate(); return; } w.postMessage(jobs[next++]); };
    w.on('message', (m) => { results[m.i] = m; done++; if (done === jobs.length) resolve(); feed(); });
    w.on('error', reject); feed();
  }
});

const games = slate.games.map((g, i) => {
  const { ev, prep } = g; const { s, marginHist, totalHist } = results[i];
  const r = buildReport(ev, prep, s, { applyInjuries: slate.applyInjuries, injuryNotToday: slate.injuryNotToday });
  const team = (t) => ({ id: t.id, abbr: t.abbr, name: t.name, short: t.short, record: t.record });
  return {
    id: ev.id, tip: ev.date, status: ev.status, venue: ev.venue?.name || null, neutral: ev.neutral,
    away: team(ev.away), home: team(ev.home),
    final: { away: r.fin.away, home: r.fin.home }, finalLine: r.finalLine, sheetLine: r.sheetLine,
    homeWin: s.homeWin, awayWin: s.awayWin, otProb: s.otProb, close5: s.close5,
    expAway: s.expAway, expHome: s.expHome, expMarginHome: s.expMarginHome, medMarginHome: s.medMarginHome,
    expTotal: s.expTotal, medTotal: s.medTotal, iTotal: s.iTotal, iMarginHome: s.iMarginHome, sdMargin: s.sdMargin, sdTotal: s.sdTotal,
    confidence: r.confidence, lineupStatus: r.lineupStatus, keyFactors: r.keyFactors.map(k => `${k.label}: ${k.text}`), uncertainty: r.uncertainty,
    sims: s.N, seed: jobs[i].seed, ms: s.ms, convergence: { seHomeWinPct: s.convergence.winProbSE * 100, splitHalfDiffPct: s.convergence.splitHalfDiff * 100 }, endgameCalibration: s.calibration,
    marginHist, totalHist,
  };
});
const out = {
  stage: 'prediction', modelVersion: MODEL_VERSION, date, sims: N, seedBase, cutoff, generatedAt: new Date().toISOString(),
  runtimeMs: Date.now() - t0, applyInjuries: slate.applyInjuries, injuryNotToday: slate.injuryNotToday,
  sources: inputs.sources, skipped: slate.skipped.map(s => ({ game: s.ev.shortName, reason: s.reason })), games,
};
assertNoMarketData(out); // the frozen prediction must contain no market-like field
const body = canonical(out);
const sha = crypto.createHash('sha256').update(body).digest('hex');
await fs.mkdir(new URL('out/', ROOT), { recursive: true });
await fs.writeFile(new URL('out/predictions.json', ROOT), body);
await fs.writeFile(new URL('out/predictions.sha256', ROOT), sha + '\n');
console.log(`[predict] ${date}: ${games.length} games x ${N.toLocaleString()} sims in ${(out.runtimeMs / 1000).toFixed(1)}s; frozen sha256=${sha}`);
for (const g of games) console.log(`  ${g.sheetLine}  P(${g.home.abbr})=${(g.homeWin * 100).toFixed(1)}%  total ${g.expTotal.toFixed(1)}  [${g.status.state}]`);
