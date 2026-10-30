// Starting lineups (protocol Section 2). Source: NBA.com official daily lineups — "Expected" lineups are posted
// pregame and flip to "Confirmed" (with the full active/inactive list) once teams submit them. Nothing here is
// invented: if the official file has no entry for a team, the team is UNCERTAIN and injuries are used unchanged.
import { PRIORS } from './engine.js'; // used at call time only (safe module cycle)

export const NBA_LINEUPS_URL = (ymd) => `https://stats.nba.com/js/data/leaders/00_daily_lineups_${ymd.replaceAll('-', '')}.json`;
// NBA.com abbreviations -> ESPN abbreviations used by the rest of the model
const NBA2ESPN = { GSW: 'GS', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', NOP: 'NO', WAS: 'WSH', PHO: 'PHX' };
export const espnAbbr = (a) => NBA2ESPN[a] || a;
export const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');

/** NBA.com timestamps are US-Eastern wall-clock without an offset; convert to an ISO instant. */
export function etWallToISO(ts) {
  if (!ts) return null;
  const guess = new Date(ts + 'Z'); // as if UTC, then correct by the ET offset at that moment
  const etStr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(guess);
  const [, mo, d, y, h, mi, s] = etStr.match(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/);
  const asET = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return new Date(guess.getTime() + (guess.getTime() - asET)).toISOString();
}

function teamLineup(t) {
  if (!t || !t.players?.length) return { status: 'NONE', starters: [], active: [], inactive: [], updatedAt: null };
  const st = t.players.some(p => /confirmed/i.test(p.lineupStatus || '')) ? 'CONFIRMED' : t.players.some(p => /expected/i.test(p.lineupStatus || '')) ? 'EXPECTED' : 'NONE';
  const ts = t.players.map(p => p.timestamp).filter(Boolean).sort().pop() || null;
  return {
    status: st, nbaAbbr: t.abbr,
    starters: t.players.filter(p => p.pos).map(p => ({ name: p.name, pos: p.pos })),
    active: t.players.filter(p => /active/i.test(p.rosterStatus || '') && !/inactive/i.test(p.rosterStatus || '')).map(p => p.name),
    inactive: t.players.filter(p => /inactive/i.test(p.rosterStatus || '')).map(p => p.name),
    fullList: st === 'CONFIRMED' && t.players.length >= 10,
    updatedAt: etWallToISO(ts),
  };
}

/** Find the official lineup entry for an ESPN event (by team abbreviations). */
export function lineupsForEvent(lineups, ev) {
  const none = { status: 'NONE', starters: [], active: [], inactive: [], updatedAt: null };
  const g = (lineups?.games || []).find(x => espnAbbr(x.home?.abbr) === ev.home.abbr && espnAbbr(x.away?.abbr) === ev.away.abbr);
  const src = lineups?.source || 'NBA.com official daily lineups';
  if (!g) return { home: { ...none, source: src }, away: { ...none, source: src }, found: false };
  return { home: { ...teamLineup(g.home), source: src, fetchedAt: lineups.fetchedAt }, away: { ...teamLineup(g.away), source: src, fetchedAt: lineups.fetchedAt }, found: true };
}

/**
 * Override injury-report availability with the official lineup (never the reverse):
 *  CONFIRMED starter -> P(play)=1 · CONFIRMED Inactive -> 0 · CONFIRMED full list, player absent -> 0
 *  CONFIRMED active (bench) -> max(report, 'available'). EXPECTED starters cannot override explicit game-status tags.
 * Also adds rotation regulars (≥20 mpg this season) who are officially INACTIVE but not on the injury report
 * (rest days / late scratches), so their absence flows through the existing player-impact redistribution.
 */
export function applyLineup(injList, tl, teamRows) {
  const A = PRIORS.availability; const list = (injList || []).map(x => ({ ...x }));
  if (!tl || tl.status === 'NONE') return list;
  const starters = new Set(tl.starters.map(s => normName(s.name))), inactive = new Set(tl.inactive.map(normName)), active = new Set(tl.active.map(normName));
  for (const inj of list) {
    const n = normName(inj.name);
    if (tl.status === 'CONFIRMED') {
      // A late injury update can supersede an earlier confirmed lineup.
      const reportAt = Date.parse(inj.date), lineupAt = Date.parse(tl.updatedAt);
      if (Number.isFinite(reportAt) && Number.isFinite(lineupAt) && reportAt > lineupAt && !inactive.has(n)) continue;
      if (starters.has(n)) inj.override = { p: 1, label: 'STARTING (confirmed)', basis: 'Official NBA.com lineup: confirmed starter' };
      else if (inactive.has(n)) inj.override = { p: 0, label: 'INACTIVE (official)', basis: 'Official NBA.com lineup: inactive' };
      else if (active.has(n)) inj.override = { p: A.available, floor: true, label: 'ACTIVE (official list)', basis: 'Official NBA.com lineup: active, not starting' };
      else if (tl.fullList) inj.override = { p: 0, label: 'NOT ON ACTIVE LIST', basis: 'Absent from the official confirmed active/inactive list' };
    } else if (tl.status === 'EXPECTED' && starters.has(n)) inj.override = { p: A.probable, floor: true, label: 'EXPECTED STARTER', basis: 'Official NBA.com lineup: expected (not yet confirmed) starter' };
  }
  if (tl.status === 'CONFIRMED') {
    const listed = new Set(list.map(x => normName(x.name)));
    for (const r of teamRows || []) {
      const n = normName(r[1]); const mpg = r[3] / Math.max(1, r[2]);
      if (listed.has(n) || r[2] < 3 || mpg < 20 || !inactive.has(n)) continue;
      list.push({ athleteId: r[0], name: r[1], status: 'Inactive', comment: '', fromLineup: true, override: { p: 0, label: 'INACTIVE (official, not on injury report)', basis: 'Official NBA.com lineup: inactive' } });
    }
  }
  return list;
}

/** Game-level lineup status per protocol Section 2. */
export function gameLineupStatus(lu) {
  if (!lu) return null;
  if (lu.home.status === 'CONFIRMED' && lu.away.status === 'CONFIRMED') return 'CONFIRMED';
  if (lu.home.status !== 'NONE' && lu.away.status !== 'NONE') return 'PROBABLE';
  return 'UNCERTAIN';
}
