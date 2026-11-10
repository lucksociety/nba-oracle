import assert from 'node:assert/strict';
import {validateInjuryFeed,validateLineupFeed,validateScoreboard,inputBetBlock,MAX_INJURY_AGE_MS} from '../js/live-inputs.js';
import {loadInputs,etToday} from '../js/pipeline.js';
const now=Date.now(),today=etToday();
const fresh={timestamp:new Date(now).toISOString(),status:'success',injuries:[]};
assert.equal(validateInjuryFeed(fresh,now),fresh);
for(const bad of [{error:'upstream unavailable'},{...fresh,injuries:{}},{...fresh,timestamp:undefined},{...fresh,status:'error'},{...fresh,timestamp:new Date(now-MAX_INJURY_AGE_MS-1).toISOString()},{...fresh,timestamp:new Date(now+61000).toISOString()},{...fresh,injuries:[{id:undefined,injuries:[]}]}])assert.throws(()=>validateInjuryFeed(bad,now));
assert.throws(()=>validateLineupFeed({error:'not found'}));assert.throws(()=>validateScoreboard({status:'error'}));
const home={homeAway:'home',team:{id:'1',abbreviation:'A'}},away={homeAway:'away',team:{id:'2',abbreviation:'B'}};
const board={events:[{id:'g',date:today+'T23:00:00Z',competitions:[{competitors:[home,away],status:{type:{state:'pre'}}}]}]};
const sources=[{base:'https://direct.invalid',label:'direct'},{base:'https://proxy.invalid',label:'proxy'}];
async function load({injury,score=()=>board,saved=true,lineup=()=>({games:[]})}={}){
 const calls=[];
 const get=async url=>{
  calls.push(url);
  if(url.startsWith('data/')){
   const file=url.split('/').at(-1).split('?')[0];
   if(file==='meta.json')return {currentSeason:2027,priorSeason:2026};
   if(file==='snapshot.json')return {schedule:saved?{[today]:[{id:'saved',home:{id:'1'},away:{id:'2'}}]}:{},injuries:{timestamp:fresh.timestamp,teams:{}}};
   return {};
  }
  if(url.includes('/injuries'))return injury?injury(url):fresh;
  if(url.includes('/scoreboard'))return url.endsWith(today.replaceAll('-',''))?score(url):{events:[]};
  return lineup(url);
 };
 const inputs=await loadInputs(today,get,'data',sources,[{url:()=> 'https://bad-lineups.invalid',label:'direct'},{url:()=> 'https://good-lineups.invalid',label:'proxy'}]);
 return {inputs,calls};
}
let {inputs,calls}=await load({injury:u=>u.includes('direct')?{error:'valid JSON, invalid feed'}:fresh,lineup:u=>u.includes('bad-')?{error:'bad'}:{games:[]}});
assert(inputs.availabilityRefresh.injuriesLive);assert(inputs.availabilityRefresh.scheduleLive);assert(inputs.lineups.source.includes('proxy'));
assert(calls.filter(u=>u.includes('/injuries')).length===2,'invalid direct source must try official-data proxy');
assert.equal(inputBetBlock(inputs,now),null);
({inputs}=await load({injury:()=>({error:'offline'})}));assert.equal(inputs.availabilityRefresh.injuriesLive,false);assert.match(inputBetBlock(inputs,now),/injury/);
({inputs}=await load({score:()=>({events:[]})}));assert.equal(inputs.availabilityRefresh.scheduleLive,false);assert.equal(inputs.schedule[today][0].id,'saved');assert.match(inputBetBlock(inputs,now),/schedule/);
({inputs}=await load({score:()=>({events:[]}),saved:false}));assert.equal(inputs.availabilityRefresh.scheduleLive,true);assert.equal(inputs.schedule[today].length,0,'genuine empty day stays empty');
assert.match(inputBetBlock({availabilityRefresh:{injuriesLive:true,injuryReportAt:new Date(now-MAX_INJURY_AGE_MS-1).toISOString()}},now),/no longer current/);
console.log('Malformed/stale feeds, official proxy fallback, saved-forecast/no-bet behavior and genuine empty slates passed');
