// Market-free summaries of simulated final scores, including uncertain-player IN/OUT subsets.
export function outcomeHistograms(sim) {
  let mMin=Infinity,mMax=-Infinity,tMin=Infinity,tMax=-Infinity;
  for(let i=0;i<sim.N;i++) {
    const m=sim.homePts[i]-sim.awayPts[i],t=sim.homePts[i]+sim.awayPts[i];
    mMin=Math.min(mMin,m);mMax=Math.max(mMax,m);tMin=Math.min(tMin,t);tMax=Math.max(tMax,t);
  }
  const blank=()=>({sims:0,marginHist:{min:mMin,counts:Array(mMax-mMin+1).fill(0)},totalHist:{min:tMin,counts:Array(tMax-tMin+1).fill(0)}});
  const base=blank(),groups=(sim.availabilityDraws||[]).map(x=>({side:x.side,name:x.name,p:x.p,in:blank(),out:blank()}));
  // Reuse original draws; no extra RNG or market input. Enumerate material joint roster states.
  const players=(sim.availabilityDraws||[]).map(({name,side,p})=>({name,side,p}));
  const joint={policy:'joint-roster-v1',minimumMass:.01,maximumPlayers:8,players,supported:players.length<=8,scenarios:[]};
  const byState=new Map();
  if(players.length>=2 && joint.supported) for(let state=0;state<2**players.length;state++) {
    const probability=players.reduce((mass,p,j)=>mass*((state & 2**j)?p.p:1-p.p),1);
    if(probability+1e-12<joint.minimumMass) continue;
    const scenario={state:players.map((p,j)=>(state & 2**j)?'in':'out'),probability,...blank()};
    joint.scenarios.push(scenario);byState.set(state,scenario);
  }
  const add=(h,m,t)=>{h.sims++;h.marginHist.counts[m-mMin]++;h.totalHist.counts[t-tMin]++;};
  for(let i=0;i<sim.N;i++) {
    const m=sim.homePts[i]-sim.awayPts[i],t=sim.homePts[i]+sim.awayPts[i];add(base,m,t);
    groups.forEach((g,j)=>add(sim.availabilityDraws[j].active[i]?g.in:g.out,m,t));
    if(byState.size) {
      let state=0;sim.availabilityDraws.forEach((p,j)=>{if(p.active[i])state+=2**j;});
      const scenario=byState.get(state);if(scenario)add(scenario,m,t);
    }
  }
  return {...base,availabilityConditionals:groups,availabilityJoint:joint};
}
