// Are the model's probabilities calibrated, and would a correction have helped on games it had not seen?
// Input: walk-forward records (backtest/walkforward.mjs --sims N, absences mode) for one or more seasons, in date order.
// Model output against final scores only; no price is read.
//   node research/calibration-check.mjs wf-2026.json wf-2027.json [--out research/calibration-check.json]
import fs from 'node:fs';
const files = process.argv.slice(2).filter(a => a.endsWith('.json') && !a.includes('calibration-check'));
const outAt = process.argv.indexOf('--out'), outFile = outAt > 0 ? process.argv[outAt + 1] : null;
const recs = files.flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')).recs).filter(r => r.pH != null).sort((a, b) => a.d.localeCompare(b.d));
const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p)), logit = p => Math.log(p / (1 - p)), sig = z => 1 / (1 + Math.exp(-z));
const tail = (h, line) => { let c = 0, n = 0; h.counts.forEach((k, i) => { n += k; if (h.min + i > line) c += k; }); return c / n; };
// one row per (game, question): {d, p, y}
const build = kind => recs.flatMap(r => {
  if (kind === 'winner') return [{ d: r.d, p: clip(r.pH), y: r.hs > r.as ? 1 : 0 }];
  const h = kind === 'spread' ? r.mh : r.th, v = kind === 'spread' ? r.hs - r.as : r.hs + r.as, mid = kind === 'spread' ? Math.round(r.medM) : Math.round(r.medT);
  // lines around the model's own centre: where bets actually sit. Half points, so no pushes.
  return [-9.5, -6.5, -3.5, -0.5, 2.5, 5.5, 8.5].map(o => ({ d: r.d, p: clip(tail(h, mid + o)), y: v > mid + o ? 1 : 0 }));
});
// logistic recalibration q = sig(a + b * logit(p)); b = 1, a = 0 means already calibrated
function fit(rows, withA) {
  let a = 0, b = 1;
  for (let it = 0; it < 60; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const r of rows) { const z = logit(r.p), q = sig(a + b * z), e = q - r.y, w = q * (1 - q); ga += e; gb += e * z; haa += w; hab += w * z; hbb += w * z * z; }
    if (!withA) { b -= gb / hbb; continue; }
    const det = haa * hbb - hab * hab; a -= (hbb * ga - hab * gb) / det; b -= (haa * gb - hab * ga) / det;
  }
  return { a, b };
}
const ll = (r, m) => { const q = clip(m ? sig(m.a + m.b * logit(r.p)) : r.p); return -(r.y ? Math.log(q) : Math.log(1 - q)); };
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function dayBoot(rows, stat, B = 2000) {            // resample whole days: games on one night are not independent
  const days = [...new Set(rows.map(r => r.d))], by = Object.fromEntries(days.map(d => [d, rows.filter(r => r.d === d)])), R = rng(20261120), out = [];
  for (let k = 0; k < B; k++) { const s = []; for (let i = 0; i < days.length; i++) s.push(...by[days[Math.floor(R() * days.length)]]); out.push(stat(s)); }
  out.sort((x, y) => x - y); return [out[Math.floor(B * 0.025)], out[Math.floor(B * 0.975)]];
}
const mean = (rows, f) => rows.reduce((s, r) => s + f(r), 0) / rows.length, r4 = x => +x.toFixed(4);
const result = { games: recs.length, from: recs[0].d, to: recs.at(-1).d, files };
for (const kind of ['winner', 'spread', 'total']) {
  const rows = build(kind), o = {};
  // 1. reliability: when the model says X%, how often does it happen? (favoured side of each question)
  const fav = rows.map(r => ({ d: r.d, p: Math.max(r.p, 1 - r.p), y: r.p >= 0.5 ? r.y : 1 - r.y }));
  o.reliability = [[.5, .55], [.55, .6], [.6, .65], [.65, .7], [.7, .75], [.75, .8], [.8, .85], [.85, .9], [.9, 1.01]].map(([lo, hi]) => { const b = fav.filter(r => r.p >= lo && r.p < hi);
    return { band: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`, n: b.length, said: b.length ? r4(mean(b, r => r.p)) : null, happened: b.length ? r4(mean(b, r => r.y)) : null }; });
  o.overall = { n: rows.length, said: r4(mean(fav, r => r.p)), happened: r4(mean(fav, r => r.y)), gap_ci95: dayBoot(fav, s => mean(s, r => r.p) - mean(s, r => r.y)).map(r4), log_loss: r4(mean(rows, r => ll(r))) };
  // 2. the correction the data asks for, with its uncertainty
  const all = fit(rows, kind === 'winner');
  o.fit_all = { slope: r4(all.b), slope_ci95: dayBoot(rows, s => fit(s, kind === 'winner').b, 400).map(r4), intercept: r4(all.a) };
  // 3. would it have helped? Fit on everything before each month, apply to that month, never the reverse.
  const months = [...new Set(rows.map(r => r.d.slice(0, 7)))], test = [];
  for (const m of months) { const train = rows.filter(r => r.d.slice(0, 7) < m); if (new Set(train.map(r => r.d)).size < 60) continue;
    const f = fit(train, false); for (const r of rows.filter(r => r.d.slice(0, 7) === m)) test.push({ d: r.d, before: ll(r), after: ll(r, f), slope: f.b }); }
  o.forward_test = { n: test.length, months: [...new Set(test.map(t => t.d.slice(0, 7)))].length, log_loss_before: r4(mean(test, t => t.before)), log_loss_after: r4(mean(test, t => t.after)),
    change: +mean(test, t => t.after - t.before).toFixed(5), change_ci95: dayBoot(test, s => mean(s, t => t.after - t.before)).map(x => +x.toFixed(5)), slopes_used: [r4(Math.min(...test.map(t => t.slope))), r4(Math.max(...test.map(t => t.slope)))] };
  o.verdict = o.forward_test.change < 0 && o.forward_test.change_ci95[1] < 0 ? 'a correction would have helped' : 'no correction is supported';
  result[kind] = o;
}
// 4. do the model's 80% ranges contain the result 80% of the time?
const cov = recs.filter(r => r.iM && r.iT);
result.ranges_80 = { n: cov.length, margin: r4(cov.filter(r => r.hs - r.as >= r.iM[0] && r.hs - r.as <= r.iM[1]).length / cov.length), total: r4(cov.filter(r => r.hs + r.as >= r.iT[0] && r.hs + r.as <= r.iT[1]).length / cov.length) };
console.log(JSON.stringify(result, null, 1));
if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1) + '\n');
