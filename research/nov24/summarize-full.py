import json,numpy as np
from pathlib import Path
R=Path(__file__).resolve().parent
METRICS=['winner_log_loss','winner_brier','team_mae','margin_mae','total_mae','fixed_total_brier','fixed_spread_brier']
def values(rs):
 out=[]
 for r in rs:
  p=np.clip(r['pH'],.0001,.9999);y=r['hs']>r['as'];dm=r['eM']-r['hs']+r['as'];dt=r['eT']-r['hs']-r['as'];extra=[]
  for k,lines,target in [('th',np.arange(190.5,271),r['hs']+r['as']),('mh',np.arange(-25.5,26),r['hs']-r['as'])]:
   hist=r[k];counts=np.asarray(hist['counts']);v=np.arange(hist['min'],hist['min']+len(counts));q=np.array([counts[v>line].sum()/counts.sum()for line in lines]);extra.append(float(((q-(target>lines))**2).mean()))
  out.append([-np.log(p if y else 1-p),(p-y)**2,(abs(dt+dm)+abs(dt-dm))/4,abs(dm),abs(dt),*extra])
 return np.array(out)
report={'metrics':METRICS,'comparisons':{}}
for season in [2026,2027]:
 for mode in ['team','absences']:
  a=json.load(open(R/f'full-{season}-{mode}-baseline.json'))['recs'];b=json.load(open(R/f'full-{season}-{mode}-challenger.json'))['recs'];assert [r['id']for r in a]==[r['id']for r in b]
  x,y=values(a),values(b);d=y-x
  v={'n':len(a),'dates':[min(r['d']for r in a),max(r['d']for r in a)],'baseline':dict(zip(METRICS,x.mean(axis=0).tolist())),'challenger':dict(zip(METRICS,y.mean(axis=0).tolist())),'delta':dict(zip(METRICS,d.mean(axis=0).tolist())),'paired_se':dict(zip(METRICS,(d.std(axis=0,ddof=1)/len(d)**.5).tolist()))}
  report['comparisons'][f'{season}-{mode}']=v;print(season,mode,v['delta'],flush=True)
(R/'pace-full-confirmation.json').write_text(json.dumps(report,indent=2)+'\n')
