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
const ENGINE_FILES = ['js/engine.js', 'js/lineups.js', 'js/pipeline.js', 'js/firewall.js', 'js/app.js', 'js/worker.js', 'scripts/predict.mjs', 'scripts/sim-thread.mjs', 'scripts/build-data.mjs', 'scripts/backtest-fetch.mjs', 'backtest/walkforward.mjs', 'backtest/metrics.mjs', 'backtest/grid.mjs'];
for (const f of ENGINE_FILES) {
  const src = await fs.readFile(new URL('../' + f, import.meta.url), 'utf8');
  assert.equal(/markets-jupiter|jup\.ag|polymarket|kalshi|compare\.mjs|bets\.json|backtest\/bets/i.test(src), false, `${f} references market code/hosts`);
}
console.log('stage-separation tests passed');

// Official lineups: whitelist sanitizer + override rules (never invent, confirmed starter = plays, inactive = out).
import { sanitizeLineups } from '../js/firewall.js';
import { applyLineup, lineupsForEvent, gameLineupStatus, etWallToISO } from '../js/lineups.js';
const rawLu = { games: [{ gameId: '1', gameStatusText: '7:00 pm ET', odds: { x: 1 }, homeTeam: { teamId: 1, teamAbbreviation: 'NYK', spread: 3, players: [
  { personId: 1, playerName: 'Jalen Brunson', lineupStatus: 'Confirmed', position: 'PG', rosterStatus: 'Active', timestamp: '2026-10-28T18:30:00', overUnder: 1 },
  { personId: 2, playerName: 'Mitchell Robinson', lineupStatus: 'Confirmed', position: '', rosterStatus: 'Inactive', timestamp: '2026-10-28T18:30:00' },
  { personId: 3, playerName: 'Josh Hart', lineupStatus: 'Confirmed', position: '', rosterStatus: 'Active', timestamp: '2026-10-28T18:30:00' },
  { personId: 4, playerName: 'OG Anunoby', lineupStatus: 'Confirmed', position: '', rosterStatus: 'Inactive', timestamp: '2026-10-28T18:30:00' }] },
  awayTeam: { teamId: 2, teamAbbreviation: 'BOS', players: [{ personId: 9, playerName: 'Jaylen Brown', lineupStatus: 'Expected', position: 'SG', rosterStatus: 'Active', timestamp: '2026-10-28T16:00:00' }] } }] };
const lu = sanitizeLineups(structuredClone(rawLu));
assert.equal(JSON.stringify(lu).match(/odds|spread|overUnder/i), null);
const L = lineupsForEvent(lu, { home: { abbr: 'NY' }, away: { abbr: 'BOS' } });
assert.equal(L.home.status, 'CONFIRMED'); assert.equal(L.away.status, 'EXPECTED'); assert.equal(gameLineupStatus(L), 'PROBABLE');
assert.equal(etWallToISO('2026-10-28T18:30:00'), '2026-10-28T22:30:00.000Z');
const inj = applyLineup([{ name: 'Jalen Brunson', comment: 'questionable' }, { name: 'Mitchell Robinson', comment: 'questionable' }, { name: 'Josh Hart', comment: 'doubtful' }, { name: 'Ghost Player', comment: 'questionable' }],
  L.home, [['99', 'OG Anunoby', 5, 160], ['98', 'Bench Guy', 5, 40]]);
assert.equal(inj[0].override.p, 1); assert.equal(inj[1].override.p, 0); assert.equal(inj[2].override.p, 0.93);
assert.equal(inj[3].override, undefined, 'player absent from a short (non-full) list must not be invented out');
assert.equal(inj.length, 5); assert.equal(inj[4].name, 'OG Anunoby'); assert.equal(inj[4].override.p, 0);
assert.deepEqual(applyLineup([{ name: 'Jaylen Brown', comment: 'out' }], L.away, []).map(x => x.override.floor), [true]);
assert.deepEqual(applyLineup([{ name: 'X', comment: 'q' }], { status: 'NONE', starters: [], active: [], inactive: [] }, []), [{ name: 'X', comment: 'q' }]);
console.log('lineup tests passed');
