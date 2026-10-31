// NBA ORACLE V1.3 — client-side prediction engine (ES module; runs in browser, Web Worker and Node).
// Possession-level four-factors Monte Carlo with correlated variance, fat tails, garbage time,
// late-game fouling and overtime. All inputs are independent basketball data (see firewall.js).
// Nothing in this file reads, accepts or produces sportsbook / market information.

import { lineupsForEvent, applyLineup, gameLineupStatus } from './lineups.js';

export const MODEL_VERSION = 'NBA ORACLE V1.3.2 (verified input freshness)';

// ---------------- Tunable priors (documented; NOT fitted by walk-forward validation) ----------------
export const PRIORS = {
  // V1.3 (walk-forward tuned on 2024-25 only, validated out-of-sample on 2025-26 + 2026-27; see backtest/README.md):
  // recency-weighted opponent-adjusted ratings (half-life 20 team games), less prior-season weight on the rating
  // (shrinkK.rating 15 -> 8) and larger absent-player impact (injuryRedistribution 0.8 -> 1.0).
  recencyHalfLifeGames: 20,
  shrinkK: { rating: 8, p2: 20, p3: 25, r3: 6, tov: 10, orb: 10, ftr: 15, ftp: 25, pace: 8 }, // games of prior-season weight
  priorRegressBase: 0.45, priorRegressContinuity: 0.35, // prior-season deviation kept = base + cont*continuity
  leaguePseudoTeamGames: 200,
  threeInFourPts: 0.6, travelPtsPer1000mi: 0.3, travelCapPts: 1.0, altitudePts: 0.7, prevOTb2bPts: 0.3, scheduleCapPts: 3.5,
  injuryRedistribution: 1.0, injuryTeamCapPer100: 12, replacementPPU: 0.96,
  availability: { out: 0.0, doubtful: 0.25, questionable: 0.55, probable: 0.85, available: 0.93, dtdDefault: 0.6, offNote: 0.05 },
  restrictedProb: 0.25, restrictedMinFrac: 0.7,
  // variance structure: hand-tuned on the 2026-10-27/28 slates so average simulated margin SD (~13.7) is close to the
  // prior-season fitted residual SD (14.0). Simulated total SD (~19.8) stays somewhat wider than the residual (18.4).
  paceSD: 2.2, envSD: 0.008, shootSD: 0.030, threeSD: 0.04, tovSD: 0.12, orbSD: 0.10, ftrTeamSD: 0.15, whistleSD: 0.05, tDF: 5,
  feedbackC: 0.0035, // game-state feedback: make-prob shift per point of deviation from the expected scoring path
  garbageAt: 0.82, garbageMargin: 20, garbageLeaderK: 0.95, lateFoulProb: 0.75,
};

