import assert from 'node:assert/strict';
import { ruleFails } from '../js/markets-jupiter.js';
const c = { sampleN: 300000, cost: .47, edge: .0301, ask: .45 };
assert(ruleFails({...c}, .5001).length, 'a sampled 50.01% must not qualify');
assert.equal(ruleFails({...c, cost: .55, edge: .05}, .6).length, 0);
for (const sampleN of [undefined, 0, 999, Infinity]) assert(ruleFails({...c, sampleN}, .6).length);
assert(ruleFails({...c, cost: .5999, edge: .0001}, .6).some(x => x.includes('Monte Carlo error')));
console.log('Probability and EV must clear numerical sampling error');
