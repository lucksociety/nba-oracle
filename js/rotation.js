// Independent, regulation-only player-minute projections. No scoring coefficients.
const norm=s=>String(s||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,'');
export function allocateMinutes(raw,budget=240,caps={}) {
  const ids=Object.keys(raw).sort(),out=Object.fromEntries(ids.map(p=>[p,0]));
  if(ids.some(p=>!Number.isFinite(raw[p])||raw[p]<0))throw Error('Invalid minutes weight');
  const cap=p=>caps[p]??48;
  if(ids.some(p=>!Number.isFinite(cap(p))||cap(p)<0)||ids.reduce((s,p)=>s+cap(p),0)<budget-1e-8)throw Error('Insufficient rotation capacity');
  let left=budget,remaining=ids.filter(p=>cap(p)>0);
  while(remaining.length&&left>1e-9){
    const mass=remaining.reduce((s,p)=>s+Math.max(.01,raw[p]),0);
    const capped=remaining.filter(p=>left*Math.max(.01,raw[p])/mass>=cap(p));
    if(!capped.length){for(const p of remaining)out[p]=left*Math.max(.01,raw[p])/mass;break;}
    for(const p of capped){out[p]=cap(p);left-=cap(p);}
    remaining=remaining.filter(p=>!capped.includes(p));
  }
  return out;
}

export function rotationHistory(lines) {
  const out={};
  for(const [id,g]of Object.entries(lines).sort((a,b)=>a[1].d.localeCompare(b[1].d)||a[0].localeCompare(b[0]))){
    for(const team of [g.h,g.a]){
      const rows=g.pl?.[team];if(!Array.isArray(rows))continue;
      const total=rows.reduce((s,r)=>s+r[2],0);if(!(total>216&&total<480))continue;
      (out[team]||=[]).push({id,date:g.d,players:rows.filter(r=>r[2]>0).map(r=>({id:String(r[0]),name:r[1],minutes:r[2]*240/total}))});
    }
  }
  for(const t in out)out[t]=out[t].slice(-20);
  return out;
}

export function projectRotation(team,date,data,injuries=[],lineup=null,limits={}) {
  const all=[...(data.playersPrior?.rotationHistory?.[team]||[]),...(data.playersCurrent?.rotationHistory?.[team]||[])];
  const logs=[...new Map(all.filter(g=>g.date<date).map(g=>[g.id,g])).values()].sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id)).slice(-20);
  if(logs.length<3)return {status:'insufficient_history',teamId:team,players:[],budget:240};
  const recent=(data.gamesCurrent?.games||[]).filter(g=>g[1]<date&&(g[2]===team||g[3]===team)).slice(-3);
  if(recent.some(g=>!logs.some(r=>r.id===String(g[0]))))return {status:'incomplete_history',teamId:team,players:[],budget:240};
  const names={};for(const g of logs)for(const p of g.players)names[p.id]=p.name;
  const pool=new Set(logs.slice(-10).flatMap(g=>g.players.map(p=>p.id)));
  const status=new Map(injuries.map(p=>[norm(p.name),p]));
  const rosterNames=new Set([...(lineup?.active||[]),...(lineup?.inactive||[])].map(norm));
  const inactive=new Set((lineup?.status==='CONFIRMED'?lineup.inactive:[]).map(norm));
  // Only treat the official list as a full roster when coverage is substantial.
  if(lineup?.status==='CONFIRMED'&&rosterNames.size>=12)for(const p of pool)if(!rosterNames.has(norm(names[p])))pool.delete(p);
  const missing=(lineup?.starters||[]).map(p=>p.name).filter(name=>![...pool].some(p=>norm(names[p])===norm(name)));
  if(missing.length)return {status:'incomplete_rotation',teamId:team,budget:240,players:[],reason:'Starter minutes history unavailable: '+missing.join(', ')};
  const raw={},baselineRaw={},caps={},meta={};
  for(const p of [...pool].sort()){
    const name=names[p],inj=status.get(norm(name));const probability=inactive.has(norm(name))?0:(inj?.p??1);
    if(!Number.isFinite(probability)||probability<0||probability>1)return {status:'invalid_availability',teamId:team,budget:240,players:[]};
    const played=g=>g.players.find(x=>x.id===p)?.minutes||0;
    const long=logs.reduce((s,g)=>s+played(g),0)/logs.length,short=logs.slice(-3).reduce((s,g)=>s+played(g),0)/Math.min(3,logs.length);
    raw[p]=Math.max(.01,.2*long+.8*short)*probability;caps[p]=Math.min(48,limits[p]??48)*probability;
    baselineRaw[p]=Math.max(.01,long)*probability;
    meta[p]={id:p,name,availabilityProbability:probability,baselineMinutes:long,recentMinutes:short};
  }
  try{
    const minutes=allocateMinutes(raw,240,caps),baseline=allocateMinutes(baselineRaw,240,caps);
    return {status:'expected',policy:'recent-rotation-v1',teamId:team,budget:240,historyGames:logs.length,through:logs.at(-1).date,
      players:Object.keys(minutes).map(p=>({...meta[p],minutes:minutes[p],baselineProjectedMinutes:baseline[p]})).sort((a,b)=>b.minutes-a.minutes||a.id.localeCompare(b.id)),
      note:'Expected regulation rotation; public availability is not confirmation of minutes. Does not change the score forecast.'};
  }catch(e){return {status:'insufficient_capacity',teamId:team,budget:240,players:[],reason:e.message};}
}
