import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nba-recovery-'));
const original=globalThis.fetch;
try {
  await fs.mkdir(path.join(folder,'cache'));
  const known={one:{d:'2026-10-21',h:'1',a:'2',hs:110,as:100,per:4,n:0,hb:Array(10).fill(1),ab:Array(10).fill(1),pl:{}}};
  await fs.writeFile(path.join(folder,'cache/lines-2027.json'),JSON.stringify(known));
  process.env.DATA_DIR=folder;
  globalThis.fetch=async()=>Response.json({events:[]});
  const {buildSeason}=await import('../scripts/build-data.mjs');
  const games=await buildSeason(2027,new Date('2026-10-29T12:00Z'),{});
  assert.equal(games.length,1);
  assert.equal(games[0][0],'one');
  assert.equal(JSON.parse(await fs.readFile(path.join(folder,'cache/lines-2027.json'))).one.hs,110);
  console.log('A successful but empty scoreboard cannot erase known final results');
} finally {globalThis.fetch=original;await fs.rm(folder,{recursive:true,force:true});}
