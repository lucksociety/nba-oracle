// STAGE 2 — POST-FREEZE MARKET COMPARISON: shared bet rules, contract parsing and model-probability maths.
// ---------------------------------------------------------------------------------------------
// FIREWALL: this module is NEVER imported by the prediction engine (js/engine.js, js/pipeline.js,
// js/firewall.js, js/app.js, js/worker.js, scripts/predict.mjs, scripts/sim-thread.mjs) — enforced by
// test/firewall.test.mjs. It only reads an already-frozen, hash-verified predictions file and prices
// Polymarket's exact lines (js/markets-polymarket.js) against the simulated outcome distributions.

// V1.3 betting-layer safeguards (stage 2 only; the engine never sees prices). Walk-forward backtest vs Polymarket price
// history (backtest/bets.mjs) showed edges above ~8 pts won at roughly the market's rate, not the model's, so they are
// treated as model error, not value. minEdge 3 pts, maxEdge 8 pts, price cap 90¢, at most one bet per game.
// Prior-season diagnostic calibration stress, rounded upward from a date-cluster bootstrap.
// Not an individual forecast confidence interval; never alters the frozen model probabilities.
export const CALIBRATION_RESERVE = { moneyline: 0.001, spreads: 0.011, totals: 0.008 };
export const confidenceOrder = (a, b) => (b.modelStressLower ?? b.modelProb) - (a.modelStressLower ?? a.modelProb)
  || (b.roi ?? -Infinity) - (a.roi ?? -Infinity);
