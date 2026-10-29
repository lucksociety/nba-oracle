// Daily auto-post: Cloudflare Cron Trigger (every 5 min) → if now is within the T-30 window before the
// first NBA tipoff of the ET day, dispatch discord-nba.yml once (blank relay = post via DISCORD_WEBHOOK_URL).
// Pure decision logic is exported for tests; no odds are touched here.
import { etYMD } from './dates.js';

export const WINDOW = { startMin: 36, endMin: 15 }; // fire when first tip is 15–36 min away (cron every 5 min → first hit ≈ T-36…T-31; the ~2-4 min workflow run lands the post ≈ T-30)
const SKIP = /postponed|canceled|cancelled|suspended|forfeit/i;

/** First valid tipoff (Date) for ESPN scoreboard events, or null. */
export function firstTip(events = []) {
  const ts = events.filter((e) => {
    const c = e.competitions?.[0] || {};
    const st = e.status?.type || c.status?.type || {};
    if (c.timeValid === false) return false;
    if (SKIP.test(`${st.name || ''} ${st.description || ''} ${st.detail || ''}`)) return false;
    return !Number.isNaN(Date.parse(e.date));
  }).map((e) => Date.parse(e.date));
  return ts.length ? new Date(Math.min(...ts)) : null;
}

/** Decide whether to dispatch. Returns { action: 'dispatch'|'wait'|'skip', reason, date, tip, minsToTip }. */
export function decide({ now = new Date(), events = [], alreadyPosted = false, paused = false } = {}) {
  const date = etYMD(now);
  if (paused) return { action: 'skip', reason: 'paused (AUTO_POST != on)', date };
  const tip = firstTip(events);
  if (!tip) return { action: 'skip', reason: 'no NBA games today (ET)', date };
  const minsToTip = (tip - now) / 60000;
  const base = { date, tip: tip.toISOString(), minsToTip: Math.round(minsToTip * 10) / 10 };
  if (alreadyPosted) return { action: 'skip', reason: 'already posted for this date', ...base };
  if (minsToTip > WINDOW.startMin) return { action: 'wait', reason: `first tip in ${Math.round(minsToTip)} min`, ...base };
  if (minsToTip < WINDOW.endMin) return { action: 'skip', reason: 'window passed', ...base };
  return { action: 'dispatch', reason: 'within T-30 window', ...base };
}

const gh = (env) => ({ Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'nba-oracle-discord', 'X-GitHub-Api-Version': '2022-11-28' });

async function postedViaGithub(env, date) {
  // Second dedupe layer: any auto run for this date already dispatched today?
  const since = new Date(Date.now() - 20 * 3600e3).toISOString();
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/runs?event=workflow_dispatch&per_page=30&created=%3E%3D${since}`, { headers: gh(env) });
  if (!r.ok) return false;
  const j = await r.json();
  return (j.workflow_runs || []).some((w) => String(w.display_title || '').includes(`${date} (auto)`) && w.conclusion !== 'failure' && w.conclusion !== 'cancelled');
}

/** Scheduled handler. opts.dryRun → never dispatches, never writes the marker. */
export async function runAuto(env, { now = new Date(), dryRun = false } = {}) {
  const date = etYMD(now);
  const ymd = date.replace(/-/g, '');
  const paused = String(env.AUTO_POST || 'on').toLowerCase() !== 'on';
  let events = [];
  if (!paused) {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ymd}`, { headers: { 'User-Agent': 'nba-oracle-discord' } });
    if (!r.ok) return { action: 'error', reason: `ESPN ${r.status}`, date };
    events = (await r.json()).events || [];
  }
  const key = `auto-posted:${date}`;
  let alreadyPosted = env.AUTO_KV ? Boolean(await env.AUTO_KV.get(key)) : false;
  let d = decide({ now, events, alreadyPosted, paused });
  if (d.action === 'dispatch' && env.GITHUB_TOKEN && await postedViaGithub(env, date)) d = { ...d, action: 'skip', reason: 'already posted (GitHub run found)' };
  if (d.action !== 'dispatch' || dryRun) return { ...d, dryRun };
  if (env.AUTO_KV) await env.AUTO_KV.put(key, new Date().toISOString(), { expirationTtl: 3 * 86400 });
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
    method: 'POST', headers: gh(env),
    body: JSON.stringify({ ref: env.GITHUB_REF || 'main', inputs: { date, relay: '', sims: String(env.SIMS || '300000'), auto: '1' } }),
  });
  if (!r.ok) { if (env.AUTO_KV) await env.AUTO_KV.delete(key); return { ...d, action: 'error', reason: `dispatch ${r.status}` }; }
  return { ...d, dispatched: true };
}
