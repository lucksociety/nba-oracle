import assert from 'node:assert/strict';
import worker from '../discord/worker.js';
const oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
let reads=0,fetches=[];
globalThis.caches={default:{match:async()=>{reads++;return new Response('{"stale":true}')},put:async()=>{}}};
globalThis.fetch=async(u,opts)=>{fetches.push({url:String(u),opts});return new Response(JSON.stringify({games:[],revision:fetches.length,odds:1}),{headers:{'content-type':'application/json'}})};
try{
 const ctx={waitUntil:p=>p};
 for(let i=1;i<=2;i++){
  const r=await worker.fetch(new Request('https://test/nba/lineups/20261107?_refresh='+i),{},ctx);
  const j=await r.json();assert.equal(j.revision,i);assert(!('odds' in j));
 }
 assert.equal(reads,0);assert.equal(fetches.length,2);
 assert(fetches.every(x=>x.opts.cache==='no-store'&&new URL(x.url).searchParams.has('_refresh')));
 const r=await worker.fetch(new Request('https://test/espn/scoreboard?dates=20261107&_refresh=3'),{},ctx);
 assert.equal(r.status,200);assert.equal(new URL(fetches.at(-1).url).searchParams.get('dates'),'20261107');
 console.log('Every explicit refresh bypasses cached lineups/ESPN data and strips market fields');
}finally{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;}
