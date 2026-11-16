#!/usr/bin/env python3
"""Prospective calibration of delivered primary recommendations, separate from winner accuracy.
Capture runs only after successful Discord publication. No calibration is auto-promoted.
"""
import argparse, csv, hashlib, io, json, math, os, statistics, zipfile
from datetime import datetime, timezone
from pathlib import Path
import model_learning as ml
ROOT=Path(__file__).resolve().parents[1]

def utcnow():return datetime.now(timezone.utc)
def digest(row):return hashlib.sha256(json.dumps(row,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def read(path,default):
    try:return json.loads(path.read_text())
    except FileNotFoundError:return default

def benchmark_pair(b):
    """Pre-game home-win probability from the model and from the no-vig market, for EVERY published game
    (bet or not). Stored only to grade the model against the price afterwards; never a model input."""
    try:m,k=float(b['model']),float(b['market'])
    except (TypeError,KeyError,ValueError):return None
    return {'model':round(m,6),'market':round(k,6)} if 0<m<1 and 0<k<1 else None

def make_record(event,start,model,bet,source,at,selection_policy='sensitivity-confidence-v1',benchmark=None):
    st=ml.timestamp(start); posted=ml.timestamp(at)
    if not st or not posted or posted>=st:return None
    r={'event_id':str(event),'start':st.isoformat(),'posted_at':posted.isoformat(),'model':model,'selection_policy':selection_policy,'bet':bet,'source':source}
    if bet:
        if (not math.isfinite(bet['probability']) or not .5<bet['probability']<=1
            or not math.isfinite(bet['cost']) or not 0<bet['cost']<bet['probability']):raise ValueError('Invalid posted recommendation')
    b=benchmark_pair(benchmark)
    if b:r['benchmark']=b
    r['key']=digest(r);return r

def capture(root,project,at,source):
    out=[]
    def add(event,start,model,bet,policy='sensitivity-confidence-v1',benchmark=None):
        r=make_record(event,start,model,bet,source,at,policy,benchmark)
        if r:out.append(r)
    if project=='nba-oracle':
        p=read(root/'out/predictions.json',{});b=read(root/'out/bets.json',{})
        bg={str(g['gameId']):g for g in b.get('games',[])} if b.get('date')==p.get('date') else {}
        fresh=ml.timestamp(b.get('fetchedAt')); fresh=fresh and 0<=(ml.timestamp(at)-fresh).total_seconds()<=300
        for g in p.get('games',[]):
            x=bg.get(str(g['id']),{}).get('best') if fresh else None
            bet=None if not x else {'type':x['type'],'index':0 if x['side']=='home' else 1,'side':x['side'],'line':x.get('line'),'label':x['label'],'probability':x['modelProb'],'selection_probability':x.get('modelStressLower'),'cost':x['cost']}
            mw=bg.get(str(g['id']),{}).get('marketWin') if fresh else None
            add(g['id'],g['tip'],p['modelVersion'],bet,b.get('rules',{}).get('selection','unversioned'),
                {'model':g.get('homeWin'),'market':(mw or {}).get('home')})
    elif project=='nhl-score-predictor':
        date=os.environ.get('SLATE_DATE') or ml.timestamp(at).astimezone(__import__('zoneinfo').ZoneInfo('America/New_York')).date().isoformat()
        p=read(root/f'data/predictions/{date}.json',{})
        for g in p.get('games',[]):
            fetched=ml.timestamp(g.get('quoteFetchedAt'));fresh=fetched and 0<=(ml.timestamp(at)-fetched).total_seconds()<=300
            x=g.get('best') if fresh else None;bet=None
            if x:
                label=x['label'];typ={'ML':'moneyline','TOTAL':'totals','PUCKLINE':'spreads'}[x['type']]
                bet={'type':typ,'index':0 if label.startswith(g['home']+' ') else 1,'side':'under' if label.startswith('Under') else 'over','line':None if typ=='moneyline' else float(label.split()[-1]),'label':label,'probability':x['q'],'selection_probability':x.get('sensitivityLower'),'cost':x['cost']}
            mw=g.get('marketWin') if fresh else None
            add(g['id'],g['start'],p['model'],bet,benchmark={'model':g.get('pHome'),'market':(mw or {}).get('home')})
    elif project=='lol-scanner':
        import sys
        sys.path.insert(0,str(root))
        from scanner.forecast import load_frozen, frozen_path
        date=os.environ.get('AUDIT_DATE') or ml.timestamp(at).astimezone(__import__('zoneinfo').ZoneInfo('America/New_York')).date().isoformat()
        if not frozen_path(date,'v2').exists():return []
        edge=read(root/f'edge_log/{date}.v2.json',{});fc=load_frozen(date,'v2');by={x['match_id']:x for x in edge.get('series',[])}
        fetched=ml.timestamp(edge.get('odds_fetched_at_utc'));fresh=fetched and 0<=(ml.timestamp(at)-fetched).total_seconds()<=300
        for g in fc.get('cards',[]):
            x=by.get(g['match_id'],{}).get('best_bet') if fresh else None;bet=None
            if x:
                typ=x['type'];label=x['label'];neg=label.startswith('NOT ');lab=label[4:] if neg else label
                ix=0 if (lab.split()[1] if typ=='moneyline' else lab.split()[2] if typ=='game' else lab.split()[0])==g['team_a']['code'] else 1
                bet={'type':{'map_handicap':'spreads','totals_over':'totals','totals_under':'totals'}.get(typ,typ),'index':ix,'side':'over' if typ=='totals_over' else 'under','negated':neg,'line':x.get('line'),'label':label,'probability':x['our_prob'],'selection_probability':x.get('sensitivity_lower'),'cost':x['cost']}
            add(g['match_id'],g['start_utc'],fc['model_version'],bet)
    else:raise ValueError('Unsupported project')
    return out

def merge(rows):
    by={}
    for r in rows:
        x=dict(r);key=x.pop('key');assert digest(x)==key,'Modified recommendation record'
        assert ml.timestamp(r['posted_at'])<ml.timestamp(r['start'])
        by[key]=r
    return sorted(by.values(),key=lambda x:(x['posted_at'],x['event_id'],x['key']))

def settle(b,scores):
    if b['type']=='game':return None # Aggregate series scores do not determine individual map order.
    if not scores or len(scores)!=2:return None
    own,opp=scores[b['index']],scores[1-b['index']];line=b.get('line');t=b['type']
    if t=='moneyline':v=own-opp
    elif t=='spreads':v=own+line-opp
    elif t=='totals':v=sum(scores)-line;v=-v if b['side']=='under' else v
    elif t=='exact':v=1 if list(scores)==list(line) else -1
    else:return None
    if v==0:return None # Push/void is not a loss or a win.
    return (v<0) if b.get('negated') else (v>0)

def direction_metrics(rows):
    """Keep over/under reliability separate, without changing probabilities from a small sample."""
    groups={}
    for record,bet,y in rows:
        side=bet.get('side') or 'unspecified'
        groups.setdefault(side,[]).append((record,bet,y))
    return {side:{'n':len(xs),'wins':sum(y for r,b,y in xs),
                  'win_rate':statistics.mean(y for r,b,y in xs),
                  'mean_probability':statistics.mean(b['probability'] for r,b,y in xs),
                  'brier':statistics.mean((b['probability']-y)**2 for r,b,y in xs),
                  'flat_cost_roi':statistics.mean(y/b['cost']-1 for r,b,y in xs),
                  'calibration_proposal':ml.calibration_proposal([
                      {'start':r['start'],'probabilities':[b['probability'],1-b['probability']],
                       'observed':0 if y else 1} for r,b,y in xs])}
            for side,xs in sorted(groups.items())}


def evaluate(rows,outcomes):
    chosen={}
    # A later NO BET supersedes an earlier bet, even when the contract/model version changed.
    for r in sorted(rows,key=lambda x:x['posted_at']):chosen[r['event_id']]=r
    groups={};pending=0
    for r in chosen.values():
        b=r['bet']
        if not b:continue
        result=settle(b,(outcomes.get(r['event_id']) or {}).get('scores'))
        if result is None:pending+=1;continue
        groups.setdefault((r['model'],r.get('selection_policy','unversioned'),b['type']),[]).append((r,b,int(result)))
    report={}
    for (model,policy,kind),rs in groups.items():
        n=len(rs);bins=[]
        for lo,hi in ((.5,.6),(.6,.7),(.7,.8),(.8,.9),(.9,1.000001)):
            xs=[(b,y) for r,b,y in rs if lo<b['probability']<=hi]
            if xs:bins.append({'lower_exclusive':lo,'upper_inclusive':min(hi,1),'n':len(xs),'mean_probability':statistics.mean(b['probability'] for b,y in xs),'win_rate':statistics.mean(y for b,y in xs)})
        report[model+' / '+policy+' / '+kind]={'by_direction':direction_metrics(rs),'n':n,'wins':sum(y for r,b,y in rs),'win_rate':statistics.mean(y for r,b,y in rs),'mean_probability':statistics.mean(b['probability'] for r,b,y in rs),'brier':statistics.mean((b['probability']-y)**2 for r,b,y in rs),'log_loss':statistics.mean(-math.log(max(1e-12,b['probability'] if y else 1-b['probability'])) for r,b,y in rs),'flat_cost_roi':statistics.mean(y/b['cost']-1 for r,b,y in rs),'reliability':bins,'calibration_status':'monitor_only_no_automatic_probability_changes','calibration_proposal':ml.calibration_proposal([{'start':r['start'],'probabilities':[b['probability'],1-b['probability']],'observed':0 if y else 1} for r,b,y in rs])}
    return {'settled_by_model_and_market':report,'model_vs_market':model_vs_market(chosen.values(),outcomes),'pending_or_ungradable':pending,'policy':'Delivered primary recommendation only; last pregame publication per event, including NO BET. Not actual trades. No automatic calibration promotion.'}

def model_vs_market(chosen,outcomes):
    """Log loss of the model and of the pre-game no-vig market on the same settled games. Negative diff = model better."""
    rows=[]
    for r in chosen:
        b=benchmark_pair(r.get('benchmark'));scores=(outcomes.get(r['event_id']) or {}).get('scores')
        if not b or not scores or len(scores)!=2 or scores[0]==scores[1]:continue
        y=scores[0]>scores[1];ll=lambda p:-math.log(max(1e-12,p if y else 1-p))
        rows.append((ll(b['model']),ll(b['market']),b['model'],b['market'],y))
    if not rows:return {'n':0}
    d=[a-k for a,k,*_ in rows];n=len(rows)
    out={'n':n,'model_log_loss':statistics.mean(a for a,*_ in rows),'market_log_loss':statistics.mean(k for _,k,*_ in rows),
         'log_loss_diff':statistics.mean(d),'log_loss_diff_se':statistics.stdev(d)/math.sqrt(n) if n>1 else None,
         'model_accuracy':statistics.mean((m>.5)==y for *_,m,_,y in rows),'market_accuracy':statistics.mean((k>.5)==y for *_,k,y in rows)}
    big=[(m,k,y) for *_,m,k,y in rows if abs(m-k)>.05]
    if big:out['disagree_over_5pts']={'n':len(big),'model_side_won':statistics.mean((m>k)==y for m,k,y in big),
        'model_said':statistics.mean(m if m>k else 1-m for m,k,y in big),'market_said':statistics.mean(k if m>k else 1-k for m,k,y in big)}
    se=out['log_loss_diff_se']
    out['verdict']=('too few games to say' if n<200 or se is None else 'model at least matches the market' if out['log_loss_diff']+1.96*se<=0
                    else 'market is more accurate than the model' if out['log_loss_diff']-1.96*se>0 else 'no measurable difference yet')
    return out

def collect(state):
    repo=os.environ['GITHUB_REPOSITORY'];token=os.environ['GH_TOKEN'];seen=set(state.get('artifact_ids',[]));rows=[]
    for page in range(1,21):
        arts=json.loads(ml.api_get(f'https://api.github.com/repos/{repo}/actions/artifacts?per_page=100&page={page}',token))['artifacts']
        for a in arts:
            if not a['name'].startswith('bet-learning-') or a['expired'] or a['id'] in seen:continue
            with zipfile.ZipFile(io.BytesIO(ml.api_get(f'https://api.github.com/repos/{repo}/actions/artifacts/{a["id"]}/zip',token))) as z:
                for f in z.infolist():
                    if f.filename.split('/')[-1]!='bets-inbox.jsonl':continue
                    if f.file_size>10_000_000:raise ValueError('Oversized bet ledger')
                    rows.extend(json.loads(x) for x in z.read(f).decode().splitlines() if x.strip())
            seen.add(a['id'])
        if len(arts)<100:break
    return rows,{'artifact_ids':sorted(seen)}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--capture',action='store_true');ap.add_argument('--collect',action='store_true');args=ap.parse_args();folder=ROOT/'learning';project=read(folder/'config.json',{})['project']
    if args.capture:
        if os.environ.get('DRY_RUN','false').lower()=='true':return
        if not os.environ.get('GITHUB_RUN_ID'):raise ValueError('Capture requires the successful publishing workflow')
        rows=capture(ROOT,project,utcnow().isoformat(),'github-run:'+os.environ['GITHUB_RUN_ID'])
        (folder/'bets-inbox.jsonl').write_text(''.join(json.dumps(x,sort_keys=True)+'\n' for x in rows));print('Captured',len(rows),'published pregame recommendations/NO BETs');return
    rows=ml.read_jsonl(folder/'bets.jsonl');state=read(folder/'bet-state.json',{})
    if args.collect:
        incoming,state=collect(state);rows+=incoming
    rows=merge(rows);outcomes=read(folder/'results.json',{});_,fresh=ml.collect_local(ROOT,project);outcomes.update(fresh)
    if project=='lol-scanner':
        p=ROOT/'calibration/calibration_log.csv'
        if p.exists():
            for x in csv.DictReader(p.open()):
                if x.get('actual'):outcomes.setdefault(x['match_id'],{}).update(scores=[int(v) for v in x['actual'].split('-')])
    report=evaluate(rows,outcomes);report['generated_at']=utcnow().isoformat();report['records']=len(rows)
    (folder/'bets.jsonl').write_text(''.join(json.dumps(x,sort_keys=True)+'\n' for x in rows));(folder/'bet-state.json').write_text(json.dumps(state,sort_keys=True)+'\n');(folder/'bet-report.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n');print(json.dumps(report,indent=2))
if __name__=='__main__':main()
