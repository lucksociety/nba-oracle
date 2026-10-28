// NBA Oracle — Discord interactions endpoint (Cloudflare Worker).
// 1. Verifies Discord's Ed25519 request signature (DISCORD_PUBLIC_KEY).
// 2. Answers PING; for /nba replies immediately with a deferred "thinking…" response (type 5).
// 3. Triggers the GitHub Actions workflow `discord-nba.yml` (Node: 300k-sim NBA ORACLE V1.2 → freeze → Jupiter
//    comparison → posts to this interaction's follow-up webhook). The interaction token is relayed AES-GCM
//    encrypted (RELAY_KEY) because workflow inputs in a public repo are not secret.
// The Worker itself runs no simulation (Workers CPU limits) and never touches odds.

import { dateChoices, parseDateOption } from './dates.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const hex = (h) => new Uint8Array(h.match(/.{2}/g).map((b) => parseInt(b, 16)));
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function verify(req, body, publicKey) {
  const sig = req.headers.get('X-Signature-Ed25519'), ts = req.headers.get('X-Signature-Timestamp');
  if (!sig || !ts || !/^[0-9a-f]+$/i.test(sig)) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hex(sig), new TextEncoder().encode(ts + body));
  } catch { return false; }
}

async function encryptRelay(obj, secret) {
  const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return b64url(out);
}

async function editOriginal(env, token, content) {
  await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
}

async function dispatch(env, interaction) {
  const date = interaction.resolvedDate; // validated YYYY-MM-DD (ET), today when omitted
  const user = interaction.member?.user?.username || interaction.user?.username || '';
  const relay = await encryptRelay({ token: interaction.token, ts: Date.now(), user }, env.RELAY_KEY);
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'nba-oracle-discord', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'main', inputs: { date, relay, sims: String(env.SIMS || '300000') } }),
  });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 150);
    await editOriginal(env, interaction.token, `⚠️ Could not start the NBA Oracle run (GitHub ${r.status}). ${t}`);
    return;
  }
  await editOriginal(env, interaction.token, `🏀 Running NBA ORACLE V1.2 for ${date}${date === parseDateOption('today') ? ' (today, ET)' : ''} — ${Number(env.SIMS || 300000).toLocaleString('en-US')} simulations per game, then comparing to Jupiter. Results in ~1–2 min…`);
}

