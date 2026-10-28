// Verifies the zero-market firewall: sanitizers drop market fields and committed data contains none.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { sanitizeEvent, assertNoMarketData, stripMarketFields } from '../js/firewall.js';
const fake = { id: '1', date: '2026-10-27T23:30Z', name: 'A at B', shortName: 'A @ B', season: { type: 2, year: 2027 },
  competitions: [{ odds: [{ spread: -5.5, overUnder: 230 }], pickcenter: [1], status: { type: { name: 'STATUS_SCHEDULED', state: 'pre' } },
    competitors: [{ homeAway: 'home', team: { id: '2', abbreviation: 'B' }, odds: { moneyLine: -200 } }, { homeAway: 'away', team: { id: '17', abbreviation: 'A' } }] }] };
const s = sanitizeEvent(structuredClone(fake));
assert.equal(JSON.stringify(s).match(/odds|spread|overUnder|moneyLine|pickcenter/i), null);
assert.throws(() => assertNoMarketData({ a: { odds: 1 } }));
assert.deepEqual(stripMarketFields({ x: 1, againstTheSpread: 2, winprobability: [] }), { x: 1 });
for (const f of await fs.readdir(new URL('../data/', import.meta.url))) {
  if (!f.endsWith('.json')) continue;
  assertNoMarketData(JSON.parse(await fs.readFile(new URL('../data/' + f, import.meta.url), 'utf8')));
}
console.log('firewall tests passed');

// Stage separation: no prediction-engine file may import the market-comparison module or contact a market host.
const ENGINE_FILES = ['js/engine.js', 'js/pipeline.js', 'js/firewall.js', 'js/app.js', 'js/worker.js', 'scripts/predict.mjs', 'scripts/sim-thread.mjs', 'scripts/build-data.mjs'];
for (const f of ENGINE_FILES) {
  const src = await fs.readFile(new URL('../' + f, import.meta.url), 'utf8');
  assert.equal(/markets-jupiter|jup\.ag|polymarket|kalshi|compare\.mjs|bets\.json/i.test(src), false, `${f} references market code/hosts`);
}
console.log('stage-separation tests passed');
