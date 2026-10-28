// Web Worker: runs the Monte Carlo off the main thread.
import { simulate, summarize } from './engine.js';
self.onmessage = (e) => {
  const { jobs, N } = e.data;
  const results = [];
  jobs.forEach((job, gi) => {
    const t0 = performance.now();
    const sim = simulate(job.params, N, job.seed, p => self.postMessage({ type: 'progress', game: gi, of: jobs.length, p }));
    const s = summarize(sim);
    s.ms = Math.round(performance.now() - t0);
    results.push({ id: job.params.id, seed: job.seed, s });
    self.postMessage({ type: 'progress', game: gi + 1, of: jobs.length, p: 0 });
  });
  self.postMessage({ type: 'done', results });
};
