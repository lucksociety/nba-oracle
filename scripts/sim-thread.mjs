// worker_threads entry: runs one game's Monte Carlo (engine only; no market data exists in this process).
import { parentPort } from 'node:worker_threads';
import { simulate, summarize } from '../js/engine.js';
parentPort.on('message', ({ i, params, N, seed }) => {
  const t0 = Date.now();
  const sim = simulate(params, N, seed);
  const s = summarize(sim); s.ms = Date.now() - t0; s.calibration = sim.calibration;
  // Full outcome distributions (needed later to price any line exactly): margin = home - away, total = home + away.
  let mMin = 1e9, mMax = -1e9, tMin = 1e9, tMax = -1e9;
  for (let k = 0; k < N; k++) { const m = sim.homePts[k] - sim.awayPts[k], t = sim.homePts[k] + sim.awayPts[k]; if (m < mMin) mMin = m; if (m > mMax) mMax = m; if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
  const mc = new Array(mMax - mMin + 1).fill(0), tc = new Array(tMax - tMin + 1).fill(0);
  for (let k = 0; k < N; k++) { mc[sim.homePts[k] - sim.awayPts[k] - mMin]++; tc[sim.homePts[k] + sim.awayPts[k] - tMin]++; }
  parentPort.postMessage({ i, s, marginHist: { min: mMin, counts: mc }, totalHist: { min: tMin, counts: tc } });
});
