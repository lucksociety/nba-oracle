// Simulator what-if: fixing a listed player as playing or sitting out must flow through the same injury logic,
// and must change nothing when no choice is made. Uses whatever slate the committed snapshot holds.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { prepareSlate } from '../js/pipeline.js';
import { prepareGame } from '../js/engine.js';
const rd = async f => JSON.parse(await fs.readFile(new URL(`../data/${f}.json`, import.meta.url), 'utf8'));
const [meta, calibration, teams, snapshot] = await Promise.all(['meta', 'calibration', 'teams', 'snapshot'].map(rd));
const data = { meta, calibration, teams, gamesCurrent: await rd('games-' + meta.currentSeason), gamesPrior: await rd('games-' + meta.priorSeason),
  playersCurrent: await rd('players-' + meta.currentSeason), playersPrior: await rd('players-' + meta.priorSeason) };
let checked = 0;
for (const date of Object.keys(snapshot.schedule).sort().reverse()) {
  let slate;
  try { slate = prepareSlate(date, { data, schedule: snapshot.schedule, injuries: snapshot.injuries, lineups: null }, { today: date }); } catch { continue; }
  assert.ok(slate.context && slate.context.model === slate.model, 'slate exposes the context used to prepare its games');
  for (const g of slate.games) {
    const same = prepareGame(g.ev, { ...slate.context });
    assert.deepEqual(same.params.targetPts, g.prep.params.targetPts, 'no choice: identical to the forecast');
    for (const [side, list] of [['home', g.prep.injH], ['away', g.prep.injA]]) {
      const p = list.find(x => x.mpg > 0 && x.p > 0.05 && x.p < 0.95 && Math.abs(x.netPG * x.presence) > 0.2);
      if (!p) continue;
      const pick = v => prepareGame(g.ev, { ...slate.context, userAvailability: { [p.athleteId]: v } });
      const out = pick('out'), inn = pick('in'), row = (r, k) => (k === 'home' ? r.injH : r.injA).find(x => x.athleteId === p.athleteId);
      assert.equal(row(out, side).p, 0); assert.equal(row(inn, side).p, 1);
      assert.match(row(out, side).label, /your choice/); assert.equal(row(out, side).reportP, p.p);
      const unc = r => (side === 'home' ? r.params.uncHome : r.params.uncAway).some(u => u.name === p.name);
      assert.equal(unc(out), false, 'a fixed player is no longer sampled as uncertain'); assert.equal(unc(inn), false);
      // sitting out a player the model values lowers his own team's expected points (or raises the opponent's)
      const edge = r => r.params.targetPts[side] - r.params.targetPts[side === 'home' ? 'away' : 'home'];
      if (p.netPG * p.presence > 0) assert.ok(edge(out) < edge(inn), `${p.name} out must hurt ${side}`);
      checked++;
    }
  }
  if (checked) break;
}
console.log(checked ? `simulator what-if ok (${checked} player${checked > 1 ? 's' : ''} checked)` : 'simulator what-if: no uncertain player in the snapshot to check');
