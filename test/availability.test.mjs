import assert from 'node:assert/strict';
import { parseAvailability, injuryImpacts } from '../js/engine.js';
import { applyLineup } from '../js/lineups.js';
const report = (status, code, comment) => ({ athleteId: 'p', name: 'Test Player', status,
  typeName: status === 'Out' ? 'INJURY_STATUS_OUT' : 'INJURY_STATUS_DAYTODAY', fantasyCode: code, comment });
const cases = [
  [report('Questionable', 'GTD', ''), .55],
  [report('Doubtful', 'GTD', ''), .25],
  [report('Out', 'GTD', "Johnson (ankle) is questionable for Friday's game."), .55],
  [report('Out', 'GTD', "Aldama (knee) is listed as doubtful for Friday's game."), .25],
  [report('Out', 'OUT', 'Was questionable before being ruled out.'), 0],
  [report('Out', undefined, 'Expected to miss several weeks.'), 0],
  [report('Out', 'GTD', 'Ruled out for tonight.'), .05],
  [report('Day-To-Day', 'GTD', 'Listed as questionable.'), .55],
  [report('Day-To-Day', 'GTD', 'Listed as probable.'), .85],
];
const expected = { status: 'EXPECTED', starters: [{ name: 'Test Player' }], active: ['Test Player'], inactive: [] };
const data = { playersCurrent: { teams: {}, teamGames: {} }, playersPrior: { teams: {}, teamGames: {} } };
const model = { teams: {} }, repl = { off: 0, def: 0 };
for (const [inj, p] of cases) {
  assert.equal(parseAvailability(inj).p, p);
  const applied = injuryImpacts('1', applyLineup([inj], expected, []), data, model, repl)[0];
  assert.equal(applied.p, p, `${inj.comment}: an expected lineup cannot erase the game status`);
}
const out = report('Out', 'OUT', 'Out with surgery.');
const confirmed = { ...expected, status: 'CONFIRMED', updatedAt: '2026-10-30T22:00:00Z' };
assert.equal(injuryImpacts('1', applyLineup([out], confirmed, []), data, model, repl)[0].p, 1,
  'a newer confirmed starter can override an old injury listing');
const late = { ...out, date: '2026-10-30T22:05:00Z' };
assert.equal(injuryImpacts('1', applyLineup([late], confirmed, []), data, model, repl)[0].p, 0,
  'a late scratch must supersede an earlier confirmed lineup');
console.log('Availability: conflicting provider fields, explicit game status, expected/confirmed lineups and late scratches passed');
