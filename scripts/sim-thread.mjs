// worker_threads entry: runs one game's Monte Carlo (engine only; no market data exists in this process).
import { parentPort } from 'node:worker_threads';
import { simulate, summarize } from '../js/engine.js';
import { outcomeHistograms } from '../js/outcome-histograms.js';
parentPort.on('message', ({ i, params, N, seed }) => {
  const t0 = Date.now();
  const sim = simulate(params, N, seed, undefined, {captureAvailability:true});
  const s = summarize(sim); s.ms = Date.now() - t0; s.calibration = sim.calibration;
  const modelSensitivity=[];
  if(params.sensitivityAlternative) {
    const alternative=simulate(params.sensitivityAlternative,Math.min(N,50000),seed);
    const {sims,marginHist,totalHist}=outcomeHistograms(alternative);
    modelSensitivity.push({name:'recency-weighted participation baseline',sims,marginHist,totalHist});
  }
  parentPort.postMessage({ i, s, ...outcomeHistograms(sim),modelSensitivity });
});
