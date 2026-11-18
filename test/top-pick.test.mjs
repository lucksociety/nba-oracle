import assert from 'node:assert';
import { topPick } from '../js/top-pick.js';
assert.match(topPick('BOS', 0.784, 0.72), /Top pick: BOS to win\*\* · model 78% · price about 72¢ · model rates it above the price/);
assert.match(topPick('BOS', 0.60, 0.66), /price is above the model’s number/);
assert.match(topPick('BOS', 0.60, 0.61), /in line with the price/);
assert.match(topPick('BOS', 0.60, undefined), /no price available/);
assert.match(topPick('MIN', 0.506, 0.5), /none, too close to call \(MIN 51%\)/);
console.log('top-pick: ok');
