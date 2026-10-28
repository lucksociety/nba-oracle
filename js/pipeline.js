// Orchestration shared by the browser app and the Node end-to-end test.
import { sanitizeScoreboard, sanitizeInjuries, assertNoMarketData } from './firewall.js';
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
export async function loadInputs(date, getJSON, dataBase, espnSources = [{ base: ESPN, label: 'ESPN (live)' }]) {
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
  sources.push({ what: 'Team & player box-score data', src: `Repo data (GitHub Actions build): ${meta.currentGames} games ${meta.currentSeason - 1}-${String(meta.currentSeason).slice(2)}, ${meta.priorGames} games ${meta.priorSeason - 1}-${String(meta.priorSeason).slice(2)}`, at: meta.builtAt });
  sources.push({ what: 'Historical calibration (HCA, B2B, margin/total SD)', src: `Fitted on ${cal.sampleGames} ${cal.season - 1}-${String(cal.season).slice(2)} final scores`, at: meta.builtAt });
  const data = { meta, calibration: cal, teams, gamesCurrent, gamesPrior, playersCurrent, playersPrior };
  assertNoMarketData({ schedule, injuries });
  return { data, schedule, injuries, sources, live };
}

/** Build everything the simulator needs for every game on `date`. */
export function prepareSlate(date, inputs, { today = etToday() } = {}) {
  const { data, schedule, injuries } = inputs;
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
    if (ev.seasonType === 1) { skipped.push({ ev, reason: 'Preseason game (not modelled)' }); continue; }
    try {
      const prep = prepareGame(ev, { model, data, injuries, recentGames: recent, applyInjuries, repl, date });
      games.push({ ev, prep });
    } catch (e) { skipped.push({ ev, reason: e.message }); }
  }
  return { date, model, games, skipped, applyInjuries, injuryNotToday, modelVersion: MODEL_VERSION };
}