// ---- Read-only ESPN proxy for the GitHub Pages dashboard (schedule + injuries only) ----
// ESPN can refuse browser requests from github.io; this proxies just two basketball endpoints, deletes every
// market-like field before the response leaves the Worker (the page's firewall strips again), and caches 60 s.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const MARKET_RE = /odds|pickcenter|againstthespread|winprob|predictor|spread|overunder|moneyline|betting|^bets$|^tickets$|powerindex|^fpi$|matchupquality|gameprojection|sportsbook|^lines?$/i;
function strip(o, d = 0) {
  if (!o || typeof o !== 'object' || d > 14) return o;
  if (Array.isArray(o)) { o.forEach((x) => strip(x, d + 1)); return o; }
  for (const k of Object.keys(o)) { if (MARKET_RE.test(k)) delete o[k]; else strip(o[k], d + 1); }
  return o;
}
async function espnProxy(url, ctx) {
  const path = url.pathname.slice('/espn/'.length);
  const dates = url.searchParams.get('dates');
  let target;
  if (path === 'scoreboard' && (!dates || /^\d{8}$/.test(dates))) target = `${ESPN}/scoreboard${dates ? `?dates=${dates}` : ''}`;
  else if (path === 'injuries') target = `${ESPN}/injuries`;
  else return new Response('not found', { status: 404, headers: CORS });
  const cache = caches.default; const key = new Request(target);
  let hit = await cache.match(key);
  if (!hit) {
    const r = await fetch(target, { headers: { 'User-Agent': 'nba-oracle-proxy' } });
    if (!r.ok) return new Response(`upstream ${r.status}`, { status: 502, headers: CORS });
    const body = JSON.stringify(strip(await r.json()));
    hit = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
    ctx.waitUntil(cache.put(key, hit.clone()));
  }
  return new Response(hit.body, { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Market-Fields': 'stripped' } });
}

// NBA.com official daily starting lineups (no CORS upstream). Basketball data only; still key-scanned and cached 60 s.
async function lineupsProxy(url, ctx) {
  const ymd = url.pathname.slice('/nba/lineups/'.length);
  if (!/^\d{8}$/.test(ymd)) return new Response('bad date', { status: 400, headers: CORS });
  const target = `https://stats.nba.com/js/data/leaders/00_daily_lineups_${ymd}.json`;
  const cache = caches.default; const key = new Request(target);
  let hit = await cache.match(key);
  if (!hit) {
    const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (nba-oracle-proxy)', Referer: 'https://www.nba.com/', Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(8000) }).catch(e => new Response(null, { status: 504 }));
    if (r.status !== 200) return new Response(`upstream ${r.status} (lineups not posted for this date or source unavailable)`, { status: [301, 302, 403, 404].includes(r.status) ? 404 : 502, headers: CORS });
    let data; try { data = await r.json(); } catch { return new Response('upstream returned non-JSON', { status: 502, headers: CORS }); }
    const body = JSON.stringify(strip(data));
    hit = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
    ctx.waitUntil(cache.put(key, hit.clone()));
  }
  return new Response(hit.body, { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method === 'GET' && url.pathname.startsWith('/espn/')) return espnProxy(url, ctx);
    if (req.method === 'GET' && url.pathname.startsWith('/nba/lineups/')) return lineupsProxy(url, ctx);
    if (req.method === 'GET') return new Response('NBA Oracle Discord interactions endpoint: OK\n', { headers: { 'Content-Type': 'text/plain' } });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const body = await req.text();
    if (!(await verify(req, body, env.DISCORD_PUBLIC_KEY))) return new Response('invalid request signature', { status: 401 });
    const i = JSON.parse(body);
    if (i.type === 1) return json({ type: 1 }); // PING
    // Channel lock: Discord's per-channel command permissions don't bind server owners/admins, so enforce here.
    const allowed = String(env.ALLOWED_CHANNEL_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
    const inAllowed = !allowed.length || allowed.includes(String(i.channel_id || i.channel?.id || ''));
    if (i.type === 4 && i.data?.name === 'nba') { // APPLICATION_COMMAND_AUTOCOMPLETE for the date option
      const focused = (i.data.options || []).find((o) => o.focused);
      return json({ type: 8, data: { choices: inAllowed ? dateChoices(focused?.value || '') : [] } });
    }
    if (i.type === 2 && i.data?.name === 'nba' && !inAllowed) {
      return json({ type: 4, data: { content: `Use /nba in ${allowed.map((c) => `<#${c}>`).join(' or ')}.`, flags: 64, allowed_mentions: { parse: [] } } });
    }
    if (i.type === 2 && i.data?.name === 'nba') {
      const raw = (i.data.options || []).find((o) => o.name === 'date')?.value;
      const resolved = parseDateOption(raw);
      if (!resolved) return json({ type: 4, data: { content: `⚠️ Couldn't read the date "${String(raw).slice(0, 40)}". Pick Today/Tomorrow from the list, or type YYYY-MM-DD.`, flags: 64 } });
      i.resolvedDate = resolved;
      if (!env.GITHUB_TOKEN || !env.RELAY_KEY) return json({ type: 4, data: { content: '⚠️ NBA Oracle is not fully configured (missing GITHUB_TOKEN / RELAY_KEY secret).' } });
      ctx.waitUntil(dispatch(env, i));
      return json({ type: 5 }); // deferred: "NBA Oracle is thinking…"
    }
    return json({ type: 4, data: { content: 'Unknown command', flags: 64 } });
  },
};
