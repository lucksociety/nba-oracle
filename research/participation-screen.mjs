// Read-only chronological analytic comparison; no execution or price inputs.
// DATA_DIR=/path/to/history node research/participation-screen.mjs
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execFileSync}from 'node:child_process';import {metrics}from '../backtest/metrics.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nba-participation-')),out={};
for(const season of [2026,2027]){
  out[season]={};
  for(const [name,priors]of [['baseline',{}],['weighted',{participationWeighting:true}]]){
    const file=path.join(temp,`${season}-${name}.json`);
    execFileSync('node',['backtest/walkforward.mjs','--season',String(season),'--mode','absences','--priors',JSON.stringify(priors),'--out',file],{stdio:'pipe'});
    const f=JSON.parse(fs.readFileSync(file)),m=metrics(f.recs,{sdM:f.cal.sdM});
    out[season][name]={n:f.recs.length,analytic_log_loss:m.logloss,analytic_brier:m.brier,margin_mae:m.maeMargin,total_mae:m.maeTotal};
  }
}
fs.writeFileSync(new URL('./participation-screen-nov20.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(out);
