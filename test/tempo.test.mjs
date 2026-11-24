import assert from'node:assert/strict';
import{applyTotalShift,seasonAggregates}from'../js/engine.js';
const sim=()=>({N:100000,homePts:Int16Array.from({length:100000},(_,i)=>100+i%8),awayPts:Int16Array.from({length:100000},(_,i)=>99+i%7),ots:new Uint8Array(100000)});
for(const delta of[-3.7,2.3]){
 const s=sim(),before=sim();applyTotalShift(s,delta,37);
 let shift=0;for(let i=0;i<s.N;i++){assert.equal(s.homePts[i]-s.awayPts[i],before.homePts[i]-before.awayPts[i]);shift+=s.homePts[i]+s.awayPts[i]-before.homePts[i]-before.awayPts[i];}
 assert(Math.abs(shift/s.N-delta)<.02);
 const again=sim();applyTotalShift(again,delta,37);assert.deepEqual(again.homePts,s.homePts);
}
const zero={N:1,homePts:new Int16Array([1]),awayPts:new Int16Array([0])};applyTotalShift(zero,-100,1);assert(zero.awayPts[0]>=0);assert.equal(zero.homePts[0]-zero.awayPts[0],1);
assert.throws(()=>applyTotalShift(sim(),NaN,1));
const box=[45,90,10,30,20,25,10,35,12,20];
const game=(id,date,h,a,per)=>[id,date,h,a,120,115,per,false,box.map(v=>v*(48+5*(per-4))/48),box.map(v=>v*(48+5*(per-4))/48)];
const gs={games:[game('1','2026-01-01','A','B',5),game('2','2026-01-01','C','D',4)]};
const raw=seasonAggregates(gs,'2026-01-02',0,{halfLife:10,normalize:false});
const adjusted=seasonAggregates(gs,'2026-01-02',0,{halfLife:10,normalize:true});
assert(raw.teams.A.adjPace>raw.teams.C.adjPace);
assert(Math.abs(adjusted.teams.A.adjPace-adjusted.teams.C.adjPace)<1e-8,'same regulation tempo despite one team playing OT');
const later=structuredClone(gs);later.games.push(game('3','2026-01-02','A','C',8));
assert.deepEqual(seasonAggregates(later,'2026-01-02',0,{halfLife:10,normalize:true}),adjusted,'same-day data excluded');
console.log('Tempo overtime normalization, prior-date cutoff and shared-score margin preservation passed');
