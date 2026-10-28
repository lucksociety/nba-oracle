#!/usr/bin/env node
// NBA ORACLE V1.2 data builder. Runs in GitHub Actions every 30 min (and locally).
// Sources (all free, public, non-market): ESPN public site API
//   scoreboard  -> schedule + final scores
//   summary     -> box score team & player lines ONLY (odds/pickcenter/ATS/winprobability are discarded unread)
//   injuries    -> availability report
// Firewall: see js/firewall.js. Every output file is scanned by assertNoMarketData before writing.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeScoreboard, sanitizeInjuries, assertNoMarketData } from '../js/firewall.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'cache');
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';

const NBA30 = new Set(['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GS','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NO','NY','OKC','ORL','PHI','PHX','POR','SAC','SA','TOR','UTAH','WSH']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'nba-oracle-data-builder' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw new Error(`${url}: ${e.message}`); await sleep(800 * (i + 1)); }
  }
}
async function readJSON(f, dflt) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return dflt; } }
async function writeJSON(f, obj, pretty = false) {
  assertNoMarketData(obj);
  await fs.writeFile(f, pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj));
}
const etDate = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const ymd = d => d.replaceAll('-', '');

function seasonMonths(season, now) {
  // ESPN season year N = (N-1)-N season. Regular season Oct (N-1) .. Apr N.
  const months = [];
  for (let y = season - 1, m = 10; y < season || (y === season && m <= 4); m++) {
    if (m > 12) { m = 1; y++; }
    const first = new Date(Date.UTC(y, m - 1, 1));
    if (first > now) break;
    months.push(`${y}${String(m).padStart(2, '0')}`);
  }
  return months;
}

const num = s => { const n = Number(s); return Number.isFinite(n) ? n : 0; };
const pair = s => { const [a, b] = String(s || '0-0').split('-').map(num); return [a, b]; };

function parseSummary(sum) {
  // Read ONLY the boxscore + header competitors. Market sections are never touched.
  const box = sum.boxscore || {};
  const teams = {};
  for (const t of box.teams || []) {
    const s = Object.fromEntries((t.statistics || []).map(x => [x.name, x.displayValue]));
    const [fgm, fga] = pair(s['fieldGoalsMade-fieldGoalsAttempted']);
    const [fg3m, fg3a] = pair(s['threePointFieldGoalsMade-threePointFieldGoalsAttempted']);
    const [ftm, fta] = pair(s['freeThrowsMade-freeThrowsAttempted']);
    teams[String(t.team.id)] = [fgm, fga, fg3m, fg3a, ftm, fta, num(s.offensiveRebounds), num(s.defensiveRebounds), num(s.totalTurnovers ?? s.turnovers), num(s.fouls)];
  }
  const players = {};
  for (const tp of box.players || []) {
    const st = tp.statistics?.[0]; if (!st) continue;
    const keys = st.keys || st.names || [];
    const ix = k => keys.indexOf(k);
    const rows = [];
    for (const a of st.athletes || []) {
      if (a.didNotPlay || !a.stats || !a.stats.length) continue;
      const g = k => a.stats[ix(k)];
      const min = num(g('minutes')); if (min <= 0) continue;
      const [fgm, fga] = pair(g('fieldGoalsMade-fieldGoalsAttempted'));
      const [f3m, f3a] = pair(g('threePointFieldGoalsMade-threePointFieldGoalsAttempted'));
      const [ftm, fta] = pair(g('freeThrowsMade-freeThrowsAttempted'));
      rows.push([String(a.athlete.id), a.athlete.displayName, min, num(g('points')), fgm, fga, f3m, f3a, ftm, fta,
        num(g('offensiveRebounds')), num(g('defensiveRebounds')), num(g('assists')), num(g('steals')), num(g('blocks')),
        num(g('turnovers')), num(g('fouls')), num(String(g('plusMinus') || '0').replace('+', '')), a.starter ? 1 : 0]);
    }
    players[String(tp.team.id)] = rows;
  }
  const comp = sum.header?.competitions?.[0] || {};
  const periods = Math.max(4, ...((comp.competitors || []).map(c => (c.linescores || []).length)));
  return { teams, players, periods };
}

