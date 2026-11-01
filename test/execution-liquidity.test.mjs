import assert from 'node:assert/strict';
import { verifyExecutionLiquidity } from '../js/execution-liquidity.js';
import { depthAtAsk } from '../js/markets-jupiter.js';
const candidate = (extra = {}) => ({ marketId: 'test', venue: 'Jupiter', modelProb: .6, ask: .53, cost: .55,
  edge: .05, twoSided: true, depth: 100000, liquid: true, qualifies: true, fails: [], ...extra });
async function run(book, extra = {}) {
  const r = { candidates: [candidate(extra)] };
  await verifyExecutionLiquidity(r, async () => book); return r.candidates[0];
}
assert.equal((await run({ no: [[46, 100000]] })).qualifies, false, 'Polymarket depth and Jupiter liquidity 1c above ask cannot authorize a bet');
assert.equal((await run({ no: [[47, 9]] })).qualifies, false);
const good = await run({ no: [[47, 10], [46, 10000]] });
assert.equal(good.qualifies, true); assert.equal(good.depth, 10);
assert.equal(good.liquiditySource, 'Jupiter');
const r = { candidates: [candidate()] };
await verifyExecutionLiquidity(r, async () => { throw Error('offline'); });
assert.equal(r.candidates[0].qualifies, false);
assert.equal(depthAtAsk({ no: [[-2, 100], [101, 100], [47, Infinity], [47, -1], [47, '10'], null] }, .53, 0), 10);
const poly = candidate({ venue: 'Polymarket' });
await verifyExecutionLiquidity({ candidates: [poly] }, async () => { throw Error('must not fetch'); });
assert.equal(poly.qualifies, true);
assert.equal((await run({ no: [[47, 1000]] }, { modelProb: .5 })).qualifies, false);
console.log('Exact-venue, exact-price liquidity, unavailable book, invalid depth and probability regressions passed');
const ranked = { candidates: [candidate({ side: 'under', marketId: 'blocked' }), candidate({ side: 'home', marketId: 'empty' }),
  candidate({ side: 'away', marketId: 'winner' }), candidate({ side: 'over', marketId: 'lower' })] };
const calls = [];
await verifyExecutionLiquidity(ranked, async id => { calls.push(id); return { no: [[47, id === 'empty' ? 1 : 100]] }; }, { blockedDirections: new Set(['under']) });
assert.deepEqual(calls, ['empty', 'winner']);
assert.deepEqual(ranked.candidates.filter(c => c.qualifies).map(c => c.marketId), ['winner']);
