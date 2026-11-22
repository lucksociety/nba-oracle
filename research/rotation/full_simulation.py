"""Full CBB confirmation with strictly post-training correction residuals."""
import json,sys,os,datetime as dt
from pathlib import Path
import numpy as np
ROOT=Path(os.environ.get("ROTATION_RESEARCH_ROOT",Path(__file__).resolve().parent));sys.path.insert(0,str(ROOT/'college'))
from cbb.model import residuals_before,residual_context_before,matchup_weights,simulate,instant

rows=json.loads((ROOT/'cbb-baseline.json').read_text());screen=json.loads((ROOT/'cbb-impact-screen.json').read_text())
features=json.loads((ROOT/'cbb-rotation-features.json').read_text())[screen['minutes_weight']]
features={r['id']:r for r in features};model=screen['modes']['blind'];coef=np.array(model['coefficients']);cap=model['cap']
daily=json.loads((ROOT/'cbb-daily-bases.json').read_text())if '--daily'in sys.argv else {}
updated=[]
for r in rows:
    f=features.get(r['id'])
    if r['season']<2026 or not f or'blind'not in f['modes']:continue
    if '--daily'in sys.argv and r['id']not in daily:continue
    f=np.array(f['modes']['blind']['features']);corr=np.clip([f@coef,np.r_[f[7:],f[:7]]@coef],-cap,cap)
    updated.append(dict(r,mu=(np.array(daily.get(r['id'],r['mu']))+corr).tolist()))
out={}
for season in [2026,2027]:
    pools={};values={'baseline':[],'rotation':[]};dates=[]
    for r in updated:
        if r['season']!=season:continue
        key=(r['cutoff'],r['phase'])
        if key not in pools:
            pools[key]=[]
            for source in [rows,rows if '--preserve' in sys.argv else updated]:
                pools[key].append((residuals_before(source,instant(r['cutoff']),r['phase']),residual_context_before(source,instant(r['cutoff']),r['phase'])))
        if min(len(x[0])for x in pools[key])<200:continue
        original=features[r['id']]
        for i,name in enumerate(values):
            errors,context=pools[key][i];mu=np.array(daily.get(r['id'],original['base'])if i==0 else r['mu']);w=matchup_weights(mu,context)
            draws=simulate(mu,errors,int(r['id']),4000,weights=w);p=np.clip(np.mean(draws[:,0]>draws[:,1]),.005,.995)
            actual=np.array(r['actual']);pred=draws.mean(axis=0);y=actual[0]>actual[1]
            values[name].append([-np.log(p if y else 1-p),(p-y)**2,np.abs(pred-actual).mean(),abs(pred[0]-pred[1]-actual[0]+actual[1]),abs(pred.sum()-actual.sum())])
        dates.append(r['date'])
    a=np.array(values['baseline']);b=np.array(values['rotation']);delta=b-a
    out[season]={k:dict(n=len(v),**dict(zip(['log_loss','brier','team_mae','margin_mae','total_mae'],np.mean(v,axis=0).tolist())))for k,v in values.items()}
    out[season]['delta']=delta.mean(axis=0).tolist();out[season]['paired_game_se']=(delta.std(axis=0,ddof=1)/len(delta)**.5).tolist()
    print(season,out[season],flush=True)
(ROOT/('cbb-daily-simulation.json'if '--daily'in sys.argv else'cbb-preserved-error-simulation.json'if '--preserve'in sys.argv else'cbb-full-simulation.json')).write_text(json.dumps(out,indent=2)+'\n')
