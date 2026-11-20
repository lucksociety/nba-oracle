import assert from 'node:assert/strict';
import {participationHistory,participationShare}from '../js/participation.js';
import {availabilityStress,ruleFails}from '../js/markets-rules.js';
const box=[30,70,10,30,10,12,8,20,12,15];
const lines={old:{d:'2026-11-01',h:'H',a:'A',hb:box,ab:box,pl:{H:[['P','Player',30]],A:[['X','Other',20]]}},
  recent:{d:'2026-11-02',h:'H',a:'A',hb:box,ab:box,pl:{H:[['Q','Replacement',30]],A:[['X','Other',20]]}},
  future:{d:'2026-11-03',h:'H',a:'A',hb:box,ab:box,pl:{H:[['P','Player',30]],A:[['X','Other',20]]}}};
const file={participation:participationHistory(lines)};
assert(Math.abs(participationShare(file,'H','P','2026-11-03',1)-1/3)<1e-12);
assert.equal(participationShare(file,'H','P','2026-11-02',1),1,'same-day participation excluded');
assert.equal(participationShare(file,'H','P','2026-11-03',0),.5);
assert.equal(participationShare({},'H','P','2026-11-03'),null,'legacy inputs fall back, never invent absence');
const incomplete=structuredClone(lines);delete incomplete.recent.pl;
assert.equal(participationShare({participation:participationHistory(incomplete)},'H','P','2026-11-03'),null);
const hist=q=>({sims:50000,marginHist:{min:-1,counts:[(1-q)*50000,0,q*50000]},totalHist:{min:100,counts:[50000]}});
const bet={type:'moneyline',side:'home',wins:m=>m>0};
const game={availabilityConditionals:[],modelSensitivity:[{name:'recency exposure',...hist(.52)}]};
const checks=availabilityStress(bet,game);
assert.equal(checks.length,1);assert.equal(checks[0].prob,.52);
const c={type:'moneyline',sampleN:300000,modelProb:.62,ask:.55,cost:.56,edge:.06,scoreConsistent:true,availabilityChecks:checks};
assert(ruleFails(c,.62).length,'fragile edge must fail the alternate input baseline');
assert.equal(game.modelSensitivity[0].marginHist.counts[2],26000,'frozen histogram stays immutable');
console.log('Participation recency/possession alignment, strict cutoff, missing logs and fragile-edge guard passed');

// Exercise the actual production simulation worker, including the frozen scenario.
const {Worker}=await import('node:worker_threads');
const {simulate,PRIORS}=await import('../js/engine.js');
const {outcomeHistograms}=await import('../js/outcome-histograms.js');
const team={f:{p2:.55,p3:.36,r3:.4,tov:.12,orb:.25,ftr:.25,ftp:.8},k:1,dppp:100};
const params={pace:100,home:team,away:team,uncHome:[],uncAway:[],expMarginPerPoss:0,priors:PRIORS,targetPts:{home:112,away:112}};
const baseline=outcomeHistograms(simulate(params,2000,17,undefined,{captureAvailability:true}));
params.sensitivityAlternative=structuredClone(params);
params.sensitivityAlternative.targetPts.home=108;
const result=await new Promise((resolve,reject)=>{
  const w=new Worker(new URL('../scripts/sim-thread.mjs',import.meta.url));
  w.once('error',reject);w.once('message',m=>{w.terminate();resolve(m);});
  w.postMessage({i:0,params,N:2000,seed:17});
});
assert.deepEqual(result.marginHist,baseline.marginHist);
assert.deepEqual(result.totalHist,baseline.totalHist);
assert.equal(result.modelSensitivity.length,1);
assert.equal(result.modelSensitivity[0].sims,2000);
console.log('Production worker preserves central seeded outcomes and freezes the alternate input distribution');
