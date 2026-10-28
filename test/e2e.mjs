// End-to-end Node test: real data for a date, 100k sims per game, prints Section 16/17 essentials.
import fs from 'node:fs/promises';
import { loadInputs, prepareSlate, etToday } from '../js/pipeline.js';
import { simulate, summarize, buildReport, hashSeed } from '../js/engine.js';
const date = process.argv[2] || etToday(); const N = Number(process.argv[3] || 100000);
const getJSON = async (u) => {
  if (u.startsWith('data/')) return JSON.parse(await fs.readFile(new URL('../' + u.split('?')[0], import.meta.url), 'utf8'));
  const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
};
const inputs = await loadInputs(date, getJSON, 'data');
const slate = prepareSlate(date, inputs);
console.log(date, 'games', slate.games.length, 'skipped', slate.skipped.map(s => s.ev.shortName + ':' + s.reason));
const seedBase = `oracle-${date}`;
for (const { ev, prep } of slate.games) {
  const seed = hashSeed(seedBase + ':' + ev.id); const t0 = Date.now();
  const s = summarize(simulate(prep.params, N, seed)); const ms = Date.now() - t0;
  const r = buildReport(ev, prep, s, { applyInjuries: slate.applyInjuries, injuryNotToday: slate.injuryNotToday });
  console.log(`\n${ev.shortName} [${ev.status.detail}] ${ms}ms  ${r.finalLine}  conf=${r.confidence} lineup=${r.lineupStatus}`);
  console.log(`  P(home) ${(s.homeWin * 100).toFixed(1)}  OT ${(s.otProb * 100).toFixed(1)}  E[m] ${s.expMarginHome.toFixed(1)} sdM ${s.sdMargin.toFixed(1)}  E[T] ${s.expTotal.toFixed(1)} sdT ${s.sdTotal.toFixed(1)} poss ${s.expPoss.toFixed(1)} close5 ${(s.close5*100).toFixed(1)}`);
  console.log(`  targets H ${prep.factors.targetOrtgHome.toFixed(1)} A ${prep.factors.targetOrtgAway.toFixed(1)} -> sim ${(s.expHome / s.expPoss * 100).toFixed(1)} / ${(s.expAway / s.expPoss * 100).toFixed(1)}  pace ${prep.params.pace.toFixed(1)}`);
  console.log('  top', s.topScores.map(t => `${t.away}-${t.home} ${(t.p * 100).toFixed(2)}%`).join(' | '));
  console.log('  blow H', s.blowouts.home.map(x => (x * 100).toFixed(1)).join('/'), ' A', s.blowouts.away.map(x => (x * 100).toFixed(1)).join('/'));
  r.keyFactors.forEach(k => console.log('   *', k.label, k.text, '|', k.detail));
  r.uncertainty.forEach(u => console.log('   ?', u));
  console.log('  inj', [...prep.injH, ...prep.injA].filter(p => p.netPG).map(p => `${p.name}:${p.label}:${p.netPG.toFixed(1)}x${p.presence.toFixed(2)}`).join(', '));
}
console.log('\nsources', inputs.sources);
