// Participation exposure using the same possession and recency weights as team ratings.
export function participationHistory(lines) {
  const out={};
  const possessions=b=>b[1]-b[6]+b[8]+.44*b[5];
  for(const g of Object.values(lines).sort((a,b)=>a.d.localeCompare(b.d))) {
    const p=.5*(possessions(g.hb)+possessions(g.ab));
    for(const team of [g.h,g.a]) {
      const rows=g.pl?.[team];
      // Missing player logs are not evidence that all players were absent.
      (out[team] ||= []).push([g.d,p,Array.isArray(rows)&&rows.length?rows.filter(r=>r[2]>0).map(r=>r[0]):null]);
    }
  }
  return out;
}

export function participationShare(file,team,player,cutoff,halfLife=20) {
  const rows=file?.participation?.[team]?.filter(r=>!cutoff||r[0]<cutoff);
  if(!rows?.length||rows.some(r=>!Array.isArray(r[2])||!(r[1]>0))) return null;
  let played=0,total=0;
  rows.forEach((r,i)=>{
    const w=r[1]*(halfLife>0?.5**((rows.length-1-i)/halfLife):1);
    total+=w;if(r[2].includes(player))played+=w;
  });
  return total?played/total:null;
}
