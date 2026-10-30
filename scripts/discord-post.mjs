#!/usr/bin/env node
// STAGE 3 — format frozen predictions + post-freeze Jupiter comparison for Discord and deliver them.
// Delivery: (1) interaction follow-up webhook (edits the deferred "thinking…" reply, then follow-ups) when an
// interaction token is supplied; (2) otherwise, or if the interaction token fails/expires (15 min), the channel
// webhook in DISCORD_WEBHOOK_URL. DRY_RUN=1 prints the payloads instead of sending.
import fs from 'node:fs/promises';
import { RULES } from '../js/markets-jupiter.js';

const ROOT = new URL('../', import.meta.url);
const pred = JSON.parse(await fs.readFile(new URL('out/predictions.json', ROOT), 'utf8'));
const sha = (await fs.readFile(new URL('out/predictions.sha256', ROOT), 'utf8')).trim();
let bets = null; try { bets = JSON.parse(await fs.readFile(new URL('out/bets.json', ROOT), 'utf8')); } catch { /* comparison stage failed */ }
if (bets && bets.predictionsSha256 !== sha) throw new Error('bets.json does not belong to these frozen predictions');

const pct = (x) => (x * 100).toFixed(1) + '%';
const c = (x) => (x * 100).toFixed(1) + '¢';
const tipET = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) + ' ET';
const betOf = (g) => bets?.games.find(b => b.gameId === g.id);
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const dash = '—';
const venueTxt = (v) => (v ? `${c(v.ask)}+${c(v.fee)} fee → edge ${v.edge >= 0 ? '+' : ''}${(v.edge * 100).toFixed(1)}` : 'n/a');