// ---------------- RNG (seeded, reproducible) ----------------
export function hashSeed(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------------- Data helpers ----------------
const B = { fgm: 0, fga: 1, fg3m: 2, fg3a: 3, ftm: 4, fta: 5, oreb: 6, dreb: 7, tov: 8, pf: 9 };
const poss = b => b[B.fga] - b[B.oreb] + b[B.tov] + 0.44 * b[B.fta];
const pts = b => 2 * b[B.fgm] + b[B.fg3m] + b[B.ftm];
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function emptyAgg() { return { g: 0, poss: 0, pts: 0, o: new Array(10).fill(0), d: new Array(10).fill(0), oppPts: 0, games: [] }; }

/** Aggregate one season's games up to (not including) cutoffDate. */
export function seasonAggregates(gamesFile, cutoffDate, hcaPer100) {
  const T = {}; const L = { g: 0, poss: 0, pts: 0, o: new Array(10).fill(0) };
  for (const g of [...gamesFile.games].sort((a, b) => a[1].localeCompare(b[1]) || String(a[0]).localeCompare(String(b[0])))) {
    const [id, d, h, a, hs, as, per, n, hb, ab] = g;
    if (cutoffDate && d >= cutoffDate) continue;
    const P = 0.5 * (poss(hb) + poss(ab));
    for (const [t, ob, db, o, home] of [[h, hb, ab, a, 1], [a, ab, hb, h, 0]]) {
      const x = T[t] ||= emptyAgg();
      x.g++; x.poss += P; x.pts += pts(ob); x.oppPts += pts(db);
      for (let k = 0; k < 10; k++) { x.o[k] += ob[k]; x.d[k] += db[k]; }
      x.games.push({ opp: o, P, ortg: 100 * pts(ob) / P, drtg: 100 * pts(db) / P, home: n ? 0 : (home ? 1 : -1), d });
      L.g++; L.poss += P; L.pts += pts(ob); for (let k = 0; k < 10; k++) L.o[k] += ob[k];
    }
  }
  const lg = { ortg: L.g ? 100 * L.pts / L.poss : null, pace: L.g ? L.poss / L.g : null, teamGames: L.g, f: L.g ? factorsFrom(L.o, L.o, L.poss) : null };
  // Opponent adjustment (iterative, home-court neutralised)
  const ids = Object.keys(T);
  for (const t of ids) { T[t].adjO = 100 * T[t].pts / T[t].poss; T[t].adjD = 100 * T[t].oppPts / T[t].poss; T[t].adjPace = T[t].poss / T[t].g; }
  for (let it = 0; it < 12; it++) {
    const nO = {}, nD = {}, nP = {};
    for (const t of ids) {
      let so = 0, sd = 0, sp = 0, w = 0;
      const G = T[t].games, HL = PRIORS.recencyHalfLifeGames;
      for (let gi = 0; gi < G.length; gi++) {
        const gm = G[gi]; const opp = T[gm.opp]; if (!opp) continue;
        const rw = HL > 0 ? Math.pow(0.5, (G.length - 1 - gi) / HL) : 1; // recency weight (off when HL = 0)
        so += (gm.ortg - (opp.adjD - lg.ortg) - gm.home * hcaPer100 / 2) * gm.P * rw;
        sd += (gm.drtg - (opp.adjO - lg.ortg) + gm.home * hcaPer100 / 2) * gm.P * rw;
        sp += gm.P - (opp.adjPace - lg.pace); w += gm.P * rw;
      }
      nO[t] = so / w; nD[t] = sd / w; nP[t] = sp / T[t].g;
    }
    for (const t of ids) { T[t].adjO = nO[t]; T[t].adjD = nD[t]; T[t].adjPace = nP[t]; }
  }
  for (const t of ids) {
    const x = T[t];
    x.offF = factorsFrom(x.o, x.d, x.poss); x.defF = factorsFrom(x.d, x.o, x.poss);
    x.lastDate = x.games.length ? x.games[x.games.length - 1].d : null;
  }
  return { teams: T, lg };
}

/** Four factors (and shot profile) for an offense `o` against defense rebounds from `d`. */
function factorsFrom(o, d, P) {
  const fg2a = o[B.fga] - o[B.fg3a], fg2m = o[B.fgm] - o[B.fg3m];
  return {
    p2: fg2m / fg2a, p3: o[B.fg3m] / o[B.fg3a], r3: o[B.fg3a] / o[B.fga],
    tov: o[B.tov] / P, orb: o[B.oreb] / (o[B.oreb] + d[B.dreb]), ftr: o[B.fta] / o[B.fga], ftp: o[B.ftm] / o[B.fta],
    efg: (o[B.fgm] + 0.5 * o[B.fg3m]) / o[B.fga],
  };
}
const FKEYS = ['p2', 'p3', 'r3', 'tov', 'orb', 'ftr', 'ftp'];

// ---------------- Analytic points per possession of the possession engine ----------------
export function analyticPPP(f, k = 1) {
  const p2 = Math.min(0.9, f.p2 * k), p3 = Math.min(0.75, f.p3 * k);
  const pFT = (f.ftr * 0.45) / (1 + f.ftr * 0.45);
  const t1 = f.tov, t2 = 0.4 * f.tov;
  const c = pFT * 2 * f.ftp + (1 - pFT) * (f.r3 * p3 * 3 + (1 - f.r3) * p2 * (2 + 0.06 * f.ftp));
  const m = (1 - pFT) * (f.r3 * (1 - p3) + (1 - f.r3) * (1 - p2)) * f.orb;
  const X = c / (1 - m * (1 - t2));
  return (1 - t1) * X;
}
function solveK(f, targetPPP) {
  let lo = 0.6, hi = 1.5;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (analyticPPP(f, mid) < targetPPP) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// ---------------- Model build (team strength with Bayesian shrinkage) ----------------
export function buildModel(data, cutoffDate) {
  const cal = data.calibration;
  const hcaPer100 = cal.homeCourtPts; // ~1 pt per game ≈ 1 pt per 100 possessions at NBA pace (~100)
  const prior = seasonAggregates(data.gamesPrior, cutoffDate, hcaPer100);
  const cur = seasonAggregates(data.gamesCurrent, cutoffDate, hcaPer100);
  const wl = cur.lg.teamGames / (cur.lg.teamGames + PRIORS.leaguePseudoTeamGames);
  const blendLg = (c, p) => (c == null ? p : wl * c + (1 - wl) * p);
  const lg = { ortg: blendLg(cur.lg.ortg, prior.lg.ortg), pace: blendLg(cur.lg.pace, prior.lg.pace), f: {} };
  for (const k of [...FKEYS, 'efg']) lg.f[k] = blendLg(cur.lg.f?.[k], prior.lg.f[k]);
  lg.ppp = lg.ortg / 100;
  lg.fCal = solveK(lg.f, lg.ppp); // league-level calibration of the analytic engine

  const continuity = rosterContinuity(data);
  const teams = {};
  const allIds = new Set([...Object.keys(prior.teams), ...Object.keys(cur.teams)]);
  for (const t of allIds) {
    const c = cur.teams[t], p = prior.teams[t];
    const g = c ? c.g : 0; const cont = continuity[t] ?? 0.75;
    const keep = PRIORS.priorRegressBase + PRIORS.priorRegressContinuity * cont;
    const bl = (cv, pv, lgC, lgP, K) => {
      const pr = pv == null ? lgC : lgC + keep * (pv - lgP);
      if (cv == null || !g) return pr; const w = g / (g + K); return w * cv + (1 - w) * pr;
    };
    const K = PRIORS.shrinkK;
    const out = {
      id: t, gCur: g, gPrior: p ? p.g : 0, continuity: cont, wCur: g / (g + K.rating), keepPrior: keep,
      adjO: bl(c?.adjO, p?.adjO, lg.ortg, prior.lg.ortg, K.rating),
      adjD: bl(c?.adjD, p?.adjD, lg.ortg, prior.lg.ortg, K.rating),
      pace: bl(c?.adjPace, p?.adjPace, lg.pace, prior.lg.pace, K.pace),
      rawCur: c ? { ortg: 100 * c.pts / c.poss, drtg: 100 * c.oppPts / c.poss, pace: c.poss / c.g } : null,
      rawPrior: p ? { ortg: 100 * p.pts / p.poss, drtg: 100 * p.oppPts / p.poss, pace: p.poss / p.g } : null,
      off: {}, def: {}, lastDate: c?.lastDate || null,
    };
    for (const k of FKEYS) {
      out.off[k] = bl(c?.offF[k], p?.offF[k], lg.f[k], prior.lg.f[k], K[k]);
      out.def[k] = bl(c?.defF[k], p?.defF[k], lg.f[k], prior.lg.f[k], K[k]);
    }
    teams[t] = out;
  }
  return { lg, teams, cal, hcaPer100, cutoffDate, curGames: cur.lg.teamGames / 2, priorGames: prior.lg.teamGames / 2 };
}

/** Share of each team's current-season minutes played by players who were on the same team last season. */
function rosterContinuity(data) {
  const out = {};
  const pc = data.playersCurrent?.teams || {}, pp = data.playersPrior?.teams || {};
  for (const [t, rows] of Object.entries(pc)) {
    const prev = new Set((pp[t] || []).map(r => r[0]));
    let tot = 0, same = 0; for (const r of rows) { tot += r[3]; if (prev.has(r[0])) same += r[3]; }
    if (tot > 0) out[t] = same / tot;
  }
  return out;
}

// ---------------- Player impact & availability (Sections 4-5, simplified box-score version) ----------------
const PF = { id: 0, name: 1, gp: 2, min: 3, pts: 4, fgm: 5, fga: 6, fg3m: 7, fg3a: 8, ftm: 9, fta: 10, oreb: 11, dreb: 12, ast: 13, stl: 14, blk: 15, tov: 16, pf: 17, pm: 18 };
function offVal(r) { return r[PF.pts] - PRIORS.replacementPPU * (r[PF.fga] + 0.44 * r[PF.fta] + r[PF.tov]) + 0.3 * r[PF.ast] + 0.25 * r[PF.oreb]; }
function defVal(r) { return 1.0 * r[PF.stl] + 0.6 * r[PF.blk] + 0.12 * r[PF.dreb] - 0.1 * r[PF.pf]; }

export function replacementRates(playersPrior) {
  let m = 0, o = 0, d = 0;
  for (const rows of Object.values(playersPrior.teams)) for (const r of rows) {
    const mpg = r[PF.min] / r[PF.gp]; if (r[PF.gp] >= 15 && mpg >= 8 && mpg <= 16) { m += r[PF.min]; o += offVal(r); d += defVal(r); }
  }
  return { off: o / m, def: d / m };
}

export function parseAvailability(inj) {
  const A = PRIORS.availability; const c = (inj.comment || '').toLowerCase();
  const code = String(inj.fantasyCode || '').toUpperCase();
  const listedOut = inj.typeName === 'INJURY_STATUS_OUT' || /^out$/i.test(inj.status || '');
  // ESPN can retain a broad Out category while its game-status code is GTD and
  // the latest report explicitly says questionable/doubtful. OUT code wins;
  // only a GTD code permits reconciling that broad category with the report.
  if (code === 'OUT' || (listedOut && code !== 'GTD')) return { p: A.out, label: 'OUT', basis: 'Listed Out' };
  const explicit = String(inj.status || '').toLowerCase();
  if (explicit === 'doubtful') return { p: A.doubtful, label: 'DOUBTFUL', basis: 'Explicit game status' };
  if (explicit === 'questionable') return { p: A.questionable, label: 'QUESTIONABLE', basis: 'Explicit game status' };
  if (explicit === 'probable') return { p: A.probable, label: 'PROBABLE', basis: 'Explicit game status' };
  if (/doubtful/.test(c)) return { p: A.doubtful, label: 'DOUBTFUL', basis: 'Report text: doubtful' };
  if (/questionable|game-time decision|gtd/.test(c)) return { p: A.questionable, label: 'QUESTIONABLE', basis: 'Report text: questionable' };
  if (/probable/.test(c)) return { p: A.probable, label: 'PROBABLE', basis: 'Report text: probable' };
  if (/will not play|won't play|ruled out|is out|sidelined|will miss|won't suit up|not play/.test(c)) return { p: A.offNote, label: 'OUT (report text)', basis: 'Report text indicates out' };
  if (/available|will play|cleared|expected to play|will suit up|good to go/.test(c)) return { p: A.available, label: 'AVAILABLE (DTD)', basis: 'Report text indicates available' };
  if (listedOut && code === 'GTD') return { p: A.questionable, label: 'GTD (provider conflict)', basis: 'ESPN Out category conflicts with GTD code; participation remains uncertain' };
  return { p: A.dtdDefault, label: 'DAY-TO-DAY', basis: 'Day-to-day, no game status in report' };
}

/** Build player impact entries for a team's injury list. Values are net points per game if absent (positive = team worse). */
export function injuryImpacts(teamId, injList, data, model, repl) {
  const pc = data.playersCurrent?.teams?.[teamId] || [];
  const tgC = data.playersCurrent?.teamGames?.[teamId] || 0, tgP = data.playersPrior?.teamGames?.[teamId] || 0;
  const priorAll = {};
  for (const [t, rows] of Object.entries(data.playersPrior?.teams || {})) for (const r of rows) {
    const x = priorAll[r[0]] ||= { rows: [], sameTeam: null }; x.rows.push(r); if (t === teamId) x.sameTeam = r;
  }
  const team = model.teams[teamId]; const w = team?.wCur ?? 0;
  const out = [];
  for (const inj of injList || []) {
    const rep = parseAvailability(inj); const o = inj.override;
    // An expected five is a projection, not confirmation of availability.
    // It can clarify an unspecified DTD report, but cannot erase a game-status tag.
    const projected = o?.label === 'EXPECTED STARTER';
    const av = !o ? rep : projected && rep.label !== 'DAY-TO-DAY'
      ? { ...rep, label: `${rep.label} · expected lineup unconfirmed` }
      : o.floor && rep.p >= o.p ? { ...rep, label: `${rep.label} · ${o.label}` }
      : { p: o.p, label: o.label, basis: o.basis, reportLabel: rep.label };
    const cRow = pc.find(r => r[0] === inj.athleteId);
    const pAll = priorAll[inj.athleteId];
    const pRow = pAll ? pAll.rows.reduce((s, r) => s ? s.map((v, i) => (typeof v === 'number' ? v + r[i] : v)) : r.slice(), null) : null;
    const curMin = cRow ? cRow[PF.min] : 0, priMin = pRow ? pRow[PF.min] : 0;
    if (!curMin && !priMin) { out.push({ ...inj, ...av, mpg: 0, offPG: 0, defPG: 0, netPG: 0, presence: 0, note: 'No NBA box-score sample in the last two seasons' }); continue; }
    // pooled per-minute rates (prior season half-weighted)
    const pool = (fn) => ((cRow ? fn(cRow) : 0) + 0.5 * (pRow ? fn(pRow) : 0)) / (curMin + 0.5 * priMin);
    const offR = pool(offVal), defR = pool(defVal);
    const mpgC = cRow ? cRow[PF.min] / cRow[PF.gp] : null, mpgP = pRow ? pRow[PF.min] / pRow[PF.gp] : null;
    const wm = cRow ? cRow[PF.gp] / (cRow[PF.gp] + 5) : 0;
    const mpg = mpgC == null ? mpgP : mpgP == null ? mpgC : wm * mpgC + (1 - wm) * mpgP;
    const shrinkMin = (curMin + 0.5 * priMin) / (curMin + 0.5 * priMin + 300); // small samples shrink toward replacement
    const offPG = Math.max(-1, (offR - repl.off) * mpg * shrinkMin * PRIORS.injuryRedistribution);
    const defPG = Math.max(-0.5, (defR - repl.def) * mpg * shrinkMin * PRIORS.injuryRedistribution);
    const shareC = tgC ? (cRow ? cRow[PF.gp] / tgC : 0) : 0;
    const shareP = tgP && pAll?.sameTeam ? pAll.sameTeam[PF.gp] / tgP : 0;
    const presence = clamp(tgC ? w * shareC + (1 - w) * shareP : shareP, 0, 1);
    out.push({ ...inj, ...av, mpg, offPG, defPG, netPG: offPG + defPG, presence, gpCur: cRow ? cRow[PF.gp] : 0, gpPrior: pRow ? pRow[PF.gp] : 0,
      note: presence < 0.3 ? 'Mostly absent from baseline sample already (effect largely priced into team ratings)' : '' });
  }
  return out;
}

// ---------------- Schedule / fatigue ----------------
export const ARENAS = { ATL: [33.757, -84.396], BOS: [42.366, -71.062], BKN: [40.683, -73.975], CHA: [35.225, -80.839], CHI: [41.881, -87.674], CLE: [41.496, -81.688], DAL: [32.790, -96.810], DEN: [39.749, -105.008], DET: [42.341, -83.055], GS: [37.768, -122.388], HOU: [29.751, -95.362], IND: [39.764, -86.155], LAC: [33.945, -118.343], LAL: [34.043, -118.267], MEM: [35.138, -90.051], MIA: [25.781, -80.188], MIL: [43.045, -87.917], MIN: [44.979, -93.276], NO: [29.949, -90.082], NY: [40.751, -73.993], OKC: [35.463, -97.515], ORL: [28.539, -81.384], PHI: [39.901, -75.172], PHX: [33.446, -112.071], POR: [45.532, -122.667], SAC: [38.580, -121.500], SA: [29.427, -98.437], TOR: [43.643, -79.379], UTAH: [40.768, -111.901], WSH: [38.898, -77.021] };
function miles(a, b) { if (!a || !b) return 0; const R = 3958.8, r = x => x * Math.PI / 180; const dLa = r(b[0] - a[0]), dLo = r(b[1] - a[1]); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }

/** recentGames: array of {date, homeId, awayId, homeAbbr, periods} strictly before `date`. */
export function scheduleContext(teamId, date, venueAbbr, recentGames) {
  const mine = recentGames.filter(g => (g.homeId === teamId || g.awayId === teamId) && g.date < date).sort((a, b) => a.date.localeCompare(b.date));
  const last = mine[mine.length - 1];
  const rest = last ? dayDiff(date, last.date) - 1 : 3;
  const in3 = mine.filter(g => dayDiff(date, g.date) <= 3).length;
  const travel = last ? miles(ARENAS[last.homeAbbr], ARENAS[venueAbbr]) : 0;
  return { rest: Math.min(rest, 7), b2b: rest === 0, threeInFour: in3 >= 2, travelMi: Math.round(travel), prevOT: !!(last && last.periods > 4), lastDate: last?.date || null, lastVenue: last?.homeAbbr || null };
}
function scheduleMarginPenalty(s, cal) {
  // returns points of margin LOST by this team (positive = worse)
  let p = 0; const parts = [];
  if (s.b2b) { p += cal.backToBackPts; parts.push(`back-to-back ${cal.backToBackPts.toFixed(1)}`); }
  if (s.threeInFour) { p += PRIORS.threeInFourPts; parts.push(`3-in-4 ${PRIORS.threeInFourPts}`); }
  if (s.rest <= 1 && s.travelMi > 0) { const t = Math.min(PRIORS.travelCapPts, PRIORS.travelPtsPer1000mi * s.travelMi / 1000); if (t >= 0.05) { p += t; parts.push(`travel ${s.travelMi}mi ${t.toFixed(1)}`); } }
  if (s.b2b && s.prevOT) { p += PRIORS.prevOTb2bPts; parts.push(`OT last night ${PRIORS.prevOTb2bPts}`); }
  return { pts: Math.min(p, PRIORS.scheduleCapPts), parts };
}
// Note: cal.backToBackPts is fitted on prior-season results as the margin cost of playing on a B2B against a
// non-B2B opponent (it cancels when both teams are on a B2B).

// ---------------- Game preparation ----------------
export function prepareGame(ev, ctx) {
  const { model, data, injuries, recentGames, applyInjuries, repl } = ctx;
  const lineup = applyInjuries && ctx.lineups ? lineupsForEvent(ctx.lineups, ev) : null;
  const rows = (id) => data.playersCurrent?.teams?.[id] || [];
  const H = model.teams[ev.home.id], A = model.teams[ev.away.id];
  if (!H || !A) throw new Error(`No ratings for ${ev.shortName}`);
  const lg = model.lg;
  const pace = clamp(H.pace * A.pace / lg.pace, 85, 115);
  const matchF = (O, D) => Object.fromEntries(FKEYS.map(k => [k, clamp(lg.f[k] + (O.off[k] - lg.f[k]) + (D.def[k] - lg.f[k]), 0.01, 0.99)]));
  const fH = matchF(H, A), fA = matchF(A, H);
  const lgF = lg.f; const calk = lg.fCal;
  const ppp = (f) => analyticPPP(f, calk) * 100;
  const base = ppp(lgF);
  const offOnly = (O) => ppp(Object.fromEntries(FKEYS.map(k => [k, lgF[k] + (O.off[k] - lgF[k])])));
  const defOnly = (D) => ppp(Object.fromEntries(FKEYS.map(k => [k, lgF[k] + (D.def[k] - lgF[k])])));
  const interH = ppp(fH) - (base + (offOnly(H) - base) + (defOnly(A) - base));
  const interA = ppp(fA) - (base + (offOnly(A) - base) + (defOnly(H) - base));
  const ratingH = lg.ortg + (H.adjO - lg.ortg) + (A.adjD - lg.ortg);
  const ratingA = lg.ortg + (A.adjO - lg.ortg) + (H.adjD - lg.ortg);
  const per100 = x => x * 100 / pace;
  const neutral = !!ev.neutral;
  const hca = neutral ? 0 : model.cal.homeCourtPts;
  const altitude = !neutral && (ev.home.abbr === 'DEN' || ev.home.abbr === 'UTAH') ? PRIORS.altitudePts : 0;
  const venue = neutral ? null : ev.home.abbr;
  const sH = scheduleContext(ev.home.id, ctx.date, venue, recentGames), sA = scheduleContext(ev.away.id, ctx.date, venue, recentGames);
  const pH = scheduleMarginPenalty(sH, model.cal), pA = scheduleMarginPenalty(sA, model.cal);
  const ctxMarginHome = hca + altitude - pH.pts + pA.pts; // margin points in home team's favour
  // injuries
  const injH = applyInjuries ? injuryImpacts(ev.home.id, applyLineup(injuries?.teams?.[ev.home.id], lineup?.home, rows(ev.home.id)), data, model, repl) : [];
  const injA = applyInjuries ? injuryImpacts(ev.away.id, applyLineup(injuries?.teams?.[ev.away.id], lineup?.away, rows(ev.away.id)), data, model, repl) : [];
  const split = (list) => {
    let fixedOff = 0, fixedDef = 0; const unc = [];
    for (const p of list) {
      const off = per100(p.offPG * p.presence), def = per100(p.defPG * p.presence);
      if (Math.abs(off) + Math.abs(def) < 0.05) continue;
      if (p.p <= 0.0001) { fixedOff += off; fixedDef += def; }
      else if (p.p < 0.999) unc.push({ name: p.name, p: p.p, off, def, label: p.label });
    }
    const cap = PRIORS.injuryTeamCapPer100; const tot = fixedOff + fixedDef;
    if (tot > cap) { fixedOff *= cap / tot; fixedDef *= cap / tot; }
    return { fixedOff, fixedDef, unc };
  };
  const iH = split(injH), iA = split(injA);
  // targets (per 100) excluding uncertain players (sampled in sim)
  const tH = ratingH + interH + per100(ctxMarginHome / 2) - iH.fixedOff + iA.fixedDef;
  const tA = ratingA + interA - per100(ctxMarginHome / 2) - iA.fixedOff + iH.fixedDef;
  const kH = solveK(fH, tH / 100), kA = solveK(fA, tA / 100);
  const params = {
    id: ev.id, pace, home: { f: fH, k: kH, dppp: (analyticPPP(fH, kH + 0.005) - analyticPPP(fH, kH - 0.005)) / 0.01 * 100 },
    away: { f: fA, k: kA, dppp: (analyticPPP(fA, kA + 0.005) - analyticPPP(fA, kA - 0.005)) / 0.01 * 100 },
    uncHome: iH.unc, uncAway: iA.unc, priors: PRIORS, expMarginPerPoss: (tH - tA) / 100,
    targetPts: { home: tH * pace / 100, away: tA * pace / 100 }, // expected points with all listed players available as sampled below
  };
  // expected injury effect incl. uncertain players (for reporting)
  // fix v1.2.1: include the restricted-minutes scenario the simulator samples (previously omitted from the report)
  const expUnc = (u) => u.reduce((s, x) => s + ((1 - x.p) + (x.p < 0.9 ? x.p * PRIORS.restrictedProb * (1 - PRIORS.restrictedMinFrac) : 0)) * (x.off + x.def), 0);
  const factors = {
    strengthMarginHome: (ratingH - ratingA) * pace / 100,
    netH: H.adjO - H.adjD, netA: A.adjO - A.adjD,
    interactionMarginHome: (interH - interA) * pace / 100,
    hca, altitude, schedHome: pH, schedAway: pA, sH, sA,
    injFixedMarginHome: (-(iH.fixedOff + iH.fixedDef) + (iA.fixedOff + iA.fixedDef)) * pace / 100,
    injUncExpMarginHome: (-expUnc(iH.unc) + expUnc(iA.unc)) * pace / 100,
    fourFactorEdges: fourFactorEdges(fH, fA, lgF, calk, pace),
    targetOrtgHome: tH, targetOrtgAway: tA, ratingH, ratingA, interH, interA,
  };
  return { params, factors, injH, injA, H, A, fH, fA, lineup };
}

function fourFactorEdges(fH, fA, lgF, calk, pace) {
  const groups = { 'Shooting (2P%/3P%/3PA rate)': ['p2', 'p3', 'r3'], 'Turnovers': ['tov'], 'Offensive rebounding': ['orb'], 'Free throws (rate & %)': ['ftr', 'ftp'] };
  const out = {};
  for (const [g, ks] of Object.entries(groups)) {
    const c = (f) => { const neutral = { ...f }; for (const k of ks) neutral[k] = lgF[k]; return (analyticPPP(f, calk) - analyticPPP(neutral, calk)) * pace; };
    out[g] = c(fH) - c(fA); // margin points, home perspective
  }
  return out;
}

// ---------------- Monte Carlo ----------------
// End-game calibration (fix, v1.2.1): the regulation possession engine is solved so its points per possession hit the
// rating targets, but team ratings and pace are measured from real box scores that ALREADY include late-game
// intentional fouling and overtime. Simulating those on top double-counted them (+0.8 pts per team, ~+1.6 on the
// total). A seeded pilot run (no availability sampling) measures the simulated mean points against the targets and
// shifts each team's shooting calibration so the full simulation's mean equals the model's expected points.
export function simulate(params, N, seed, onProgress, opts = {}) {
  let adj = { h: 0, a: 0 };
  if (params.targetPts && !opts.noCalibration) {
    const pilotN = Math.min(40000, Math.max(10000, N >> 2));
    for (let it = 0; it < 2; it++) {
      const pil = runSim(params, pilotN, (seed ^ 0x5bd1e995) + it, null, adj, true);
      let sh = 0, sa = 0; for (let i = 0; i < pilotN; i++) { sh += pil.homePts[i]; sa += pil.awayPts[i]; }
      const dH = params.targetPts.home - sh / pilotN, dA = params.targetPts.away - sa / pilotN;
      adj = { h: adj.h + (dH * 100 / params.pace) / params.home.dppp, a: adj.a + (dA * 100 / params.pace) / params.away.dppp };
    }
  }
  const sim = runSim(params, N, seed, onProgress, adj, !!opts.noAvailability);
  sim.calibration = { kAdjHome: adj.h, kAdjAway: adj.a };
  return sim;
}
function runSim(params, N, seed, onProgress, adj, noAvail) {
  const P = params.overridePriors ? { ...params.priors, ...params.overridePriors } : params.priors; const rnd = mulberry32(seed);
  let spare = null;
  const gauss = () => { if (spare !== null) { const s = spare; spare = null; return s; } let u, v, s; do { u = 2 * rnd() - 1; v = 2 * rnd() - 1; s = u * u + v * v; } while (s >= 1 || s === 0); const m = Math.sqrt(-2 * Math.log(s) / s); spare = v * m; return u * m; };
  const tdf = P.tDF; const tScale = Math.sqrt((tdf - 2) / tdf);
  const tdist = () => { let c = 0; for (let i = 0; i < tdf; i++) { const z = gauss(); c += z * z; } return clamp(gauss() / Math.sqrt(c / tdf) * tScale, -4, 4); }; // V1.3: cap fat-tail shocks at ±4 SD (prevented rare <40-pt games)
  const awayPts = new Int16Array(N), homePts = new Int16Array(N), ots = new Uint8Array(N), possArr = new Float32Array(N);
  const H = params.home, A = params.away;

  function team(base, kAdj, shootShock, threeShock, tovShock, orbShock, ftrShock) {
    const f = base.f;
    return {
      p2: Math.min(0.9, f.p2 * kAdj * (1 + shootShock)), p3: Math.min(0.75, f.p3 * kAdj * (1 + shootShock + threeShock)),
      r3: f.r3, tov: clamp(f.tov * (1 + tovShock), 0.03, 0.3), orb: clamp(f.orb * (1 + orbShock), 0.05, 0.6),
      pFT: (() => { const fr = Math.max(0.05, f.ftr * (1 + ftrShock)); return fr * 0.45 / (1 + fr * 0.45); })(), ftp: f.ftp,
    };
  }
  function possession(t, desperation, mult = 1) {
    let pts = 0; let first = true; const r3 = desperation ? 0.75 : t.r3; const p2 = t.p2 * mult, p3 = t.p3 * mult;
    for (let loop = 0; loop < 6; loop++) {
      if (rnd() < (first ? t.tov : 0.4 * t.tov)) return pts;
      first = false;
      if (rnd() < t.pFT) { if (rnd() < t.ftp) pts++; if (rnd() < t.ftp) pts++; return pts; }
      if (rnd() < r3) { if (rnd() < p3) return pts + 3; }
      else if (rnd() < p2) { pts += 2; if (rnd() < 0.06 && rnd() < t.ftp) pts++; return pts; }
      if (rnd() >= t.orb) return pts;
    }
    return pts;
  }
  function availabilityShift(unc) { // returns [offLossPer100, defLossPer100]
    let o = 0, d = 0;
    for (const u of unc) {
      if (rnd() >= u.p) { o += u.off; d += u.def; }
      else if (rnd() < P.restrictedProb && u.p < 0.9) { o += u.off * (1 - P.restrictedMinFrac); d += u.def * (1 - P.restrictedMinFrac); }
    }
    return [o, d];
  }
  const chunk = Math.max(1, Math.floor(N / 20));
  for (let i = 0; i < N; i++) {
    const [hO, hD] = noAvail ? [0, 0] : availabilityShift(params.uncHome), [aO, aD] = noAvail ? [0, 0] : availabilityShift(params.uncAway);
    const kH = H.k + adj.h + (-hO + aD) / H.dppp, kA = A.k + adj.a + (-aO + hD) / A.dppp;
    const env = gauss() * P.envSD, whistle = gauss() * P.whistleSD;
    const th = team(H, kH, env + tdist() * P.shootSD, gauss() * P.threeSD, gauss() * P.tovSD, gauss() * P.orbSD, whistle + gauss() * P.ftrTeamSD);
    const ta = team(A, kA, env + tdist() * P.shootSD, gauss() * P.threeSD, gauss() * P.tovSD, gauss() * P.orbSD, whistle + gauss() * P.ftrTeamSD);
    const n = Math.max(80, Math.round(params.pace + tdist() * P.paceSD));
    let hs = 0, as = 0; const g1 = Math.round(n * P.garbageAt);
    const C = P.feedbackC, em = params.expMarginPerPoss;
    for (let j = 0; j < g1; j++) { const dev = C * ((hs - as) - em * j); as += possession(ta, false, 1 + dev); hs += possession(th, false, 1 - dev); }
    let thL = th, taL = ta;
    if (Math.abs(hs - as) >= P.garbageMargin) { // garbage time: leader's bench, slight regression
      if (hs > as) thL = { ...th, p2: th.p2 * P.garbageLeaderK, p3: th.p3 * P.garbageLeaderK }; else taL = { ...ta, p2: ta.p2 * P.garbageLeaderK, p3: ta.p3 * P.garbageLeaderK };
    }
    for (let j = g1; j < n; j++) { const dev = C * ((hs - as) - em * j); as += possession(taL, false, 1 + dev); hs += possession(thL, false, 1 - dev); }
    // late-game intentional fouling when trailing by 1-6
    let m = hs - as;
    if (m !== 0 && Math.abs(m) <= 6 && rnd() < P.lateFoulProb) {
      for (let r = 0; r < 3; r++) {
        m = hs - as; if (m === 0 || Math.abs(m) > 6) break;
        if (m > 0) { as += possession(ta, true); if (rnd() < th.ftp) hs++; if (rnd() < th.ftp) hs++; }
        else { hs += possession(th, true); if (rnd() < ta.ftp) as++; if (rnd() < ta.ftp) as++; }
      }
    }
    let ot = 0;
    while (hs === as && ot < 8) {
      ot++; const no = Math.max(6, Math.round(n * 5 / 48 + gauss()));
      for (let j = 0; j < no; j++) { as += possession(ta, false); hs += possession(th, false); }
      if (hs === as && ot >= 8) hs += 1; // pathological guard
    }
    awayPts[i] = as; homePts[i] = hs; ots[i] = ot; possArr[i] = n + ot * Math.round(n * 5 / 48);
    if (onProgress && i % chunk === 0) onProgress(i / N);
  }
  return { awayPts, homePts, ots, possArr, N };
}

// ---------------- Summaries (Section 11 metrics) ----------------
function quantile(sorted, q) { const i = (sorted.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
export function summarize(sim) {
  const { awayPts, homePts, ots, possArr, N } = sim;
  let hw = 0, ot = 0, sa = 0, sh = 0, sp = 0, close = 0; const joint = new Map();
  const margin = new Float64Array(N), total = new Float64Array(N);
  const bl = { home: [0, 0, 0, 0], away: [0, 0, 0, 0] }; const th = [10, 15, 20, 30];
  let hwFirst = 0; const half = N >> 1;
  for (let i = 0; i < N; i++) {
    const a = awayPts[i], h = homePts[i]; const m = h - a;
    margin[i] = m; total[i] = a + h; sa += a; sh += h; sp += possArr[i];
    if (m > 0) { hw++; if (i < half) hwFirst++; }
    if (ots[i]) ot++;
    if (Math.abs(m) <= 5) close++;
    for (let k = 0; k < 4; k++) { if (m >= th[k]) bl.home[k]++; if (-m >= th[k]) bl.away[k]++; }
    const key = a * 1000 + h; joint.set(key, (joint.get(key) || 0) + 1);
  }
  const sortA = Float64Array.from(awayPts).sort(), sortH = Float64Array.from(homePts).sort();
  margin.sort(); total.sort();
  const top = [...joint.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, c]) => ({ away: Math.floor(k / 1000), home: k % 1000, p: c / N }));
  const pH = hw / N; const se = Math.sqrt(pH * (1 - pH) / N);
  const p1 = hwFirst / half, p2 = (hw - hwFirst) / (N - half);
  return {
    N, homeWin: pH, awayWin: 1 - pH, otProb: ot / N, close5: close / N,
    expAway: sa / N, expHome: sh / N, medAway: quantile(sortA, 0.5), medHome: quantile(sortH, 0.5),
    expMarginHome: (sh - sa) / N, medMarginHome: quantile(margin, 0.5), expTotal: (sa + sh) / N, medTotal: quantile(total, 0.5),
    iAway: [quantile(sortA, 0.1), quantile(sortA, 0.9)], iHome: [quantile(sortH, 0.1), quantile(sortH, 0.9)],
    iTotal: [quantile(total, 0.1), quantile(total, 0.9)], iMarginHome: [quantile(margin, 0.1), quantile(margin, 0.9)],
    sdMargin: sd(margin), sdTotal: sd(total), expPoss: sp / N,
    blowouts: { thresholds: th, home: bl.home.map(c => c / N), away: bl.away.map(c => c / N) },
    topScores: top, distinctScores: joint.size,
    convergence: { winProbSE: se, splitHalfDiff: Math.abs(p1 - p2) },
  };
}
function sd(a) { let s = 0, s2 = 0; for (const v of a) { s += v; s2 += v * v; } const m = s / a.length; return Math.sqrt(s2 / a.length - m * m); }

/** Section 12: coherent integer pair from conditional medians of margin and total, consistent with the winner probability. */
export function selectFinalScore(s) {
  let M = Math.round(s.medMarginHome); let T = Math.round(s.medTotal);
  const homeFav = s.homeWin >= 0.5;
  if (homeFav && M <= 0) M = 1; if (!homeFav && M >= 0) M = -1;
  if ((T + M) % 2 !== 0) T += (s.expTotal >= T ? 1 : -1);
  return { home: (T + M) / 2, away: (T - M) / 2, rule: 'Conditional median margin & median total (absolute-error baseline), rounded to a coherent integer pair; sign forced to agree with the simulated favourite.' };
}

// ---------------- Section 16 narrative pieces ----------------
export function buildReport(ev, prep, s, opts) {
  const { factors: F, injH, injA, H, A } = prep;
  const fin = selectFinalScore(s);
  const homeFav = s.homeWin >= 0.5; const fav = homeFav ? ev.home : ev.away; const dog = homeFav ? ev.away : ev.home;
  const sign = homeFav ? 1 : -1; const favP = Math.max(s.homeWin, s.awayWin);
  const fmtTeam = (v) => (v >= 0 ? `+${v.toFixed(1)} ${ev.home.abbr}` : `+${(-v).toFixed(1)} ${ev.away.abbr}`);
  const cand = [];
  cand.push({ label: 'Team strength (opponent-adjusted, shrunk ratings)', v: F.strengthMarginHome, detail: `${ev.home.abbr} net ${F.netH.toFixed(1)}/100 vs ${ev.away.abbr} net ${F.netA.toFixed(1)}/100 (current-season weight ${Math.round(H.wCur * 100)}% / ${Math.round(A.wCur * 100)}%)` });
  if (F.hca) cand.push({ label: 'Home court', v: F.hca + F.altitude, detail: `fitted HCA ${F.hca.toFixed(2)} pts${F.altitude ? ` + altitude prior ${F.altitude}` : ''}` });
  const sched = -F.schedHome.pts + F.schedAway.pts;
  cand.push({ label: 'Rest / schedule / travel', v: sched, detail: `${ev.home.abbr}: ${F.sH.rest}d rest${F.schedHome.parts.length ? ' (' + F.schedHome.parts.join(', ') + ')' : ''}; ${ev.away.abbr}: ${F.sA.rest}d rest${F.schedAway.parts.length ? ' (' + F.schedAway.parts.join(', ') + ')' : ''}` });
  const injV = F.injFixedMarginHome + F.injUncExpMarginHome;
  const injNames = (l) => l.filter(p => Math.abs(p.netPG * p.presence) >= 0.3 && p.p < 0.95).sort((a, b) => b.netPG * b.presence - a.netPG * a.presence).slice(0, 3).map(p => `${p.name} (${p.label}, ${(p.netPG * p.presence).toFixed(1)} pts)`).join(', ');
  cand.push({ label: 'Availability / injuries (expected)', v: injV, detail: opts.applyInjuries ? `${ev.home.abbr}: ${injNames(injH) || 'none material'}; ${ev.away.abbr}: ${injNames(injA) || 'none material'}` : 'Not applied (historical date: current report would leak post-cutoff info)' });
  for (const [g, v] of Object.entries(F.fourFactorEdges)) cand.push({ label: `Four factors — ${g}`, v, detail: 'component of team strength (descriptive decomposition, not additive)' });
  if (Math.abs(F.interactionMarginHome) >= 0.05) cand.push({ label: 'Four-factor matchup interaction', v: F.interactionMarginHome, detail: 'non-additive effect of these specific offense/defense profiles in the possession engine' });
  const keyFactors = cand.sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 5).map(c => ({ ...c, text: `${fmtTeam(c.v)} pts` }));

  // uncertainty sources
  const unc = [];
  for (const [team, list] of [[ev.home, prep.params.uncHome], [ev.away, prep.params.uncAway]]) for (const u of list) {
    const swing = (u.off + u.def) * prep.params.pace / 100;
    unc.push({ score: Math.abs(swing) * Math.sqrt(u.p * (1 - u.p)) * 2, text: `${u.name} (${team.abbr}) ${u.label}, ~${(u.p * 100).toFixed(0)}% to play — forecast margin swings ~${Math.abs(swing).toFixed(1)} pts on his status` });
  }
  const minG = Math.min(H.gCur, A.gCur);
  unc.push({ score: 3 * (1 - Math.min(H.wCur, A.wCur)), text: `Early-season sample: ${ev.home.abbr} ${H.gCur} / ${ev.away.abbr} ${A.gCur} games this season; ratings lean ${Math.round((1 - Math.min(H.wCur, A.wCur)) * 100)}% on regressed prior-season data` });
  const r3 = (prep.fH.r3 + prep.fA.r3) / 2;
  unc.push({ score: 4 * r3, text: `Three-point variance: projected 3PA rate ${(prep.fH.r3 * 100).toFixed(0)}% (${ev.home.abbr}) / ${(prep.fA.r3 * 100).toFixed(0)}% (${ev.away.abbr}); 80% margin interval spans ${(s.iMarginHome[1] - s.iMarginHome[0]).toFixed(0)} pts` });
  const contMin = Math.min(H.continuity, A.continuity);
  if (contMin < 0.6) unc.push({ score: 2.5 * (1 - contMin), text: `Roster turnover: only ${(contMin * 100).toFixed(0)}% of ${H.continuity < A.continuity ? ev.home.abbr : ev.away.abbr} minutes from returning players — prior-season ratings less reliable` });
  const bigOut = [...injH, ...injA].filter(p => p.p === 0 && Math.abs(p.netPG * p.presence) >= 2);
  if (bigOut.length) unc.push({ score: 1.2 + 0.3 * bigOut.length, text: `Rotation redistribution for absent ${bigOut.map(p => p.name).join(', ')} is a box-score heuristic, not a lineup-level model` });
  if (!opts.applyInjuries) unc.push({ score: 5, text: 'Injury report not applied (historical date) — availability unknown to the model' });
  if (opts.injuryNotToday) unc.push({ score: 2.2, text: 'Injury report reflects status at fetch time; game is on a later date' });
  const uncertainty = unc.sort((a, b) => b.score - a.score).slice(0, 3).map(u => u.text);

  // lineup status & confidence
  const lineupSwing = unc.filter(u => /to play/.test(u.text)).reduce((m, u) => Math.max(m, u.score), 0);
  // Section 2: CONFIRMED only from an officially confirmed lineup for both teams; PROBABLE needs at least the official
  // expected lineup for both teams and no large unresolved availability swing; otherwise UNCERTAIN.
  const offStatus = gameLineupStatus(prep.lineup);
  const lineupStatus = !opts.applyInjuries || opts.injuryNotToday || !offStatus || offStatus === 'UNCERTAIN' ? 'UNCERTAIN'
    : offStatus === 'CONFIRMED' ? 'CONFIRMED' : lineupSwing >= 1.5 ? 'UNCERTAIN' : 'PROBABLE';
  let confidence = 'LOW';
  if (favP >= 0.64 && lineupSwing < 3 && minG >= 0) confidence = 'MODERATE';
  const confidenceNote = 'HIGH tier is withheld: probabilities are provisional and not yet validated by chronological walk-forward calibration (Section 13).';
  return {
    fin, homeFav, fav, dog, favP, keyFactors, uncertainty, lineupStatus, lineups: prep.lineup, confidence, confidenceNote,
    finalLine: `FINAL: ${ev.away.abbr} ${fin.away}, ${ev.home.abbr} ${fin.home}`,
    sheetLine: `${ev.away.abbr} ${fin.away} - ${ev.home.abbr} ${fin.home}`,
  };
}
