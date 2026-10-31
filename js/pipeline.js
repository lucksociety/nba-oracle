// Orchestration shared by the browser app and the Node end-to-end test.
import { sanitizeScoreboard, sanitizeInjuries, sanitizeLineups, assertNoMarketData } from './firewall.js';
import { NBA_LINEUPS_URL } from './lineups.js';
import { buildModel, prepareGame, replacementRates, MODEL_VERSION } from './engine.js';

export const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
export const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const shiftDate = (d, k) => new Date(Date.parse(d + 'T12:00:00Z') + k * 864e5).toISOString().slice(0, 10);
const etDateOf = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** Load repo data (built by GitHub Actions) + live ESPN schedule/injuries (falls back to repo snapshot). */
/** espnSources: ordered list of {base, label}; the first that answers wins (e.g. Worker proxy, then direct ESPN). */
async function getLive(getJSON, espnSources, path) {
  let lastErr;
  for (const s of espnSources) { try { return { raw: await getJSON(`${s.base}/${path}`), label: s.label }; } catch (e) { lastErr = e; } }
  throw lastErr || new Error('no live source');
}
/** lineupSources: ordered list of {url: ymd => url, label} for NBA.com's official daily lineups file. */
export const DIRECT_LINEUPS = [{ url: NBA_LINEUPS_URL, label: 'stats.nba.com (direct)' }];
export async function loadInputs(date, getJSON, dataBase, espnSources = [{ base: ESPN, label: 'ESPN (live)' }], lineupSources = DIRECT_LINEUPS) {
  const bust = `?t=${Date.now()}`;
  const [meta, cal, teams, snapshot] = await Promise.all(['meta', 'calibration', 'teams', 'snapshot'].map(f => getJSON(`${dataBase}/${f}.json${bust}`)));
  const [gamesCurrent, gamesPrior, playersCurrent, playersPrior] = await Promise.all([
    `games-${meta.currentSeason}`, `games-${meta.priorSeason}`, `players-${meta.currentSeason}`, `players-${meta.priorSeason}`].map(f => getJSON(`${dataBase}/${f}.json${bust}`)));
  const sources = []; const schedule = {}; let injuries = null; let live = true;
  for (const k of [0, -1, -2, -3]) {
    const d = shiftDate(date, k);
    try {
      const { raw, label } = await getLive(getJSON, espnSources, `scoreboard?dates=${d.replaceAll('-', '')}`);
      schedule[d] = sanitizeScoreboard(raw); // odds etc. stripped here, unread
      if (k === 0) sources.push({ what: `Schedule ${d}`, src: `ESPN scoreboard — ${label}`, at: new Date().toISOString() });
    } catch (e) {
      live = false;
      schedule[d] = snapshot.schedule[d] || [];
      if (k === 0) sources.push({ what: `Schedule ${d}`, src: `Repo snapshot, refreshed ~every 30 min by GitHub Actions (live fetch failed: ${e.message})`, at: snapshot.fetchedAt });
    }
  }
  try { const { raw, label } = await getLive(getJSON, espnSources, 'injuries'); injuries = sanitizeInjuries(raw); sources.push({ what: 'Injury report', src: `ESPN injuries — ${label}`, at: injuries.timestamp || new Date().toISOString() }); }
  catch (e) { injuries = snapshot.injuries; sources.push({ what: 'Injury report', src: `Repo snapshot, refreshed ~every 30 min (live fetch failed: ${e.message})`, at: snapshot.injuries?.timestamp || snapshot.fetchedAt }); }
  // Official starting lineups for the requested date (only used when the injury report is applied, i.e. today/future).
  let lineups = null;
  if (date >= etToday()) {
    const ymd = date.replaceAll('-', ''); const errs = [];
    for (const s of lineupSources) {
      try { const raw = await getJSON(s.url(ymd)); lineups = sanitizeLineups(raw); lineups.source = `NBA.com official daily lineups — ${s.label}`; break; }
      catch (e) { errs.push(`${s.label}: ${e.message}`); }
    }
    if (!lineups && snapshot.lineups?.date === date) { lineups = snapshot.lineups.data; lineups.source = 'NBA.com official daily lineups — repo snapshot (~30 min)'; }
    if (lineups) {
      const st = lineups.games.flatMap(g => [g.home, g.away]).filter(Boolean).map(t => t.players.some(p => /confirmed/i.test(p.lineupStatus || '')) ? 'C' : t.players.length ? 'E' : 'N');
      const ts = lineups.games.flatMap(g => [g.home, g.away]).flatMap(t => t?.players || []).map(p => p.timestamp).filter(Boolean).sort().pop();
      sources.push({ what: `Starting lineups ${date}`, src: `${lineups.source}: ${st.filter(x => x === 'C').length} teams confirmed, ${st.filter(x => x === 'E').length} expected, ${st.filter(x => x === 'N').length} none (latest NBA.com update ${ts || 'n/a'} ET)`, at: lineups.fetchedAt });
    } else sources.push({ what: `Starting lineups ${date}`, src: `Unavailable (${errs.join('; ') || 'no source'}) — injury report used alone, lineup status UNCERTAIN`, at: new Date().toISOString() });
  }
  sources.push({ what: 'Team & player box-score data', src: `Repo data (GitHub Actions build): ${meta.currentGames} games ${meta.currentSeason - 1}-${String(meta.currentSeason).slice(2)}, ${meta.priorGames} games ${meta.priorSeason - 1}-${String(meta.priorSeason).slice(2)}`, at: meta.builtAt });
  sources.push({ what: 'Historical calibration (HCA, B2B, margin/total SD)', src: `Fitted on ${cal.sampleGames} ${cal.season - 1}-${String(cal.season).slice(2)} final scores`, at: meta.builtAt });
  const data = { meta, calibration: cal, teams, gamesCurrent, gamesPrior, playersCurrent, playersPrior };
  assertNoMarketData({ schedule, injuries, lineups });
  return { data, schedule, injuries, lineups, sources, live };
}

