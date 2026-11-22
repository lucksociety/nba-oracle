"""Select a bounded score-residual correction on an earlier development period.

The baseline remains the existing independent scoring model. Actual participants
are a labeled optimistic proxy; their current-game minutes never enter features.
"""
import json,sys,os
from pathlib import Path
import numpy as np
ROOT=Path(os.environ.get("ROTATION_RESEARCH_ROOT",Path(__file__).resolve().parent))

def arrays(rows,mode):
    rows=[r for r in rows if mode in r['modes']]
    f=np.array([r['modes'][mode]['features']for r in rows]);base=np.array([r['base']for r in rows]);actual=np.array([r['actual']for r in rows])
    x=np.vstack([f,np.c_[f[:,7:],f[:,:7]]]);y=np.r_[actual[:,0]-base[:,0],actual[:,1]-base[:,1]]
    return rows,f,base,actual,x,y
def fit(rows,mode,ridge):
    *_,x,y=arrays(rows,mode);scale=np.maximum(x.std(axis=0),.01);z=x/scale
    coef=np.linalg.solve(z.T@z+ridge*np.eye(14),z.T@y)/scale
    return coef
def score(rows,mode,coef,cap):
    rows,f,base,actual,*_=arrays(rows,mode)
    correction=np.c_[np.clip(f@coef,-cap,cap),np.clip(np.c_[f[:,7:],f[:,:7]]@coef,-cap,cap)]
    pred=base+correction
    e=np.c_[np.mean(np.abs(pred-actual),axis=1),np.abs(pred[:,0]-pred[:,1]-actual[:,0]+actual[:,1]),np.abs(pred.sum(axis=1)-actual.sum(axis=1))]
    return dict(n=len(rows),team_mae=float(e[:,0].mean()),margin_mae=float(e[:,1].mean()),total_mae=float(e[:,2].mean())),e,correction
def main(sport):
    tables=json.loads((ROOT/f'{sport}-rotation-features.json').read_text());season=2026 if sport=='nba'else 2025
    split='2026-01-15'if sport=='nba'else'2025-02-01';cap=6 if sport=='nba'else 8
    choice=[]
    for weight,rows in tables.items():
        rs=[r for r in rows if r['season']==season and r['date']>=split and 'blind'in r['modes']
            and(sport!='nba'or r['date']<'2026-02-15')]
        choice.append((np.mean([x for r in rs for x in r['modes']['blind']['minute_error']]),weight))
    minute_error,weight=min(choice);rows=tables[weight]
    train=[r for r in rows if r['season']==season and r['date']<split]
    dev=[r for r in rows if r['season']==season and r['date']>=split]
    if sport=='nba':
        # Fix the January cutoff before examining any later scores.
        dev=[r for r in dev if r['date']<'2026-02-15']
    results=dict(minutes_weight=weight,minutes_choices=[(float(v),k)for v,k in choice],train_games=len(train),dev_games=len(dev),modes={})
    for mode in ['blind','active_proxy']:
        candidates=[]
        for ridge in [100.,1000.,10000.]:
            coef=fit(train,mode,ridge);metrics,_,_=score(dev,mode,coef,cap)
            candidates.append((metrics['team_mae'],ridge))
        _,ridge=min(candidates)
        # Refit using only training + development dates, then freeze before confirmation.
        coef=fit(train+dev,mode,ridge);report=dict(ridge=ridge,coefficients=coef.tolist(),cap=cap,confirmation={})
        periods={'later_2026':[r for r in rows if r['season']==2026 and r['date']>='2026-02-15'],
                 'current_2027':[r for r in rows if r['season']==2027]}
        if sport=='cbb':periods={'holdout_2026':[r for r in rows if r['season']==2026], 'current_2027':[r for r in rows if r['season']==2027]}
        for label,rs in periods.items():
            before,eb,_=score(rs,mode,np.zeros(14),cap);after,ea,corr=score(rs,mode,coef,cap);delta=ea-eb
            report['confirmation'][label]=dict(before=before,after=after,delta=delta.mean(axis=0).tolist(),paired_game_se=(delta.std(axis=0,ddof=1)/len(delta)**.5).tolist(),mean_abs_correction=float(np.abs(corr).mean()))
        results['modes'][mode]=report
    (ROOT/f'{sport}-impact-screen.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results,indent=2))
if __name__=='__main__':main(sys.argv[1])