async function pool(items, n, fn) {
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function buildSeason(season, now, teamMeta) {
  const cacheFile = path.join(CACHE, `lines-${season}.json`);
  const cache = await readJSON(cacheFile, {});
  const events = [];
  for (const m of seasonMonths(season, now)) {
    const sb = await getJSON(`${BASE}/scoreboard?dates=${m}&limit=500`);
    for (const e of sanitizeScoreboard(sb)) {
      if (!e.home || !e.away || !NBA30.has(e.home.abbr) || !NBA30.has(e.away.abbr)) continue; // excludes All-Star / exhibition teams
      for (const side of ['home', 'away']) if (e[side]) teamMeta[e[side].id] = { abbr: e[side].abbr, name: e[side].name, short: e[side].short, logo: e[side].logo, color: e[side].color, alt: e[side].alt };
      if (e.seasonType === 2 && e.seasonYear === season && e.status.completed && e.status.name === 'STATUS_FINAL') events.push(e);
    }
  }
  const missing = events.filter(e => !cache[e.id]);
  console.log(`season ${season}: ${events.length} final regular-season games, ${missing.length} to fetch`);
  let done = 0;
  await pool(missing, 8, async e => {
    try {
      const sum = await getJSON(`${BASE}/summary?event=${e.id}`);
      const p = parseSummary(sum);
      if (!p.teams[e.home.id] || !p.teams[e.away.id]) return;
      cache[e.id] = { d: etDate(e.date), h: e.home.id, a: e.away.id, hs: e.home.score, as: e.away.score, per: p.periods, n: e.neutral ? 1 : 0, hb: p.teams[e.home.id], ab: p.teams[e.away.id], pl: p.players };
    } catch (err) { console.warn('skip', e.id, err.message); }
    if (++done % 100 === 0) console.log(`  ${done}/${missing.length}`);
  });
  await writeJSON(cacheFile, cache);

  // Compact game lines for the client: [id, etDate, homeId, awayId, hs, as, periods, neutral, homeBox[10], awayBox[10]]
  for (const id of Object.keys(cache)) if (!events.some(e => e.id === id)) delete cache[id];
  await writeJSON(cacheFile, cache);
  const games = Object.entries(cache).map(([id, g]) => [id, g.d, g.h, g.a, g.hs, g.as, g.per, g.n, g.hb, g.ab]).sort((x, y) => x[1].localeCompare(y[1]));
  // Player aggregates per team: [athId, name, gp, min, pts, fgm, fga, f3m, f3a, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pm, starts, lastDate]
  const agg = {}; const teamGames = {};
  for (const [, g] of Object.entries(cache).sort((x, y) => x[1].d.localeCompare(y[1].d))) {
    for (const tid of [g.h, g.a]) teamGames[tid] = (teamGames[tid] || 0) + 1;
    for (const [tid, rows] of Object.entries(g.pl || {})) {
      agg[tid] ||= {};
      for (const r of rows) {
        const a = agg[tid][r[0]] ||= [r[0], r[1], 0, ...Array(17).fill(0), ''];
        a[2] += 1; for (let k = 2; k <= 17; k++) a[k + 1] += r[k]; a[19] += r[18]; a[20] = g.d;
      }
    }
  }
  const players = { season, teamGames, teams: Object.fromEntries(Object.entries(agg).map(([t, m]) => [t, Object.values(m).sort((x, y) => y[3] - x[3])])) };
  await writeJSON(path.join(DATA, `games-${season}.json`), { season, fields: ['id', 'etDate', 'homeId', 'awayId', 'homeScore', 'awayScore', 'periods', 'neutral', 'homeBox', 'awayBox'], boxFields: ['fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta', 'oreb', 'dreb', 'tov', 'pf'], games });
  await writeJSON(path.join(DATA, `players-${season}.json`), { ...players, fields: ['athleteId', 'name', 'gp', 'min', 'pts', 'fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf', 'plusMinus', 'starts', 'lastDate'] });
  return games;
}

// ---- Independent historical calibration (prior season, actual results only) ----
function ridge(X, y, lambda, unpenalized = new Set()) {
  const p = X[0].length; const A = Array.from({ length: p }, () => new Float64Array(p)); const b = new Float64Array(p);
  for (let i = 0; i < X.length; i++) { const x = X[i]; for (let j = 0; j < p; j++) { if (!x[j]) continue; b[j] += x[j] * y[i]; for (let k = 0; k < p; k++) if (x[k]) A[j][k] += x[j] * x[k]; } }
  for (let j = 0; j < p; j++) if (!unpenalized.has(j)) A[j][j] += lambda;
  // Gaussian elimination
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < p; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[p] / r[i]);
}
function calibrate(games) {
  const ids = [...new Set(games.flatMap(g => [g[2], g[3]]))].sort(); const T = ids.length; const ix = Object.fromEntries(ids.map((t, i) => [t, i]));
  const last = {}; const rows = []; const ym = []; const yt = []; const rowsT = [];
  for (const g of games) {
    const [, d, h, a, hs, as, per, n] = g;
    const rest = t => { if (!last[t]) return 3; return Math.round((Date.parse(d) - Date.parse(last[t])) / 864e5) - 1; };
    const bh = rest(h) === 0 ? 1 : 0, ba = rest(a) === 0 ? 1 : 0; last[h] = d; last[a] = d;
    const x = new Array(T + 2).fill(0); x[ix[h]] = 1; x[ix[a]] = -1; x[T] = n ? 0 : 1; x[T + 1] = ba - bh; // +: away on b2b helps home
    rows.push(x); ym.push(hs - as);
    const xt = new Array(2 * T + 1).fill(0); xt[ix[h]] += 1; xt[ix[a]] += 1; xt[T + ix[h]] += 1; xt[T + ix[a]] += 1; xt[2 * T] = 1; rowsT.push(xt); yt.push(hs + as);
  }
  const beta = ridge(rows, ym, 2, new Set([T, T + 1]));
  const resid = rows.map((x, i) => ym[i] - x.reduce((s, v, j) => s + v * beta[j], 0));
  const sd = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const betaT = ridge(rowsT, yt, 2, new Set([2 * T]));
  const residT = rowsT.map((x, i) => yt[i] - x.reduce((s, v, j) => s + v * betaT[j], 0));
  const margins = games.map(g => Math.abs(g[4] - g[5]));
  const kurt = (() => { const m2 = resid.reduce((s, v) => s + v * v, 0) / resid.length; const m4 = resid.reduce((s, v) => s + v ** 4, 0) / resid.length; return m4 / (m2 * m2); })();
  const rate = f => +(games.filter(f).length / games.length).toFixed(4);
  return {
    sampleGames: games.length, method: 'Ridge regression (lambda=2) on prior-season final scores: margin ~ team ratings + home court + back-to-back differential. Fit on in-sample actual results only; no market inputs.',
    homeCourtPts: +beta[T].toFixed(2), backToBackPts: +beta[T + 1].toFixed(2),
    marginResidualSD: +sd(resid).toFixed(2), marginResidualKurtosis: +kurt.toFixed(2), totalResidualSD: +sd(residT).toFixed(2),
    meanTotal: +(yt.reduce((s, v) => s + v, 0) / yt.length).toFixed(1),
    baseRates: { absMarginGE10: rate(g => Math.abs(g[4] - g[5]) >= 10), absMarginGE15: rate(g => Math.abs(g[4] - g[5]) >= 15), absMarginGE20: rate(g => Math.abs(g[4] - g[5]) >= 20), absMarginGE30: rate(g => Math.abs(g[4] - g[5]) >= 30), absMarginLE5: rate(g => Math.abs(g[4] - g[5]) <= 5), overtime: rate(g => g[6] > 4), homeWin: rate(g => g[4] > g[5]) },
    meanAbsMargin: +(margins.reduce((s, v) => s + v, 0) / margins.length).toFixed(2),
  };
}

