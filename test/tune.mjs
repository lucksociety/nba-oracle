import fs from 'node:fs/promises';
import { loadInputs, prepareSlate } from '../js/pipeline.js';
import { simulate, summarize } from '../js/engine.js';
const getJSON = async (u) => u.startsWith('data/') ? JSON.parse(await fs.readFile(new URL('../' + u.split('?')[0], import.meta.url), 'utf8')) : (await fetch(u)).json();
const dates = ['2026-10-27', '2026-10-28'];
const slates = [];
for (const d of dates) slates.push(prepareSlate(d, await loadInputs(d, getJSON, 'data'), { today: '2026-10-27' }));
const grid = JSON.parse(process.argv[2] || '[{}]');
for (const o of grid) {
  let sm = 0, st = 0, n = 0, b20 = 0, b30 = 0, b10 = 0, c5 = 0, ot = 0, tot = 0, am = 0;
  for (const sl of slates) for (const { prep } of sl.games) {
    const s = summarize(simulate({ ...prep.params, overridePriors: o }, 20000, 7));
    sm += s.sdMargin; st += s.sdTotal; n++; tot += s.expTotal; am += Math.abs(s.expMarginHome);
    b10 += s.blowouts.home[0] + s.blowouts.away[0]; b20 += s.blowouts.home[2] + s.blowouts.away[2]; b30 += s.blowouts.home[3] + s.blowouts.away[3]; c5 += s.close5; ot += s.otProb;
  }
  console.log(JSON.stringify(o), `games ${n} sdM ${(sm / n).toFixed(2)} sdT ${(st / n).toFixed(2)} E|m| ${(am/n).toFixed(1)} T ${(tot/n).toFixed(1)} >=10 ${(b10 / n * 100).toFixed(1)} >=20 ${(b20 / n * 100).toFixed(1)} >=30 ${(b30 / n * 100).toFixed(1)} <=5 ${(c5 / n * 100).toFixed(1)} OT ${(ot / n * 100).toFixed(1)}`);
}