export function buildMessages() {
  const msgs = [];
  const n = pred.games.length;
  const recs = pred.games.filter(g => betOf(g)?.best).length;
  const etHM = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const luSrc = (pred.sources || []).find(x => /Starting lineups/.test(x.what));
  // ---- message 1: header + slate table
  const rows = pred.games.map(g => {
    const b = betOf(g); const fav = g.homeWin >= 0.5 ? g.home.abbr : g.away.abbr;
    const pick = b?.best ? b.best.label : 'NO BET';
    return `${(g.away.abbr + ' ' + g.final.away + '-' + g.final.home + ' ' + g.home.abbr).padEnd(16)} ${(fav + ' ' + pct(Math.max(g.homeWin, g.awayWin))).padEnd(11)} ${('T ' + g.expTotal.toFixed(1)).padEnd(8)} ${pick}`;
  });
  let head = `🏀 **${pred.modelVersion || "NBA ORACLE"} — ${pred.date}** · ${n} game${n === 1 ? '' : 's'} · ${pred.sims.toLocaleString('en-US')} sims/game · ${recs} bet${recs === 1 ? '' : 's'} recommended\n`;
  if (process.env.AUTO_RUN === '1') head += `⏰ Auto-run: 30 min before first tip\n`;
  head += `Predictions frozen ${new Date(pred.cutoff).toISOString().slice(11, 16)} UTC (sha256 \`${sha.slice(0, 12)}\`) **before** any Jupiter/Polymarket price was fetched.\n`;
  if (!n) head += `No modelled NBA games on ${pred.date}.` + (pred.skipped.length ? ' Skipped: ' + pred.skipped.map(s => `${s.game} (${s.reason})`).join('; ') : '');
  else head += '```\n' + 'Prediction       Winner %    Total    Best bet\n' + rows.join('\n') + '\n```';
  if (bets?.jupiterError) head += `\n⚠️ Jupiter unavailable (${short(bets.jupiterError, 120)}) — Polymarket prices used as fallback.`;
  if (bets?.polymarketError) head += `\n⚠️ Polymarket data incomplete (${short(bets.polymarketError, 120)}).`;
  if (!bets) head += '\n⚠️ Market comparison stage did not run; predictions only.';
  if (luSrc) head += `\nLineups: ${short(luSrc.src, 220)}`;
  msgs.push({ content: short(head, 2000) });

  // ---- per-game embeds (≤5 per message to stay far below Discord's 6000-char / 10-embed limits)
  const embeds = pred.games.map(g => {
    const b = betOf(g); const fav = g.homeWin >= 0.5 ? g.home : g.away;
    const mFav = Math.abs(g.expMarginHome);
    let d = `**${g.away.abbr} ${g.final.away} – ${g.home.abbr} ${g.final.home}**  ·  ${fav.abbr} win ${pct(Math.max(g.homeWin, g.awayWin))}\n`;
    d += `Exp. margin ${fav.abbr} ${mFav.toFixed(1)} · total ${g.expTotal.toFixed(1)} (80%: ${g.iTotal[0].toFixed(0)}–${g.iTotal[1].toFixed(0)}) · OT ${pct(g.otProb)}\n`;
    d += `Confidence **${g.confidence}** · lineups **${g.lineupStatus}**\n`;
    if (g.lineups) for (const k of ['away', 'home']) {
      const L = g.lineups[k]; const tag = { CONFIRMED: '✅ confirmed', EXPECTED: '🕒 expected', NONE: '❔ not posted' }[L.status] || L.status;
      d += `${g[k].abbr} ${tag}: ${L.starters.length ? L.starters.map(p => p.name.split(' ').slice(1).join(' ') || p.name).join(', ') : '—'}${L.updatedAt ? ` (${etHM(L.updatedAt)} ET)` : ''}\n`;
    }
    const ovr = ['away', 'home'].flatMap(k => (g.availability?.[k] || []).filter(p => p.lineupOverride).map(p => `${p.name} → ${p.label}`));
    if (ovr.length) d += `Lineup overrides: ${short(ovr.join('; '), 200)}\n`;
    if (b?.best) {
      const x = b.best;
      d += `\n✅ **BEST BET: ${x.label}** @ ${c(x.ask)} — price from **${x.venue}**${x.venue !== 'Jupiter' ? ' (Jupiter quote unavailable; check Jupiter before betting)' : ''}\nModel ${pct(x.modelProb)} vs cost ${c(x.cost)} (price ${c(x.ask)} + fee ${c(x.fee)}) → **edge +${(x.edge * 100).toFixed(1)} pts**, EV ${x.roi >= 0 ? '+' : ''}${(x.roi * 100).toFixed(0)}%/$` + (x.depth != null ? ` · CLOB depth ~${Math.round(x.depth)} contracts` : '');
      d += `\nJupiter ${venueTxt(x.jupiter)} · Polymarket ${venueTxt(x.polymarket)}`;
      if (x.edge > RULES.maxEdge) d += `\n⚠️ Very large disagreement with the market — more often a model blind spot (late news, roster change) than free money. Verify injuries first.`;
    } else d += `\n⛔ **NO BET** — ${b ? short(b.noBetReason || 'requirements not met', 220) : 'comparison unavailable'}`;
    const others = (b?.alternatives || []).slice(0, 3);
    if (others.length) d += `\nNext best: ` + others.map(x => `${x.label} ${pct(x.modelProb)} vs ${c(x.cost)} (${x.edge >= 0 ? '+' : ''}${(x.edge * 100).toFixed(1)}${x.qualifies ? '' : ', fails filters'})`).join(' · ');
    if (b?.coverage) d += `\nLines checked: ${b.coverage.evaluated} (ML ${b.coverage.moneyline} · ${b.coverage.spreadLines} spread mkts × 2 sides · ${b.coverage.totalLines} totals × O/U)`;
    d += `\n_Key factor: ${short(g.keyFactors[0] || dash, 120)}_`;
    return { title: `${g.away.name} @ ${g.home.name} · ${tipET(g.tip)}${g.status.state !== 'pre' ? ' · ' + (g.status.detail || g.status.state) : ''}`.slice(0, 250),
      description: short(d, 1500), color: b?.best ? 0x2ecc71 : 0x7f8c8d,
      footer: { text: `${g.sims.toLocaleString('en-US')} sims · seed ${g.seed} · ±${g.convergence.seHomeWinPct.toFixed(2)} pts SE` } };
  });
  for (let i = 0; i < embeds.length; i += 5) msgs.push({ embeds: embeds.slice(i, i + 5) });

  // ---- final: copy list + rules
  if (n) {
    let tail = '**Copy list (Google Sheets)**\n```\n' + pred.games.map(g => g.sheetLine).join('\n') + '\n```\n';
    tail += `Rules: every moneyline, alternate spread (both sides) and alternate total (over/under) is checked; a bet is recommended only if model probability > 50% **and** edge after fees is between ${RULES.minEdge * 100} and ${RULES.maxEdge * 100} pts (bigger edges are treated as model error — in the backtest they won at the market's rate, not the model's) at a price ≤ ${Math.round(RULES.maxPrice * 100)}¢, one bet per game, and no other line backing the same side/direction showing > ${RULES.maxEdge * 100} pts (that signals missing news, not value), with a two-sided quote (≤10¢ wide) and ≥10 contracts within 1¢ of the ask on the Polymarket order book; otherwise NO BET. Edge uses Jupiter's price + fee (0.07·p·(1−p)/contract) since bets are placed on Jupiter; Polymarket (NBA games currently 0% fee) is shown for comparison and used only if Jupiter has no quote.\n`;
    tail += `Model V1.3: walk-forward backtested (2024-25 tune, 2025-26/2026-27 test); no betting rule showed a reliable profit vs Polymarket prices — size small. Odds never enter the model — they are compared only after the forecast is frozen. Not financial advice.`;
    msgs.push({ content: short(tail, 2000) });
  }
  return msgs.map(m => ({ ...m, allowed_mentions: { parse: [] } }));
}

async function send(url, method, payload) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (r.ok) return true;
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await new Promise(res => setTimeout(res, 1000 * (j.retry_after || 1) + 200)); continue; }
    const t = await r.text(); throw new Error(`Discord ${method} -> ${r.status}: ${t.slice(0, 200)}`);
  }
  throw new Error('Discord rate limited');
}

const msgs = buildMessages();
if (process.env.DRY_RUN) { for (const m of msgs) console.log(JSON.stringify(m, null, 1)); process.exit(0); }
const appId = process.env.DISCORD_APPLICATION_ID, itok = process.env.INTERACTION_TOKEN, hook = process.env.DISCORD_WEBHOOK_URL;
let delivered = false;
if (appId && itok) {
  try {
    const base = `https://discord.com/api/v10/webhooks/${appId}/${itok}`;
    await send(`${base}/messages/@original`, 'PATCH', msgs[0]);
    for (const m of msgs.slice(1)) await send(base, 'POST', m);
    delivered = true; console.log(`[discord] delivered ${msgs.length} message(s) via interaction follow-up`);
  } catch (e) { console.log(`[discord] interaction delivery failed (${e.message}); falling back to channel webhook`); }
}
if (!delivered) {
  if (!hook) throw new Error('No delivery route: interaction token missing/expired and DISCORD_WEBHOOK_URL not set');
  for (const m of msgs) await send(hook + (hook.includes('?') ? '&' : '?') + 'wait=true', 'POST', { ...m, username: 'NBA Oracle' });
  console.log(`[discord] delivered ${msgs.length} message(s) via channel webhook`);
}
