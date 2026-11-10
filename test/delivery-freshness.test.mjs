import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nba-delivery-freshness-'));
try{
 for(const folder of ['scripts','js','out'])await fs.mkdir(path.join(dir,folder));
 for(const file of ['scripts/discord-post.mjs','js/markets-jupiter.js','js/live-inputs.js'])await fs.copyFile(new URL('../'+file,import.meta.url),path.join(dir,file));
 await fs.writeFile(path.join(dir,'package.json'),'{"type":"module"}');
 const now=Date.now(),iso=ms=>new Date(ms).toISOString();
 const game={id:'g',away:{abbr:'A',name:'Away'},home:{abbr:'H',name:'Home'},final:{away:100,home:110},homeWin:.7,awayWin:.3,expMarginHome:10,expTotal:210,iTotal:[180,240],otProb:.05,confidence:'MODERATE',lineupStatus:'PROBABLE',keyFactors:[],sims:1000,seed:1,convergence:{seHomeWinPct:.1},tip:iso(now+3600000),status:{state:'pre'},sheetLine:'A 100 - H 110'};
 const pred={date:'2099-01-01',modelVersion:'fixture',sims:1000,cutoff:iso(now),sources:[],skipped:[],games:[game],availabilityRefresh:{injuriesLive:true,scheduleLive:true,injuryReportAt:iso(now)}};
 const best={type:'moneyline',side:'home',label:'FRESHNESS_TEST',ask:.5,fee:.0175,cost:.5175,modelProb:.56,edge:.0425,roi:.08,venue:'Jupiter',depth:100};
 const bets={predictionsSha256:'fixture',fetchedAt:iso(now),games:[{gameId:'g',best,alternatives:[{...best,label:'ALTERNATIVE_TEST'}]}]};
 for(const mode of ['fresh','tip-passed','stale-quote','invalid-injury','stale-injury','unverified-schedule']){
  const p=structuredClone(pred),b=structuredClone(bets);
  if(mode==='tip-passed')p.games[0].tip=iso(now-1000);
  if(mode==='stale-quote')b.fetchedAt=iso(now-301000);
  if(mode==='invalid-injury')p.availabilityRefresh.injuriesLive=false;
  if(mode==='stale-injury')p.availabilityRefresh.injuryReportAt=iso(now-1801000);
  if(mode==='unverified-schedule')p.availabilityRefresh.scheduleLive=false;
  await fs.writeFile(path.join(dir,'out/predictions.json'),JSON.stringify(p));await fs.writeFile(path.join(dir,'out/predictions.sha256'),'fixture');await fs.writeFile(path.join(dir,'out/bets.json'),JSON.stringify(b));
  const result=spawnSync(process.execPath,['scripts/discord-post.mjs'],{cwd:dir,env:{...process.env,DRY_RUN:'1'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.includes('**BEST BET: FRESHNESS_TEST'),mode==='fresh',mode);
  assert.equal(result.stdout.includes('ALTERNATIVE_TEST'),mode==='fresh',mode);
  assert(result.stdout.includes('A 100'),'score forecast must remain visible');
 }
 await fs.writeFile(path.join(dir,'out/predictions.json'),JSON.stringify(pred));await fs.writeFile(path.join(dir,'out/bets.json'),JSON.stringify(bets));
 await fs.writeFile(path.join(dir,'fake-fetch.mjs'),`import assert from 'node:assert/strict';let n=0;const originalNow=Date.now;const baseline=originalNow();Date.now=()=>baseline+(n?4000000:0);globalThis.fetch=async(url,opts)=>{n++;if(n===1)return {ok:false,status:429,json:async()=>({retry_after:.001})};assert(!opts.body.includes('FRESHNESS_TEST')&&!opts.body.includes('ALTERNATIVE_TEST'),'picks must be cleared during retries and later followups');return {ok:true,status:200};};`);
 const delivery=spawnSync(process.execPath,['--import',path.join(dir,'fake-fetch.mjs'),'scripts/discord-post.mjs'],{cwd:dir,env:{...process.env,DRY_RUN:'',INTERACTION_TOKEN:'',DISCORD_APPLICATION_ID:'',DISCORD_WEBHOOK_URL:'https://offline.invalid'},encoding:'utf8'});
 assert.equal(delivery.status,0,delivery.stderr);
 console.log('Outgoing Discord cards retain scores but clear primary/alternative picks after tip, stale quotes or failed live-input checks; no posts');
}finally{await fs.rm(dir,{recursive:true,force:true});}
