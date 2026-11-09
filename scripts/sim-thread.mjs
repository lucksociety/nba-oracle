// worker_threads entry: runs one game's Monte Carlo (engine only; no market data exists in this process).
import { parentPort } from 'node:worker_threads';
import { simulate, summarize } from '../js/engine.js';
import { outcomeHistograms } from '../js/outcome-histograms.js';
parentPort.on('message', ({ i, params, N, seed }) => {
  const t0 = Date.now();
  const sim = simulate(params, N, seed, undefined, {captureAvailability:true});
  const s = summarize(sim); s.ms = Date.now() - t0; s.calibration = sim.calibration;
  parentPort.postMessage({ i, s, ...outcomeHistograms(sim) });
});
