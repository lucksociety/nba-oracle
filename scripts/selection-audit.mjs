// Diagnostic counts use every evaluated contract, before the compact artifact preview.
export function selectionAudit(result,{inputBlocked=false,hasMarket=true}={}){
 const cs=result.candidates||[],rejections={};
 for(const c of cs)for(const reason of c.fails||[])rejections[reason]=(rejections[reason]||0)+1;
 const count=f=>cs.filter(f).length;
 const status=result.started?'STARTED':inputBlocked?'INPUT_BLOCKED':!hasMarket?'NO_MARKET':!cs.length?'NO_SUPPORTED_CONTRACTS':result.best?'BET':!cs.some(c=>c.cost!=null&&c.twoSided)?'PRICE_UNAVAILABLE':'NO_QUALIFYING_EDGE';
 return {status,contracts:cs.length,pricedTwoSided:count(c=>c.cost!=null&&c.twoSided),over50:count(c=>c.modelProb>.5),
  positiveAfterFeeEV:count(c=>c.modelProb>.5&&c.edge>0),scoreAligned:count(c=>c.scoreConsistent&&c.modelProb>.5&&c.edge>0),
  qualifying:count(c=>c.qualifies),rejections};
}
export function candidatePreview(result,limit=8){
 const all=result.candidates||[];const seen=new Set();
 return [result.best,...(result.alternatives||[]),...all.filter(c=>c.qualifies),...all.filter(c=>c.cost!=null&&c.twoSided).sort((a,b)=>(b.quoteStressEV??b.edge??-Infinity)-(a.quoteStressEV??a.edge??-Infinity))]
  .filter(c=>c&&!seen.has(c.marketId+'|'+c.venue+'|'+c.label)&&seen.add(c.marketId+'|'+c.venue+'|'+c.label)).slice(0,limit);
}
