// Replay original, sanitized pregame inputs. Never fetches later injury data or prices.
// Usage: node research/replay-availability.mjs /absolute/path/to/archived/artifact
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {prepareSlate} from '../js/pipeline.js';
import {simulate} from '../js/engine.js';
import {outcomeHistograms} from '../js/outcome-histograms.js';
import {availabilityStress,ruleFails} from '../js/markets-jupiter.js';
const root=process.argv[2];
const read=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
for(const stem of ['predictions','model-inputs'])assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,stem+'.json'))).digest('hex'),fs.readFileSync(path.join(root,stem+'.sha256'),'utf8').trim());
const predictions=read('predictions.json'),bets=read('bets.json');
const slate=prepareSlate(predictions.date,read('model-inputs.json'),{today:predictions.date});
const rows=[];
for(const game of predictions.games){
 const prep=slate.games.find(g=>g.ev.id===game.id).prep;
 const h=outcomeHistograms(simulate(prep.params,game.sims,game.seed,undefined,{captureAvailability:true}));
 assert.deepEqual(h.marginHist,game.marginHist,'baseline margins changed');assert.deepEqual(h.totalHist,game.totalHist,'baseline totals changed');
 const b=bets.games.find(g=>g.gameId===game.id || g.id===game.id)?.best;
 if(!b)continue;
 const contract=b.type==='totals'?{totalWins:t=>b.side==='over'?t>b.line:t<b.line}:{wins:m=>b.type==='moneyline'?(b.side==='home'?m>0:m<0):(b.side==='home'?m+b.line>0:-m+b.line>0)};
 const candidate={...b,availabilityChecks:availabilityStress(contract,h)};
 const failures=ruleFails(candidate,b.modelProb);
 rows.push({id:game.id,label:b.label,originalProbability:b.modelProb,availabilityChecks:candidate.availabilityChecks,newStressLower:candidate.modelStressLower,qualifies:!failures.length,failures});
}
console.log(JSON.stringify({date:predictions.date,protocol:'Original pregame inputs and seeds; exact unchanged base histograms asserted. Retrospective diagnostic, not a holdout or profitability claim.',rows},null,2));
