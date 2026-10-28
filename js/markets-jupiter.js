// STAGE 2 — POST-FREEZE MARKET COMPARISON (Jupiter prediction markets, api.jup.ag/prediction/v1).
// ---------------------------------------------------------------------------------------------
// FIREWALL: this module is NEVER imported by the prediction engine (js/engine.js, js/pipeline.js,
// js/firewall.js, js/app.js, js/worker.js, scripts/predict.mjs, scripts/sim-thread.mjs) — enforced by
// test/firewall.test.mjs. It only reads an already-frozen, hash-verified predictions file and prices
// Jupiter's exact lines against the simulated outcome distributions. Nothing here can change a prediction.

export const JUP_BASE = 'https://api.jup.ag/prediction/v1';
export const RULES = { minModelProb: 0.5, minEdge: 0, maxBidAskSpread: 0.10, minDepthContracts: 10 };

/** Jupiter's documented trading fee, per contract: their published table (e.g. 100 contracts @ $0.25 -> $1.32,
 *  @ $0.40 -> $1.68, @ $0.10 -> $0.63) is reproduced exactly by ceil_cent(0.07 x C x P x (1-P)). */
export const feePerContract = (p) => 0.07 * p * (1 - p);

/** Fetch all NBA events with every market type (moneyline, spreads, totals). Keyless limit: 0.5 req/s. */
export async function fetchNbaEvents(fetchJSON) {
  const all = [];
  for (let start = 0; start < 600; start += 100) {
    const q = new URLSearchParams({ category: 'sports', subcategory: 'nba', includeMarkets: 'true', includeAllMarkets: 'true', start: String(start), end: String(start + 100) });
    const page = await fetchJSON(`${JUP_BASE}/events?${q}`);
    all.push(...(page.data || []));
    if (!page.pagination?.hasNext) break;
  }
  return all;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nickMatch = (espnName, polyName) => { const a = norm(espnName), b = norm(polyName); return !!b && (a === b || a.endsWith(b)); };

/** Find the Jupiter event for one frozen game: both team nicknames match and start within 4h of ESPN tipoff. */
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

/** Depth (contracts) purchasable at the best YES ask and 1c above it, from GET /orderbook/{marketId}.
 *  YES asks are the complement of NO bids (YES ask = $1 - NO bid). */
export function depthAtAsk(book, ask) {
  const askC = Math.round(ask * 100); let d = 0; const bids = book?.no || [];
  for (const [noBidC, size] of bids) if (100 - noBidC <= askC + 1) d += Number(size) || 0;
  return d;
}

/** Evaluate every candidate (ML both sides, spreads both sides at every line, totals over/under at every line). */
export function evaluateGame(game, event) {
  const res = { gameId: game.id, matchup: `${game.away.abbr} @ ${game.home.abbr}`, eventId: event?.eventId || null, candidates: [], coverage: { moneyline: 0, spreads: 0, totals: 0 }, unparsed: 0 };
  if (!event) { res.noMarketReason = 'No Jupiter NBA event found for this game'; return res; }
  for (const m of event.markets || []) {
    if (!['moneyline', 'spreads', 'totals'].includes(m.sportsMarketType) || m.periodType) continue; // full-game only
    if (m.status !== 'open') continue;
    res.coverage[m.sportsMarketType]++;
    const bet = parseMarket(m, game); if (!bet) { res.unparsed++; continue; }
    const ask = (m.pricing?.buyYesPriceUsd || 0) / 1e6, bid = (m.pricing?.sellYesPriceUsd || 0) / 1e6;
    const p = modelProb(bet, game);
    const fee = ask > 0 && ask < 1 ? feePerContract(ask) : null;
    const cost = fee == null ? null : ask + fee;
    const c = { marketId: m.marketId, type: bet.type, label: bet.label, line: bet.line, side: bet.side, modelProb: p, ask, bid, fee, cost,
      impliedProb: ask || null, edge: cost == null ? null : p - cost, roi: cost ? p / cost - 1 : null, volume: m.pricing?.volume ?? null };
    c.twoSided = ask > 0 && ask < 1 && bid > 0 && ask - bid <= RULES.maxBidAskSpread + 1e-9;
    c.qualifies = cost != null && c.twoSided && p > RULES.minModelProb && c.edge > RULES.minEdge;
    res.candidates.push(c);
  }
  res.candidates.sort((a, b) => (b.edge ?? -9) - (a.edge ?? -9));
  return res;
}
