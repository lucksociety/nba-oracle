"""Exploratory chronological CDF-temperature screen. Lines are fixed diagnostics, not historical bets."""
import json, math, argparse
from pathlib import Path
import numpy as np
ap=argparse.ArgumentParser();ap.add_argument('--train',required=True);ap.add_argument('--test',required=True);ap.add_argument('--out',required=True);args=ap.parse_args()
train=json.load(open(args.train))['recs']
test=json.load(open(args.test))['recs']
def samples(rows,kind):
 out=[]
 for r in rows:
  if kind=='winner':ps=[r['pH']];ys=[r['hs']>r['as']]
  else:
   hist=r['mh' if kind=='spread' else 'th'];v=np.arange(hist['min'],hist['min']+len(hist['counts']));c=np.array(hist['counts']);lines=np.arange(-25.5,26,1) if kind=='spread' else np.arange(190.5,271,1);y=r['hs']-r['as'] if kind=='spread' else r['hs']+r['as'];ps=[c[v>l].sum()/c.sum() for l in lines];ys=[y>l for l in lines]
  out.append((r['d'],np.clip(np.array(ps),.0001,.9999),np.array(ys,dtype=float)))
 return out
sig=lambda z:1/(1+np.exp(-z))
def fit(s):
 z=np.concatenate([np.log(p/(1-p)) for _,p,y in s]);y=np.concatenate([y for _,p,y in s]);lo,hi=.1,4
 for _ in range(70):
  b=(lo+hi)/2;der=np.mean((sig(b*z)-y)*z)
  if der>0:hi=b
  else:lo=b
 return (lo+hi)/2
def metrics(s,b):
 ll=[];bs=[];per=[];bins={'80-90':[],'90-100':[]}
 for d,p,y in s:
  q=np.clip(sig(b*np.log(p/(1-p))),1e-9,1-1e-9);l=-(y*np.log(q)+(1-y)*np.log(1-q));ll.append(l.mean());bs.append(((q-y)**2).mean());per.append((d,l.mean()))
  # Both complementary sides, each source game is still the sampling unit for the CI.
  for a,c in ((q,y),(1-q,1-y)):
   for name,lo,hi in [('80-90',.8,.9),('90-100',.9,1.0001)]:
    mask=(a>=lo)&(a<hi);bins[name].extend(zip(a[mask],c[mask]))
 return {'logloss':float(np.mean(ll)),'brier':float(np.mean(bs)),'bins':{k:{'derived_lines':len(v),'predicted':float(np.mean([x for x,y in v])) if v else None,'actual':float(np.mean([y for x,y in v])) if v else None} for k,v in bins.items()}},per
result={}
for kind in ['winner','spread','total']:
 a,b=samples(train,kind),samples(test,kind);beta=fit(a);before,per1=metrics(b,1);after,per2=metrics(b,beta);days={}
 for (d,x),(_,y) in zip(per1,per2):days.setdefault(d,[]).append(x-y)
 rng=np.random.default_rng(20261107);vals=list(days.values());boot=[]
 for _ in range(2000):boot.append(np.mean([v for i in rng.choice(len(vals),len(vals)) for v in vals[i]]))
 result[kind]={'temperature_beta':beta,'train_games':len(train),'test_games':len(test),'test_dates':[min(r['d'] for r in test),max(r['d'] for r in test)],'before':before,'after':after,'logloss_improvement_day_bootstrap95':np.quantile(boot,[.025,.975]).tolist()}
# Screening reserves estimated only from the earlier season, by resampling whole dates.
for kind in ['winner','spread','total']:
 byday={}
 for d,p,y in samples(train,kind):
  q=np.maximum(p,1-p);observed=np.where(p>=.5,y,1-y)
  byday.setdefault(d,[]).append(float(np.mean(q-observed)))
 rng=np.random.default_rng(20261107);groups=list(byday.values());boot=[]
 for _ in range(3000):boot.append(np.mean([x for i in rng.choice(len(groups),len(groups)) for x in groups[i]]))
 upper=float(np.quantile(boot,.975))
 result[kind]['prior_diagnostic_reserve']={'mean_overconfidence':float(np.mean([x for g in groups for x in g])),'bootstrap_upper_975':upper,'rounded_reserve':math.ceil(max(0,upper)*1000)/1000,'interpretation':'Screening stress only, not an individual forecast confidence interval or evidence of profit.'}
print(json.dumps(result,indent=2));Path(args.out).write_text(json.dumps(result,indent=2))
