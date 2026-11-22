"""Market-free projected rotations and shrunk box-profile impact challengers.

Only prior dates feed minutes/skill. Actual participants are a separately labeled
optimistic availability proxy, never a source of forecast minutes or skill.
"""
import json, math, sys, os
from pathlib import Path
from collections import defaultdict
import numpy as np
ROOT=Path(os.environ.get("ROTATION_RESEARCH_ROOT",Path(__file__).resolve().parent))
STATS=['points','assists','oreb','dreb','steals','blocks','turnovers']

def allocate(raw,total,cap):
    if len(raw)*cap<total-1e-8:raise ValueError('Insufficient active rotation depth')
    out={p:0. for p in raw};left=float(total);remaining=set(raw)
    while remaining and left>1e-9:
        mass=sum(max(.01,raw[p])for p in remaining)
        proposed={p:left*max(.01,raw[p])/mass for p in remaining}
        capped=[p for p,m in proposed.items()if m>=cap]
        if not capped:
            out.update(proposed);break
        for p in capped:out[p]=float(cap);left-=cap;remaining.remove(p)
    return out

class Rotation:
    def __init__(self,regulation):
        self.regulation=regulation;self.total=5*regulation;self.logs=defaultdict(list)
        self.players={};self.league=np.zeros(8);self.season=None
    def begin(self,season):
        if self.season and self.season!=season:
            for p in self.players.values():p*=.5
        self.season=season
    def forecast(self,team,active=None,recent_weight=.5):
        logs=self.logs[team][-20:]
        if len(logs)<3:return None
        ids=set().union(*(set(x)for x in logs[-10:]))
        if active is not None:ids|=set(active)
        long={p:sum(x.get(p,0)for x in logs)/len(logs)for p in ids}
        short=logs[-3:];recent={p:sum(x.get(p,0)for x in short)/len(short)for p in ids}
        baseline=allocate({p:max(.01,long[p])for p in ids},self.total,self.regulation)
        if active is not None:ids=set(active)
        if len(ids)<5:return None
        raw={p:max(.5 if p not in long else .01,(1-recent_weight)*long.get(p,5)+recent_weight*recent.get(p,5))for p in ids}
        projected=allocate(raw,self.total,self.regulation)
        lg=self.league[1:]/max(1,self.league[0]);feature=np.zeros(7)
        for p in set(baseline)|set(projected):
            v=self.players.get(p,np.zeros(8));q=(v[1:]-v[0]*lg)/(v[0]+400)
            feature+=(projected.get(p,0)-baseline.get(p,0))*q
        return projected,feature
    def update(self,team,players):
        actual=sum(p['minutes']for p in players)
        if not .9*self.total<actual<2*self.total:return
        normal={p['id']:p['minutes']*self.total/actual for p in players if p['minutes']>0}
        self.logs[team].append(normal)
        for p in players:
            if p['minutes']<=0:continue
            v=np.r_[p['minutes'],p['stats']]
            self.players.setdefault(p['id'],np.zeros(8))[:]+=v
            self.league+=v

def load_nba():
    data=ROOT/'nba-history';games=[];base={}
    for year in [2025,2026,2027]:
        lines=json.loads((data/f'cache/lines-{year}.json').read_text())
        for eid,g in lines.items():
            players={}
            for side in ['h','a']:
                tid=g[side];ps=[]
                for p in (g.get('pl')or{}).get(tid,[]):
                    if p[2]>0:ps.append(dict(id=str(p[0]),name=p[1],minutes=p[2],stats=[p[i]for i in [3,12,10,11,13,14,15]]))
                players[tid]=ps
            games.append(dict(id=eid,date=g['d'],season=year,home=g['h'],away=g['a'],actual=[g['hs'],g['as']],players=players))
        file=ROOT/f'nba-base-{year}.json'
        if file.exists():
            for r in json.loads(file.read_text())['recs']:base[r['id']]=[(r['mT']+r['mM'])/2,(r['mT']-r['mM'])/2]
    return sorted(games,key=lambda x:(x['date'],x['id'])),base