/** Finals visible in the result feed but absent from the fitted regular-season history.
 * Do not substitute a score-only record: box scores are required for team/player factors.
 */
export function missingCompletedGames(date, inputs) {
  const known = new Set([...(inputs.data.gamesCurrent?.games || []), ...(inputs.data.gamesPrior?.games || [])].map(g => String(g[0])));
  const missing = new Map();
  for (const [day, events] of Object.entries(inputs.schedule || {})) {
    if (day >= date) continue;
    for (const e of events) {
      if (e.seasonType === 2 && e.status?.completed && e.status?.name === 'STATUS_FINAL' && !known.has(String(e.id))) {
        missing.set(String(e.id), { id: String(e.id), date: day, matchup: e.shortName || `${e.away?.abbr} @ ${e.home?.abbr}` });
      }
    }
  }
  return [...missing.values()];
}

/** Build everything the simulator needs for every game on `date`. */
export function prepareSlate(date, inputs, { today = etToday() } = {}) {
  const { data, schedule, injuries, lineups } = inputs;
  if (date >= today) {
    const missing = missingCompletedGames(date, inputs);
    if (missing.length) throw new Error(`Training history is missing ${missing.length} completed game(s): ${missing.map(g => g.matchup).join(', ')}. Refresh box-score data before simulating.`);
  }
  const events = (schedule[date] || []).filter(e => e.home && e.away);
  const model = buildModel(data, date);
  const repl = replacementRates(data.playersPrior);
  const abbr = id => data.teams[id]?.abbr;
  const recent = [];
  for (const g of data.gamesCurrent.games) if (g[1] < date && g[1] >= shiftDate(date, -10)) recent.push({ date: g[1], homeId: g[2], awayId: g[3], homeAbbr: abbr(g[2]), periods: g[6] });
  for (const [d, evs] of Object.entries(schedule)) if (d < date) for (const e of evs) {
    if (e.status?.name === 'STATUS_POSTPONED' || e.status?.name === 'STATUS_CANCELED') continue;
    if (!recent.some(r => r.date === d && r.homeId === e.home.id)) recent.push({ date: d, homeId: e.home.id, awayId: e.away.id, homeAbbr: e.home.abbr, periods: 4 });
  }
  const applyInjuries = date >= today; const injuryNotToday = date > today;
  const games = []; const skipped = [];
  for (const ev of events) {
    if (['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_CANCELLED'].includes(ev.status?.name)) { skipped.push({ ev, reason: 'Game postponed or cancelled' }); continue; }
    if (ev.seasonType === 1) { skipped.push({ ev, reason: 'Preseason game (not modelled)' }); continue; }
    try {
      const prep = prepareGame(ev, { model, data, injuries, lineups, recentGames: recent, applyInjuries, repl, date });
      games.push({ ev, prep });
    } catch (e) { skipped.push({ ev, reason: e.message }); }
  }
  return { date, model, games, skipped, applyInjuries, injuryNotToday, modelVersion: MODEL_VERSION };
}
