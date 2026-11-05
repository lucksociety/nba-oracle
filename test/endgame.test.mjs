import assert from 'node:assert/strict';
import { simulate, summarize, PRIORS } from '../js/engine.js';

const team = {
  f: { p2: .55, p3: .36, r3: .40, tov: .12, orb: .25, ftr: .25, ftp: .80 },
  k: 1, dppp: 100,
};
const params = {
  pace: 100, home: team, away: team, uncHome: [], uncAway: [],
  expMarginPerPoss: 0, priors: PRIORS, targetPts: { home: 112, away: 112 },
};
const run = simulate(params, 50000, 20261105);
const summary = summarize(run);
let cliff = 0;
for (let i = 0; i < run.N; i++) {
  const margin = Math.abs(run.homePts[i] - run.awayPts[i]);
  assert.notEqual(margin, 0, 'overtime must settle tied scores');
  if (margin === 7 || margin === 8) cliff++;
}
assert(cliff / run.N < .16, 'late fouling must not pile up final margins just outside six points');
assert(Math.abs(summary.homeWin - .5) < .015, 'identical teams must remain symmetric');
assert(Math.abs(summary.expHome - 112) < .4 && Math.abs(summary.expAway - 112) < .4,
  'regulation and overtime together must preserve the calibrated scoring targets');
const replay = simulate(params, 50000, 20261105);
assert.deepEqual(replay.homePts, run.homePts, 'fixed seeds must reproduce scores');
console.log('Endgame distribution, symmetry, calibrated targets and reproducibility passed');