async function main() {
  await fs.mkdir(CACHE, { recursive: true });
  const now = new Date();
  const cur = now.getUTCMonth() + 1 >= 8 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const prior = cur - 1;
  const teamMeta = await readJSON(path.join(DATA, 'teams.json'), {});
  const meta = await readJSON(path.join(DATA, 'meta.json'), {});
  const priorFile = path.join(DATA, `games-${prior}.json`);
  let priorGames;
  const existing = await readJSON(priorFile, null);
  if (existing && existing.games?.length > 1100 && !process.env.REBUILD_PRIOR) { priorGames = existing.games; console.log(`prior season ${prior}: using committed ${priorGames.length} games`); }
  else priorGames = await buildSeason(prior, now, teamMeta);
  const curGames = await buildSeason(cur, now, teamMeta);
  const cal = calibrate(priorGames);
  await writeJSON(path.join(DATA, 'calibration.json'), { season: prior, ...cal }, true);

  // Snapshot of schedule (yesterday..+3 days) and injuries, sanitized, as a fallback if the live ESPN fetch fails in the browser.
  const today = etDate(now.toISOString());
  const days = [-3, -2, -1, 0, 1, 2, 3].map(k => etDate(new Date(Date.parse(today + 'T12:00:00Z') + k * 864e5).toISOString()));
  const schedule = {};
  for (const d of days) schedule[d] = sanitizeScoreboard(await getJSON(`${BASE}/scoreboard?dates=${ymd(d)}`));
  const injuries = sanitizeInjuries(await getJSON(`${BASE}/injuries`));
  await writeJSON(path.join(DATA, 'snapshot.json'), { fetchedAt: now.toISOString(), schedule, injuries });
  await writeJSON(path.join(DATA, 'teams.json'), teamMeta, true);
  await writeJSON(path.join(DATA, 'meta.json'), { ...meta, builtAt: now.toISOString(), currentSeason: cur, priorSeason: prior, currentGames: curGames.length, priorGames: priorGames.length, source: 'ESPN public site API (scoreboard, summary boxscore, injuries); market fields stripped' }, true);
  console.log('ok', { cur: curGames.length, prior: priorGames.length, cal });
}
main().catch(e => { console.error(e); process.exit(1); });
