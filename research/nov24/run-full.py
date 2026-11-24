import subprocess,json,os,concurrent.futures
from pathlib import Path
root=Path(__file__).resolve().parents[2];env={**os.environ,'DATA_DIR':os.environ.get('DATA_DIR',str(root.parent/'nba-history'))}
def run(job):
 s,mode,new=job;name='challenger'if new else 'baseline';out=root/f'research/nov24/full-{s}-{mode}-{name}.json'
 priors={'paceHalfLifeGames':10 if new else 0,'normalizePaceOvertime':new,'tempoTotalCorrection':False}
 p=subprocess.run(['node','backtest/walkforward.mjs','--season',str(s),'--mode',mode,'--from','2026-02-15'if s==2026 else '2026-10-01','--sims','4000','--priors',json.dumps(priors),'--out',str(out)],env=env,cwd=root,capture_output=True,text=True)
 if p.returncode:raise RuntimeError(p.stderr)
 print(s,mode,name,'done',flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:list(pool.map(run,[(s,mode,new)for s in [2026,2027]for mode in ['team','absences']for new in [False,True]]))