export const RULES = { selection: 'participation-roster-quote-stress-v4', minModelProb: 0.5, minEdge: 0.03, maxEdge: 0.08, maxPrice: 0.90, maxBidAskSpread: 0.10, minDepthContracts: 10 };
/** Shared V1.3 qualification test (both venues). Returns the list of failed rules (empty = qualifies). */
export function scoreSupports(c, game) {
  const a = game?.final?.away, h = game?.final?.home;
  if (![a,h].every(x => Number.isInteger(x) && x >= 0)) return false;
  if (c.type === 'moneyline') return c.side === 'home' ? h > a : c.side === 'away' ? a > h : false;
  if (!Number.isFinite(c.line)) return false;
  if (c.type === 'spreads') return c.side === 'home' ? h + c.line > a : c.side === 'away' ? a + c.line > h : false;
  if (c.type === 'totals') return c.side === 'over' ? a+h > c.line : c.side === 'under' ? a+h < c.line : false;
  return false;
}
// Conditional probabilities retain the original simulation mixture for every other player.
// Single-player checks plus joint states of at least 1% modeled mass (up to eight players).
export function availabilityStress(bet, game) {
  const modelChecks=(game.modelSensitivity||[]).map(s=>({name:s.name,state:'model-input',sampleN:s.sims,prob:modelProb(bet,s)}));
  if (!Array.isArray(game.availabilityConditionals)) {
    const uncertain = Object.values(game.availability || {}).flat().some(x => x.p > 0 && x.p < 1);
    return [...modelChecks,...(uncertain ? [{name:'missing conditional availability forecast',sampleN:0,prob:NaN}] : [])];
  }
  const checks=game.availabilityConditionals.flatMap(g => ['in','out'].map(state => ({
    name:g.name,side:g.side,state,sampleN:g[state].sims,prob:modelProb(bet,g[state])
  })));
  if(game.availabilityConditionals.length>=2) {
    const joint=game.availabilityJoint;
    if(!joint?.supported || joint.policy!=='joint-roster-v1' || !joint.scenarios?.length)
      checks.push({name:'missing or unsupported joint roster forecast',state:'joint',sampleN:0,prob:NaN});
    else for(const scenario of joint.scenarios) checks.push({
      name:joint.players.map((p,j)=>`${p.name} ${scenario.state[j].toUpperCase()}`).join('; '),
      state:'joint',sampleN:scenario.sims,prob:scenario.sims ? modelProb(bet,scenario) : NaN
    });
  }
  return [...checks,...modelChecks];
}
export function ruleFails(c, p) {
  // Numerical sampling error only; this is not a confidence interval for model accuracy.
  const n = c.sampleN;
  const lower = Number.isInteger(n) && n >= 1000 && Number.isFinite(p) && p >= 0 && p <= 1
    ? p - 1.96 * Math.sqrt(p * (1 - p) / n) : NaN;
  c.mcLower95 = lower;
  c.calibrationReserve = CALIBRATION_RESERVE[c.type] ?? Math.max(...Object.values(CALIBRATION_RESERVE));
  c.modelStressLower = lower - c.calibrationReserve;
  const checks = c.availabilityChecks || [];
  c.availabilityWorst = null;
  for (const x of checks) {
    const valid = Number.isInteger(x.sampleN) && x.sampleN >= 1000 && Number.isFinite(x.prob) && x.prob >= 0 && x.prob <= 1;
    x.stressLower = valid ? x.prob - 1.96*Math.sqrt(x.prob*(1-x.prob)/x.sampleN) - c.calibrationReserve : -Infinity;
    if (x.stressLower < c.modelStressLower || !Number.isFinite(x.stressLower)) {
      c.modelStressLower = x.stressLower;c.availabilityWorst = {name:x.name,side:x.side,state:x.state};
    }
  }
  c.stressEV = c.cost > 0 ? c.modelStressLower / c.cost - 1 : null;
  c.quoteStressAsk=Number.isFinite(c.ask) ? Math.min(1,c.ask+.01) : null;
  const stressedFee=(c.polymarket?.feeRate ?? .05)*Math.pow(c.quoteStressAsk*(1-c.quoteStressAsk),c.polymarket?.feeExponent ?? 1);
  c.quoteStressCost=c.cost!=null && c.quoteStressAsk!=null
    ? c.quoteStressAsk+Math.max(c.cost-c.ask,stressedFee) : null;
  c.quoteStressEV=c.quoteStressCost>0 ? c.modelStressLower/c.quoteStressCost-1 : null;
  return [c.cost!=null && !(c.quoteStressEV>0) && 'EV does not survive one-cent worse quote after roster/calibration stress', checks.some(x => !(x.stressLower > RULES.minModelProb) || (c.cost != null && !(x.stressLower > c.cost))) && 'bet not robust to uncertain-player IN/OUT outcomes (or insufficient conditional sims)', c.scoreConsistent === false && 'bet does not win at displayed predicted score', !(c.modelStressLower > RULES.minModelProb) && 'probability not above 50% after calibration stress',
    c.cost != null && !(c.modelStressLower > c.cost) && 'EV does not survive historical calibration stress', !(lower > RULES.minModelProb) && 'probability not above 50% after Monte Carlo error',
    c.cost != null && !(lower > c.cost) && 'positive EV not resolved beyond Monte Carlo error', (!Number.isFinite(p) || p > 1) && 'invalid model probability', !(p > RULES.minModelProb) && 'model ≤50%', c.cost != null && !(c.edge > 0) && 'edge ≤0',
    c.cost != null && c.edge > 0 && !(c.edge >= RULES.minEdge) && `edge < ${RULES.minEdge * 100} pts minimum`,
    c.cost != null && c.edge > RULES.maxEdge && `edge > ${RULES.maxEdge * 100} pts (implausible vs market — treated as model error)`,
    c.ask != null && c.ask > RULES.maxPrice && `price > ${Math.round(RULES.maxPrice * 100)}¢ cap`].filter(Boolean);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** ESPN's full name ends with Polymarket's nickname, compared word by word ("Portland Trail Blazers" / "Trail Blazers").
 *  A plain suffix test is wrong: "Charlotte Hornets" ends with the letters of "Nets". */
export const nickMatch = (espnName, polyName) => { const a = words(espnName), b = words(polyName);
  return b.length > 0 && b.length <= a.length && b.every((w, i) => w === a[a.length - b.length + i]); };

/** Find the Polymarket event (adapted shape) for one frozen game: both team nicknames match and start within 4h of ESPN tipoff. */
export function matchEvent(game, events) {
  const tip = Date.parse(game.tip) / 1000;
  return events.find(e => {
    const t = e.metadata?.title || ''; const parts = t.split(/\s+vs\.?\s+/i); if (parts.length !== 2) return false;
    const teamsOk = (nickMatch(game.away.name, parts[0]) && nickMatch(game.home.name, parts[1])) || (nickMatch(game.away.name, parts[1]) && nickMatch(game.home.name, parts[0]));
    const begin = Number(e.beginAt); return teamsOk && (!begin || Math.abs(begin - tip) < 4 * 3600);
  }) || null;
}

/** Parse a market's settlement rule into a predicate over (margin = home - away, total). Returns null if not understood. */
export function parseMarket(m, game) {
  const type = m.sportsMarketType; const rules = m.rulesPrimary || ''; const side = m.title;
  const sideIs = (who) => nickMatch(game.home.name, who) ? 'home' : nickMatch(game.away.name, who) ? 'away' : null;
  if (type === 'moneyline') {
    const s = sideIs(side); if (!s) return null;
    return { type, side: s, label: `${game[s].abbr} ML`, wins: (mg) => (s === 'home' ? mg > 0 : mg < 0), line: null };
  }
  if (type === 'spreads') {
    let team, X;
    let r = rules.match(/if the (.+?) win the game by (\d+) or more points/i);
    if (r) { team = r[1]; X = Number(r[2]) - 0.5; }
    else if ((r = rules.match(/If (?:the )?(.+?) wins? by more than ([\d.]+) points/i))) { team = r[1]; X = Number(r[2]); }
    else return null;
    const fav = sideIs(team), s = sideIs(side); if (!fav || !s) return null;
    const favMargin = (mg) => (fav === 'home' ? mg : -mg);
    // favourite side wins iff favMargin > X; the other outcome wins otherwise (binary market).
    const wins = s === fav ? (mg) => favMargin(mg) > X : (mg) => !(favMargin(mg) > X);
    const line = s === fav ? -X : +X;
    return { type, side: s, label: `${game[s].abbr} ${line > 0 ? '+' : ''}${line}`, wins, line };
  }
  if (type === 'totals') {
    let X; let r = rules.match(/combine to score (\d+) or more points/i);
    if (r) X = Number(r[1]) - 0.5; else if ((r = rules.match(/combined final score is more than ([\d.]+) points/i))) X = Number(r[1]); else return null;
    const over = /^over$/i.test(side), under = /^under$/i.test(side); if (!over && !under) return null;
    return { type, side: over ? 'over' : 'under', label: `${over ? 'Over' : 'Under'} ${X}`, totalWins: over ? (t) => t > X : (t) => !(t > X), line: X };
  }
  return null;
}

/** Model probability of a parsed bet from the frozen simulated distributions (exact at the market's line). */
export function modelProb(bet, game) {
  if (bet.totalWins) { const h = game.totalHist; let w = 0, n = 0; h.counts.forEach((c, i) => { n += c; if (bet.totalWins(h.min + i)) w += c; }); return w / n; }
  const h = game.marginHist; let w = 0, n = 0; h.counts.forEach((c, i) => { n += c; if (bet.wins(h.min + i)) w += c; }); return w / n;
}

/** Parse one outcome of a Polymarket Gamma market from its structured fields (type, question, outcomes, line).
 *  idx = which of the two outcomes. Returns the same bet shape as parseMarket, or null if anything is ambiguous. */
export function parseGammaOutcome(m, outcomes, idx, game) {
  const type = m.sportsMarketType, who = String(outcomes[idx] ?? '');
  const sideIs = (name) => { const h = nickMatch(game.home.name, name), a = nickMatch(game.away.name, name); return h && !a ? 'home' : a && !h ? 'away' : null; };
  if (outcomes.length !== 2) return null;
  if (type === 'moneyline') {
    const s = sideIs(who), o = sideIs(outcomes[1 - idx]); if (!s || !o || s === o) return null;
    return { type, side: s, label: `${game[s].abbr} ML`, wins: (mg) => (s === 'home' ? mg > 0 : mg < 0), line: null };
  }
  const line = Number(m.line);
  if (m.line == null || !Number.isFinite(line) || Math.abs(line % 1) !== 0.5) return null;   // half lines only: no pushes
  if (type === 'spreads') {
    const q = /^Spread:\s*(.+?)\s*\(([+-]\d+(?:\.\d+)?)\)\s*$/.exec(String(m.question || ''));
    if (!q || q[1] !== String(outcomes[0]) || Number(q[2]) !== line || !(line < 0)) return null;   // the line belongs to outcome 0
    const fav = sideIs(outcomes[0]), other = sideIs(outcomes[1]); if (!fav || !other || fav === other) return null;
    const X = -line, s = idx === 0 ? fav : other, favMargin = (mg) => (fav === 'home' ? mg : -mg);
    const wins = s === fav ? (mg) => favMargin(mg) > X : (mg) => !(favMargin(mg) > X);
    const l = s === fav ? -X : X;
    return { type, side: s, label: `${game[s].abbr} ${l > 0 ? '+' : ''}${l}`, wins, line: l };
  }
  if (type === 'totals') {
    if (String(outcomes[0]) !== 'Over' || String(outcomes[1]) !== 'Under' || !(line > 0)) return null;
    const over = idx === 0;
    return { type, side: over ? 'over' : 'under', label: `${over ? 'Over' : 'Under'} ${line}`, totalWins: over ? (t) => t > line : (t) => !(t > line), line };
  }
  return null;
}
