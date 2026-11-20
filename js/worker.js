// Web Worker: runs the Monte Carlo off the main thread.
import { simulate, summarize } from './engine.js';
// Final-margin and total-points bands for the Simulator tab (model output only).
function scoreBands(sim, s) {
  const N = sim.N, margin = new Array(14).fill(0), base = Math.floor(s.medTotal / 10) * 10 - 20, total = new Array(7).fill(0);
  for (let i = 0; i < N; i++) {
    const m = sim.homePts[i] - sim.awayPts[i], t = sim.homePts[i] + sim.awayPts[i];
    // five-point bands out to 30, so the open-ended last band is a true tail (home margin m; a game cannot end level)
    margin[m <= -30 ? 0 : m >= 30 ? 13 : m < 0 ? 6 - Math.floor(-m / 5) : 7 + Math.floor(m / 5)]++;
    total[Math.max(0, Math.min(6, Math.floor((t - base) / 10) + 1))]++;
  }
  return { margin: margin.map(c => c / N), total: { base, p: total.map(c => c / N) } };
}
self.onmessage = (e) => {
  const { jobs, N } = e.data;
  const results = [];
  jobs.forEach((job, gi) => {
    const t0 = performance.now();
    const sim = simulate(job.params, N, job.seed, p => self.postMessage({ type: 'progress', game: gi, of: jobs.length, p }));
    const s = summarize(sim);
    if (job.bands) s.bands = scoreBands(sim, s);
    s.ms = Math.round(performance.now() - t0);
    results.push({ id: job.params.id, seed: job.seed, s });
    self.postMessage({ type: 'progress', game: gi + 1, of: jobs.length, p: 0 });
  });
  self.postMessage({ type: 'done', results });
};
