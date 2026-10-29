// Metrics for walk-forward records. Uses simulated outputs (pH, eM, eT, iM, iT) when present, else an analytic
// normal approximation with the given SDs (used only for fast parameter screening).
export const Phi = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
export function metrics(recs, { sdM = 13.7, sdT = 19.8, minG = 0, map = p => p } = {}) {
  const R = recs.filter(r => Math.min(r.gH, r.gA) >= minG);
  let n = 0, hit = 0, brier = 0, ll = 0, maeM = 0, maeT = 0, biasM = 0, biasT = 0, maeTeam = 0, covM = 0, covT = 0, cov = 0, favErr = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  let sxy = 0, sxx = 0, sx = 0, sy = 0;
  for (const r of R) {
    const eM = r.eM ?? r.mM, eT = r.eT ?? r.mT; const m = r.hs - r.as, t = r.hs + r.as; const y = m > 0 ? 1 : 0;
    const p = map(r.pH ?? Phi(eM / sdM), r);
    n++; hit += (p >= 0.5) === (y === 1) ? 1 : 0; brier += (p - y) ** 2; ll += -Math.log(Math.max(1e-6, y ? p : 1 - p));
    maeM += Math.abs(eM - m); maeT += Math.abs(eT - t); biasM += eM - m; biasT += eT - t;
    maeTeam += (Math.abs((eT + eM) / 2 - r.hs) + Math.abs((eT - eM) / 2 - r.as)) / 2;
    const s = Math.sign(eM) || 1; favErr += s * (eM - m); // + = favourites over-rated
    sxy += eM * m; sxx += eM * eM; sx += eM; sy += m;
    if (r.iM) { cov++; covM += m >= r.iM[0] && m <= r.iM[1] ? 1 : 0; covT += t >= r.iT[0] && t <= r.iT[1] ? 1 : 0; }
    const pf = Math.max(p, 1 - p), yf = p >= 0.5 ? y : 1 - y; const b = Math.min(4, Math.floor((pf - 0.5) / 0.1 * 1)); // 50-60..90-100 in 5 bins
    bins[b].n++; bins[b].p += pf; bins[b].y += yf;
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { n, acc: hit / n, brier: brier / n, logloss: ll / n, maeMargin: maeM / n, maeTotal: maeT / n, maeTeam: maeTeam / n, biasMargin: biasM / n, biasTotal: biasT / n,
    favOverrate: favErr / n, slope, cover80M: cov ? covM / cov : null, cover80T: cov ? covT / cov : null,
    calib: bins.filter(b => b.n).map((b, i) => ({ bin: `${50 + 10 * bins.indexOf(b)}-${60 + 10 * bins.indexOf(b)}%`, n: b.n, pred: +(b.p / b.n).toFixed(3), actual: +(b.y / b.n).toFixed(3) })) };
}
export const fmt = m => `n=${m.n} acc ${(m.acc * 100).toFixed(1)}% brier ${m.brier.toFixed(4)} LL ${m.logloss.toFixed(4)} | MAE margin ${m.maeMargin.toFixed(2)} total ${m.maeTotal.toFixed(2)} team ${m.maeTeam.toFixed(2)} | bias M ${m.biasMargin.toFixed(2)} T ${m.biasTotal.toFixed(2)} favOver ${m.favOverrate.toFixed(2)} slope ${m.slope.toFixed(3)}${m.cover80M != null ? ` | 80%cov M ${(m.cover80M * 100).toFixed(1)} T ${(m.cover80T * 100).toFixed(1)}` : ''}`;
