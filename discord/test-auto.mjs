// Dry-run tests for the auto-post trigger: pure decision logic + runAuto with mocked ESPN/GitHub/KV (no network, no posting).
import { decide, firstTip, runAuto } from './auto.js';
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok', m); };
const ev = (iso, extra = {}) => ({ date: iso, status: { type: { name: 'STATUS_SCHEDULED', ...extra } }, competitions: [{}] });
const slate = [ev('2026-10-30T02:00Z'), ev('2026-10-30T00:00Z'), ev('2026-10-29T23:00Z', { name: 'STATUS_POSTPONED' })];
assert(firstTip(slate).toISOString() === '2026-10-30T00:00:00.000Z', 'first tip ignores postponed game');
assert(firstTip([{ date: '2026-10-30T00:00Z', competitions: [{ timeValid: false }] }]) === null, 'TBD time ignored');
const at = (iso) => new Date(iso);
assert(decide({ now: at('2026-10-29T13:45Z'), events: slate }).action === 'wait', '9:45 AM ET → wait');
assert(decide({ now: at('2026-10-29T23:26Z'), events: slate }).action === 'wait', 'T-34 → wait');
assert(decide({ now: at('2026-10-29T23:27Z'), events: slate }).action === 'dispatch', 'T-33 → dispatch');
assert(decide({ now: at('2026-10-29T23:30Z'), events: slate }).action === 'dispatch', 'T-30 → dispatch');
assert(decide({ now: at('2026-10-29T23:45Z'), events: slate }).action === 'dispatch', 'T-15 (late cron) → dispatch');
assert(decide({ now: at('2026-10-29T23:46Z'), events: slate }).action === 'skip', 'T-14 → window passed');
assert(decide({ now: at('2026-10-29T23:30Z'), events: slate, alreadyPosted: true }).action === 'skip', 'already posted → skip');
assert(decide({ now: at('2026-10-29T23:30Z'), events: [] }).reason.startsWith('no NBA games'), 'no games → skip');
assert(decide({ now: at('2026-10-29T23:30Z'), events: slate, paused: true }).action === 'skip', 'paused → skip');
// ET date boundary: 00:10Z on 10/30 is still 10/29 ET
assert(decide({ now: at('2026-10-30T00:10Z'), events: slate }).date === '2026-10-29', 'ET date used (not UTC)');

// runAuto with mocks
const kv = new Map(); const KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) };
const env = { GITHUB_TOKEN: 'x', GITHUB_REPO: 'o/r', GITHUB_WORKFLOW: 'discord-nba.yml', AUTO_KV: KV, AUTO_POST: 'on' };
const calls = []; const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  u = String(u); calls.push({ u, method: init?.method || 'GET', body: init?.body });
  if (u.includes('espn.com')) return new Response(JSON.stringify({ events: slate }));
  if (u.includes('/runs')) return new Response(JSON.stringify({ workflow_runs: [] }));
  if (u.includes('/dispatches')) return new Response(null, { status: 204 });
  return new Response('nope', { status: 404 });
};
let r = await runAuto(env, { now: at('2026-10-29T23:30Z'), dryRun: true });
assert(r.action === 'dispatch' && r.dryRun && !calls.some((c) => c.u.includes('/dispatches')) && !kv.size, 'dry run: would dispatch, sent nothing, no marker');
r = await runAuto(env, { now: at('2026-10-29T23:30Z') });
const d = calls.find((c) => c.u.includes('/dispatches'));
const inp = JSON.parse(d.body).inputs;
assert(r.dispatched && inp.relay === '' && inp.auto === '1' && inp.date === '2026-10-29', 'live: dispatches once with blank relay + auto=1 (mocked)');
calls.length = 0;
r = await runAuto(env, { now: at('2026-10-29T23:35Z') });
assert(r.action === 'skip' && !calls.some((c) => c.u.includes('/dispatches')), 'second tick same date → deduped by KV');
kv.clear(); globalThis.fetch = async (u, init) => String(u).includes('/runs') ? new Response(JSON.stringify({ workflow_runs: [{ display_title: '/nba 2026-10-29 (auto)', conclusion: null }] })) : String(u).includes('espn') ? new Response(JSON.stringify({ events: slate })) : (calls.push(String(u)), new Response(null, { status: 204 }));
calls.length = 0;
r = await runAuto(env, { now: at('2026-10-29T23:40Z') });
assert(r.action === 'skip' && !calls.length, 'KV lost but GitHub run exists → deduped');
r = await runAuto({ ...env, AUTO_POST: 'off' }, { now: at('2026-10-29T23:30Z') });
assert(r.action === 'skip' && /paused/.test(r.reason), 'AUTO_POST=off → paused');
globalThis.fetch = realFetch;
console.log('auto-post trigger tests passed');
