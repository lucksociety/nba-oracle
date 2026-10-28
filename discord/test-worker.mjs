// Local handler test: signs requests with a throwaway Ed25519 key and calls the Worker's fetch() directly.
import worker from './worker.js';
import { webcrypto as wc } from 'node:crypto';
globalThis.caches ??= { default: { match: async () => null, put: async () => {} } };
const kp = await wc.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pub = Buffer.from(await wc.subtle.exportKey('raw', kp.publicKey)).toString('hex');
const env = { DISCORD_PUBLIC_KEY: pub, DISCORD_APPLICATION_ID: 'test', GITHUB_TOKEN: 'x', RELAY_KEY: 'k', ALLOWED_CHANNEL_ID: '111, 222' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
async function call(obj, sign = true) {
  const body = JSON.stringify(obj), ts = String(Math.floor(Date.now() / 1000));
  const sig = Buffer.from(await wc.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(ts + body))).toString('hex');
  const r = await worker.fetch(new Request('https://x/', { method: 'POST', body, headers: sign ? { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts } : {} }), env, ctx);
  return { status: r.status, body: await r.text() };
}
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok', m); };
assert((await call({ type: 1 }, false)).status === 401, 'unsigned -> 401');
assert(JSON.parse((await call({ type: 1 })).body).type === 1, 'PING -> PONG');
let r = JSON.parse((await call({ type: 4, channel_id: '111', data: { name: 'nba', options: [{ type: 3, name: 'date', value: '', focused: true }] } })).body);
assert(r.type === 8 && r.data.choices.length === 7 && /^Today \(/.test(r.data.choices[0].name) && /^Tomorrow \(/.test(r.data.choices[1].name), 'autocomplete empty -> Today, Tomorrow, +5 days');
console.log(r.data.choices);
r = JSON.parse((await call({ type: 4, channel_id: '111', data: { name: 'nba', options: [{ type: 3, name: 'date', value: 'tom', focused: true }] } })).body);
assert(r.data.choices.length === 1 && r.data.choices[0].name.startsWith('Tomorrow'), 'autocomplete "tom" -> Tomorrow');
r = JSON.parse((await call({ type: 2, token: 't', channel_id: '111', data: { name: 'nba', options: [{ type: 3, name: 'date', value: 'nonsense' }] } })).body);
assert(r.type === 4 && r.data.flags === 64, 'invalid typed date -> ephemeral error, no dispatch');
const realFetch = globalThis.fetch; const sent = [];
globalThis.fetch = async (u, init) => { sent.push({ u: String(u), body: init?.body }); return new Response(null, { status: 204 }); };
r = JSON.parse((await call({ type: 2, token: 't', channel_id: '111', member: { user: { username: 'u' } }, data: { name: 'nba', options: [{ type: 3, name: 'date', value: 'tomorrow' }] } })).body);
await Promise.all(waits);
globalThis.fetch = realFetch;
const disp = sent.find((s) => s.u.includes('/dispatches'));
assert(r.type === 5 && disp && JSON.parse(disp.body).inputs.date.match(/^\d{4}-\d{2}-\d{2}$/), `"tomorrow" -> deferred + dispatch date ${disp && JSON.parse(disp.body).inputs.date}`);
r = JSON.parse((await call({ type: 2, token: 't', channel_id: '111', data: { name: 'nba' } })).body);
assert(r.type === 5, 'omitted date -> deferred (today)');
// channel lock
{
  await Promise.allSettled(waits); waits.length = 0; const rf = globalThis.fetch; const sent2 = [];
  globalThis.fetch = async (u, init) => { sent2.push(String(u)); return new Response(null, { status: 204 }); };
  let x = JSON.parse((await call({ type: 2, token: 't', channel_id: '999', data: { name: 'nba' } })).body);
  await Promise.all(waits);
  assert(x.type === 4 && x.data.flags === 64 && x.data.content === 'Use /nba in <#111> or <#222>.' && !sent2.length, 'other channel -> ephemeral redirect, no dispatch');
  x = JSON.parse((await call({ type: 4, channel_id: '999', data: { name: 'nba', options: [{ type: 3, name: 'date', value: '', focused: true }] } })).body);
  assert(x.type === 8 && x.data.choices.length === 0, 'other channel autocomplete -> no choices');
  x = JSON.parse((await call({ type: 2, token: 't', channel_id: '222', data: { name: 'nba' } })).body);
  await Promise.all(waits); globalThis.fetch = rf;
  assert(x.type === 5 && sent2.some((u) => u.includes('/dispatches')), 'allowed channel (2nd in list) -> deferred + dispatch');
}
console.log('worker handler tests passed');
