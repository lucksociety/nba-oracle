import assert from 'node:assert/strict';
import {simulate,PRIORS} from '../js/engine.js';
import {outcomeHistograms} from '../js/outcome-histograms.js';
import {availabilityStress,ruleFails} from '../js/markets-jupiter.js';
import {assertNoMarketData} from '../js/firewall.js';
const team={f:{p2:.55,p3:.36,r3:.4,tov:.12,orb:.25,ftr:.25,ftp:.8},k:1,dppp:100};
const params={pace:100,home:team,away:team,uncHome:[{name:'Uncertain Starter',p:.5,off:20,def:0}],uncAway:[],expMarginPerPoss:0,priors:PRIORS};
const baseline=simulate(params,20000,42),tracked=simulate(params,20000,42,undefined,{captureAvailability:true});
assert.deepEqual(tracked.homePts,baseline.homePts);assert.deepEqual(tracked.awayPts,baseline.awayPts);
const hist=outcomeHistograms(tracked);assertNoMarketData(hist);
const g=hist.availabilityConditionals[0];assert.equal(g.in.sims+g.out.sims,tracked.N);
for(const key of ['marginHist','totalHist'])for(let i=0;i<hist[key].counts.length;i++)assert.equal(g.in[key].counts[i]+g.out[key].counts[i],hist[key].counts[i]);
const mean=h=>h.totalHist.counts.reduce((s,c,i)=>s+c*(i+h.totalHist.min),0)/h.sims;
assert(mean(g.in)>mean(g.out)+10,'conditional draws must capture the modeled player impact');
const bet={type:'totals',totalWins:x=>x>210};
const checks=availabilityStress(bet,hist);assert.equal(checks.length,2);assert(checks.every(x=>x.sampleN>9000));
const c={type:'totals',sampleN:300000,cost:.55,ask:.53,edge:.05};
assert.equal(ruleFails({...c,availabilityChecks:[{sampleN:100000,prob:.65}]},.6).length,0);
assert(ruleFails({...c,availabilityChecks:[{sampleN:100000,prob:.49}]},.6).some(x=>x.includes('IN/OUT')),'mixture +EV cannot conceal conditional failure');
assert(ruleFails({...c,availabilityChecks:[{sampleN:100000,prob:.55}]},.6).some(x=>x.includes('IN/OUT')),'conditional EV must survive sampling and calibration stress');
assert(ruleFails({...c,availabilityChecks:[{sampleN:999,prob:.9}]},.6).some(x=>x.includes('IN/OUT')));
const legacy={availability:{home:[{p:.55}]}};
assert(ruleFails({...c,availabilityChecks:availabilityStress(bet,legacy)},.6).some(x=>x.includes('IN/OUT')));
assert.deepEqual(availabilityStress(bet,{availability:{home:[{p:0}]}}),[]);
console.log('Conditional IN/OUT histograms preserve seeded forecasts, partition draws and fail closed on fragile bets');

const {Worker}=await import('node:worker_threads');
const worker=new Worker(new URL('../scripts/sim-thread.mjs',import.meta.url));
try{
 const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.postMessage({i:0,params,N:20000,seed:42});});
 assert.deepEqual(result.totalHist,hist.totalHist);assert.deepEqual(result.marginHist,hist.marginHist);assert.deepEqual(result.availabilityConditionals,hist.availabilityConditionals);
}finally{await worker.terminate();}
