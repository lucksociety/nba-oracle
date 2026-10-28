// Simulator sanity / correctness checks (real data, no market data anywhere).
//  1. seed reproducibility   2. convergence 100k vs 500k   3. internal consistency
//  4. sensible score ranges   5. engine hits its own scoring targets   6. home/away mirror symmetry
// Usage: node test/sanity.mjs [YYYY-MM-DD] [maxGames]
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { loadInputs, prepareSlate, etToday } from '../js/pipeline.js';
import { simulate, summarize, selectFinalScore, hashSeed } from '../js/engine.js';

const date = process.argv[2] || etToday(); const maxGames = Number(process.argv[3] || 3);
const getJSON = async (u) => {
  if (u.startsWith('data/')) return JSON.parse(await fs.readFile(new URL('../' + u.split('?')[0], import.meta.url), 'utf8'));
  const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
};
const inputs = await loadInputs(date, getJSON, 'data');
const slate = prepareSlate(date, inputs);
assert.ok(slate.games.length > 0, `no games on ${date}`);
let checks = 0; const ok = (c, msg) => { assert.ok(c, msg); checks++; };
const t = (x) => x.toFixed(2);

for (const { ev, prep } of slate.games.slice(0, maxGames)) {
  const tag = ev.shortName; const seed = hashSeed(`sanity:${ev.id}`);
  // 1. reproducibility
  const a = simulate(prep.params, 20000, seed), b = simulate(prep.params, 20000, seed), c = simulate(prep.params, 20000, seed + 1);
  ok(Buffer.compare(Buffer.from(a.homePts.buffer), Buffer.from(b.homePts.buffer)) === 0 && Buffer.compare(Buffer.from(a.awayPts.buffer), Buffer.from(b.awayPts.buffer)) === 0, `${tag}: same seed must reproduce exactly`);
  ok(Buffer.compare(Buffer.from(a.homePts.buffer), Buffer.from(c.homePts.buffer)) !== 0, `${tag}: different seed must differ`);
  // 2. convergence (independent seeds)
  let t0 = Date.now(); const s1 = summarize(simulate(prep.params, 100000, seed)); const ms100 = Date.now() - t0;
  t0 = Date.now(); const s5 = summarize(simulate(prep.params, 500000, seed ^ 0x9e3779b9)); const ms500 = Date.now() - t0;
  const se = Math.sqrt(s1.homeWin * (1 - s1.homeWin) * (1 / 100000 + 1 / 500000));
  ok(Math.abs(s1.homeWin - s5.homeWin) < 4 * se, `${tag}: win prob not converged ${s1.homeWin} vs ${s5.homeWin}`);
  ok(Math.abs(s1.expMarginHome - s5.expMarginHome) < 0.25, `${tag}: margin not converged`);
  ok(Math.abs(s1.expTotal - s5.expTotal) < 0.35, `${tag}: total not converged`);
  ok(s5.convergence.splitHalfDiff < 0.01, `${tag}: split-half diff too large`);
  // 3. internal consistency
  const sim = simulate(prep.params, 100000, seed); const s = summarize(sim);
  let hw = 0, ties = 0, bad = 0;
  for (let i = 0; i < sim.N; i++) { const m = sim.homePts[i] - sim.awayPts[i]; if (m > 0) hw++; if (m === 0) ties++; if (!(sim.homePts[i] > 40 && sim.awayPts[i] > 40)) bad++; }
  ok(ties === 0, `${tag}: simulated ties survived overtime (${ties})`);
  ok(Math.abs(hw / sim.N - s.homeWin) < 1e-12, `${tag}: homeWin != P(margin>0)`);
  ok(Math.abs(s.homeWin + s.awayWin - 1) < 1e-12, `${tag}: probs do not sum to 1`);
  ok((s.homeWin - 0.5) * s.medMarginHome >= -0.5 || Math.abs(s.homeWin - 0.5) < 0.02, `${tag}: median margin sign disagrees with favourite`);
  ok(Math.abs(s.expAway + s.expHome - s.expTotal) < 1e-9 && Math.abs(s.expHome - s.expAway - s.expMarginHome) < 1e-9, `${tag}: score/total/margin identities broken`);
  const fin = selectFinalScore(s);
  ok(Number.isInteger(fin.home) && Number.isInteger(fin.away) && fin.home !== fin.away, `${tag}: final score not a valid integer non-tie`);
  ok((fin.home > fin.away) === (s.homeWin >= 0.5), `${tag}: final score winner disagrees with win prob`);
  ok(Math.abs(fin.home + fin.away - s.medTotal) <= 1.01 && Math.abs((fin.home - fin.away) - s.medMarginHome) <= 1.51, `${tag}: final score far from medians`);
  // 4. ranges
  ok(bad === 0, `${tag}: implausible score <=40`);
  ok(s.expTotal > 190 && s.expTotal < 265, `${tag}: expected total ${s.expTotal} out of range`);
  ok(s.sdMargin > 10.5 && s.sdMargin < 17, `${tag}: margin SD ${s.sdMargin} implausible`);
  ok(s.sdTotal > 14 && s.sdTotal < 24, `${tag}: total SD ${s.sdTotal} implausible`);
  ok(s.otProb > 0.02 && s.otProb < 0.09, `${tag}: OT prob ${s.otProb} implausible`);
  ok(s.iAway[0] > 80 && s.iHome[1] < 155, `${tag}: 80% team-score interval implausible`);
  // 5. engine reproduces the model's expected points (ratings incl. end-game fouling/OT) when every listed player is available
  const sNA = summarize(simulate(prep.params, 100000, seed + 3, null, { noAvailability: true }));
  const T = prep.params.targetPts; const simH = sNA.expHome, simA = sNA.expAway;
  ok(Math.abs(simH - T.home) < 0.35 && Math.abs(simA - T.away) < 0.35, `${tag}: sim mean pts ${t(simH)}/${t(simA)} vs model targets ${t(T.home)}/${t(T.away)}`);
  const F = { targetOrtgHome: T.home, targetOrtgAway: T.away };
  // 6. mirror symmetry: swapping offense/defense inputs mirrors the outcome distribution
  const mp = { ...prep.params, home: prep.params.away, away: prep.params.home, uncHome: prep.params.uncAway, uncAway: prep.params.uncHome, expMarginPerPoss: -prep.params.expMarginPerPoss, targetPts: { home: prep.params.targetPts.away, away: prep.params.targetPts.home } };
  const sm = summarize(simulate(mp, 100000, seed + 7));
  ok(Math.abs(sm.homeWin - s.awayWin) < 0.01 && Math.abs(sm.expMarginHome + s.expMarginHome) < 0.25, `${tag}: mirror symmetry broken`);
  console.log(`✓ ${tag}: P(home) 100k ${t(s1.homeWin * 100)}% vs 500k ${t(s5.homeWin * 100)}% (4SE=${t(400 * se)}) | margin ${t(s1.expMarginHome)}/${t(s5.expMarginHome)} | total ${t(s1.expTotal)}/${t(s5.expTotal)} | sdM ${t(s.sdMargin)} sdT ${t(s.sdTotal)} OT ${t(s.otProb * 100)}% | pts sim ${t(simH)}/${t(simA)} vs tgt ${t(F.targetOrtgHome)}/${t(F.targetOrtgAway)} | final ${fin.away}-${fin.home} | ${ms100}ms/100k ${ms500}ms/500k`);
}
console.log(`sanity: ${checks} checks passed on ${Math.min(maxGames, slate.games.length)} game(s) for ${date}`);