def load_cbb():
    sys.path.insert(0,str(ROOT/'college'))
    from cbb.sources import download_frame,archive_games,instant,ET
    from cbb.model import walk_forward
    import pandas as pd
    data=ROOT/'college/cbb/data';games=[];players=defaultdict(lambda:defaultdict(list))
    cols=['game_id','athlete_id','athlete_display_name','team_id','minutes','points','assists','offensive_rebounds','defensive_rebounds','steals','blocks','turnovers']
    for year in range(2023,2028):
        games+=archive_games(download_frame('team',year,data),download_frame('schedule',year,data),year)
        frame=pd.read_parquet(data/f'player_box_{year}.parquet',columns=cols)
        for p in frame.to_dict('records'):
            if not math.isfinite(float(p['minutes']or 0))or p['minutes']<=0:continue
            stat=[float(p[k]or 0)for k in cols[5:]]
            if not np.isfinite(stat).all():continue
            players[str(int(p['game_id']))][str(int(p['team_id']))].append(dict(id=str(int(p['athlete_id'])),name=p['athlete_display_name'],minutes=float(p['minutes']),stats=stat))
    games=[g for g in games if g['date'][:10]<'2026-11-22']
    cache=ROOT/'cbb-baseline.json'
    if cache.exists():rows=json.loads(cache.read_text())
    else:
        rows=walk_forward(games,ridge=4,retention=.25);cache.write_text(json.dumps(rows))
    base={r['id']:r['mu']for r in rows}
    return [dict(g,date=instant(g['date']).astimezone(ET).date().isoformat(),actual=[g['home_score'],g['away_score']],players=players[g['id']])for g in sorted(games,key=lambda g:(g['date'],g['id']))],base

def features(games,base,regulation,weight):
    state=Rotation(regulation);rows=[];i=0
    while i<len(games):
        day=games[i]['date'];j=i
        while j<len(games)and games[j]['date']==day:j+=1
        batch=games[i:j];state.begin(batch[0]['season'])
        for g in batch:
            modes={}
            for mode in ['blind','active_proxy']:
                features=[];minute_error=[];preds=[]
                for side in ['home','away']:
                    team=g[side];ps=g['players'].get(team,[]);actual_total=sum(p['minutes']for p in ps)
                    if not .9*state.total<actual_total<2*state.total:break
                    active=[p['id']for p in ps];result=state.forecast(team,active if mode=='active_proxy'else None,weight)
                    if result is None:break
                    projected,feature=result;actual={p['id']:p['minutes']*state.total/actual_total for p in ps}
                    error=sum(abs(projected.get(p,0)-actual.get(p,0))for p in set(projected)|set(actual))/2
                    features.append(feature);minute_error.append(error);preds.append(projected)
                if len(features)==2:modes[mode]=dict(features=np.r_[features[0],features[1]].tolist(),minute_error=minute_error)
            if modes and g['id']in base:rows.append(dict(id=g['id'],date=day,season=g['season'],base=base[g['id']],actual=g['actual'],modes=modes))
        for g in batch:
            for side in ['home','away']:state.update(g[side],g['players'].get(g[side],[]))
        i=j
    return rows

def main(sport):
    games,base=load_nba()if sport=='nba'else load_cbb();reg=48 if sport=='nba'else 40
    out={};tables={}
    for weight in [0.,.5,.8]:
        rows=features(games,base,reg,weight);tables[str(weight)]=rows
        out[str(weight)]={}
        for season in sorted({r['season']for r in rows}):
            out[str(weight)][season]={mode:dict(n=len(v),misallocated_minutes_per_team=float(np.mean([x for r in v for x in r['modes'][mode]['minute_error']])))for mode in ['blind','active_proxy']if(v:=[r for r in rows if r['season']==season and mode in r['modes']])}
    (ROOT/f'{sport}-rotation-features.json').write_text(json.dumps(tables))
    (ROOT/f'{sport}-minutes-screen.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
if __name__=='__main__':main(sys.argv[1])
