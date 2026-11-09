// Market-free summaries of simulated final scores, including uncertain-player IN/OUT subsets.
export function outcomeHistograms(sim) {
  let mMin=Infinity,mMax=-Infinity,tMin=Infinity,tMax=-Infinity;
  for(let i=0;i<sim.N;i++) {
    const m=sim.homePts[i]-sim.awayPts[i],t=sim.homePts[i]+sim.awayPts[i];
    mMin=Math.min(mMin,m);mMax=Math.max(mMax,m);tMin=Math.min(tMin,t);tMax=Math.max(tMax,t);
  }
  const blank=()=>({sims:0,marginHist:{min:mMin,counts:Array(mMax-mMin+1).fill(0)},totalHist:{min:tMin,counts:Array(tMax-tMin+1).fill(0)}});
  const base=blank(),groups=(sim.availabilityDraws||[]).map(x=>({side:x.side,name:x.name,p:x.p,in:blank(),out:blank()}));
  const add=(h,m,t)=>{h.sims++;h.marginHist.counts[m-mMin]++;h.totalHist.counts[t-tMin]++;};
  for(let i=0;i<sim.N;i++) {
    const m=sim.homePts[i]-sim.awayPts[i],t=sim.homePts[i]+sim.awayPts[i];add(base,m,t);
    groups.forEach((g,j)=>add(sim.availabilityDraws[j].active[i]?g.in:g.out,m,t));
  }
  return {...base,availabilityConditionals:groups};
}
