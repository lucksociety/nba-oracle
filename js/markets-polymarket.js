// STAGE 2 (post-freeze) — Polymarket public APIs as a second price source + CLOB liquidity.
// -----------------------------------------------------------------------------------------
// FIREWALL: like markets-jupiter.js this module is never imported by the prediction engine (enforced by
// test/firewall.test.mjs). It only prices markets against an already-frozen, hash-verified predictions file.
//
// Endpoints (public, no key):
//   Gamma  GET  https://gamma-api.polymarket.com/events?slug={slug}                     one game event + all its markets
//   Gamma  GET  https://gamma-api.polymarket.com/events?series_slug=nba-YYYY&closed=false&limit=100&offset=N   discovery fallback
//   CLOB   POST https://clob.polymarket.com/books   body [{token_id}, ...]              order books (bids/asks per outcome token)
//   CLOB   GET  https://clob.polymarket.com/clob-markets/{conditionId}                 fee curve fd:{r,e,to} (authoritative)
// Jupiter's NBA markets ARE Polymarket markets: Jupiter marketId "POLY-{gammaMarketId}-{outcomeIndex}" and the same
// conditionId / clobTokenIds, so the two venues are joined exactly by id (no fuzzy matching).
import { parseMarket, modelProb, feePerContract, RULES, ruleFails } from './markets-jupiter.js';

export const GAMMA = 'https://gamma-api.polymarket.com';
export const CLOB = 'https://clob.polymarket.com';
const TYPES = ['moneyline', 'spreads', 'totals'];
const jparse = (s, d) => { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? d); } catch { return d; } };

/** Polymarket documented fee: fee = C x rate x (p(1-p))^exponent, taker only; rate/exponent are per market
 *  (Gamma feeSchedule, CLOB clob-markets fd). Sports default is rate 0.05, but NBA game markets currently carry
 *  feeType "zero_fees" / rate 0. If a market exposes no schedule we assume the documented sports rate (0.05). */
export function polyFee(p, sched) {
  const rate = sched && sched.rate != null ? Number(sched.rate) : 0.05; const e = sched && sched.exponent != null ? Number(sched.exponent) : 1;
  return rate * Math.pow(p * (1 - p), e);
}

/** Convert a Gamma event into the Jupiter-like shape the shared matcher/parser understand. */
export function adaptGammaEvent(e) {
  const start = e.markets?.find(m => m.gameStartTime)?.gameStartTime || e.startTime || e.endDate;
  const t = start ? Date.parse(String(start).replace(' ', 'T').replace(/\+00$/, 'Z')) : NaN;
  return { eventId: `POLY-${e.id}`, gammaId: e.id, slug: e.slug, metadata: { title: e.title, slug: e.slug }, beginAt: Number.isFinite(t) ? String(t / 1000) : null, markets: e.markets || [] };
}

export async function fetchGammaEventBySlug(fetchJSON, slug) {
  const r = await fetchJSON(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`); return Array.isArray(r) && r[0] ? r[0] : null;
}
export async function fetchGammaNbaGames(fetchJSON, date) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)); const series = `nba-${m >= 8 ? y : y - 1}`;
  const out = [];
  for (let off = 0; off < 1000; off += 100) {
    const page = await fetchJSON(`${GAMMA}/events?series_slug=${series}&closed=false&limit=100&offset=${off}`);
    out.push(...page.filter(e => /^nba-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2}$/.test(e.slug || ''))); if (page.length < 100) break;
  }
  return out;
}

/** Order books for many outcome tokens (POST /books, chunks of 100). Returns Map tokenId -> {bestAsk, bestBid, depthAtAsk}. */
export async function fetchBooks(postJSON, tokenIds) {
  const res = new Map();
  for (let i = 0; i < tokenIds.length; i += 100) {
    const books = await postJSON(`${CLOB}/books`, tokenIds.slice(i, i + 100).map(t => ({ token_id: t })));
    for (const b of books || []) {
      const asks = (b.asks || []).map(x => [Number(x.price), Number(x.size)]).filter(x => x[1] > 0);
      const bids = (b.bids || []).map(x => [Number(x.price), Number(x.size)]).filter(x => x[1] > 0);
      const bestAsk = asks.length ? Math.min(...asks.map(x => x[0])) : null; const bestBid = bids.length ? Math.max(...bids.map(x => x[0])) : null;
      const depthAtAsk = bestAsk == null ? 0 : asks.filter(x => x[0] <= bestAsk + 0.01 + 1e-9).reduce((s, x) => s + x[1], 0);
      res.set(b.asset_id, { bestAsk, bestBid, depthAtAsk, minOrder: Number(b.min_order_size) || null });
    }
  }
  return res;
}

const venueQuote = (ask, bid, fee) => {
  if (!(ask > 0 && ask < 1)) return null;
  const cost = ask + fee; return { ask, bid: bid ?? null, fee, cost, twoSided: bid > 0 && ask - bid <= RULES.maxBidAskSpread + 1e-9 };
};

/**
 * Evaluate EVERY full-game line for one game — moneyline both sides, every (alternate) spread both sides, every
 * (alternate) total over and under — on the union of Jupiter and Polymarket markets, joined by Polymarket market id.
 * Recommendation price = Jupiter executable ask + Jupiter fee (where the user bets); Polymarket ask + Polymarket fee
 * is the fallback when Jupiter has no usable quote. Liquidity = Polymarket CLOB depth within 1c of the best ask.
 */
export function evaluateCombined(game, jupEvent, gammaEvent, books) {
  const res = { gameId: game.id, matchup: `${game.away.abbr} @ ${game.home.abbr}`, jupiterEventId: jupEvent?.eventId || null, polymarketEventId: gammaEvent ? `POLY-${gammaEvent.id}` : null,
    polymarketSlug: gammaEvent?.slug || jupEvent?.metadata?.slug || null, candidates: [], coverage: null, unparsed: 0, idMismatches: 0 };
  const rows = new Map(); // key gammaMarketId-outcomeIdx
  for (const m of jupEvent?.markets || []) {
    if (!TYPES.includes(m.sportsMarketType) || m.periodType || m.status !== 'open') continue;
    const k = String(m.marketId).replace(/^POLY-/, ''); rows.set(k, { ...(rows.get(k) || {}), jup: m });
  }
  for (const m of gammaEvent?.markets || []) {
    if (!TYPES.includes(m.sportsMarketType) || m.closed || m.active === false || m.acceptingOrders === false) continue;
    const outs = jparse(m.outcomes, []), toks = jparse(m.clobTokenIds, []);
    outs.forEach((o, i) => { const k = `${m.id}-${i}`; rows.set(k, { ...(rows.get(k) || {}), poly: m, outcome: o, token: toks[i] }); });
  }
  const cov = { moneyline: 0, spreads: 0, totals: 0, spreadLines: new Set(), totalLines: new Set(), jupiterPriced: 0, polymarketPriced: 0, both: 0 };
  for (const [key, r] of rows) {
    const src = r.jup || { sportsMarketType: r.poly.sportsMarketType, rulesPrimary: r.poly.description, title: r.outcome, status: 'open' };
    const bet = parseMarket(src, game); if (!bet) { res.unparsed++; continue; }
    if (r.jup && r.poly && r.jup.conditionId && r.jup.conditionId !== r.poly.conditionId) { res.idMismatches++; continue; }
    cov[bet.type]++; const mk = key.replace(/-\d+$/, ''); if (bet.type === 'spreads') cov.spreadLines.add(mk); if (bet.type === 'totals') cov.totalLines.add(mk);
    const p = modelProb(bet, game);
    const jAsk = r.jup ? (r.jup.pricing?.buyYesPriceUsd || 0) / 1e6 : null, jBid = r.jup ? (r.jup.pricing?.sellYesPriceUsd || 0) / 1e6 : null;
    const jup = jAsk ? venueQuote(jAsk, jBid, feePerContract(jAsk)) : null;
    const book = r.token ? books?.get(r.token) : null; const sched = r.poly?.feeSchedule || null;
    const poly = book?.bestAsk ? venueQuote(book.bestAsk, book.bestBid, polyFee(book.bestAsk, sched)) : null;
    if (poly) { poly.feeRate = sched?.rate ?? 0.05; poly.feeType = r.poly?.feeType ?? null; }
    if (jup) cov.jupiterPriced++; if (poly) cov.polymarketPriced++; if (jup && poly) cov.both++;
    const venue = jup?.twoSided ? 'Jupiter' : poly?.twoSided ? 'Polymarket' : jup ? 'Jupiter' : poly ? 'Polymarket' : null;
    const q = venue === 'Jupiter' ? jup : venue === 'Polymarket' ? poly : null;
    const c = { key, marketId: r.jup?.marketId || `POLY-${key}`, conditionId: r.poly?.conditionId || r.jup?.conditionId || null, type: bet.type, label: bet.label, line: bet.line, side: bet.side,
      modelProb: p, venue, jupiter: jup ? { ...jup, edge: p - jup.cost } : null, polymarket: poly ? { ...poly, edge: p - poly.cost } : null,
      depth: book ? book.depthAtAsk : null };
    if (q) Object.assign(c, { ask: q.ask, bid: q.bid, fee: q.fee, cost: q.cost, twoSided: q.twoSided, edge: p - q.cost, roi: p / q.cost - 1 });
    else Object.assign(c, { ask: null, cost: null, edge: null, twoSided: false });
    c.liquid = c.depth == null ? false : c.depth >= RULES.minDepthContracts;
    const rf = ruleFails(c, p);
    c.qualifies = c.cost != null && c.twoSided && c.liquid && !rf.length;
    c.fails = c.qualifies ? [] : [c.cost == null && 'no price', c.cost != null && !c.twoSided && `quote not two-sided ≤${Math.round(RULES.maxBidAskSpread * 100)}¢ (bid ${q?.bid == null ? '—' : (q.bid * 100).toFixed(0) + '¢'})`,
      !c.liquid && `CLOB depth ${c.depth == null ? '—' : Math.round(c.depth)} < ${RULES.minDepthContracts}`, ...rf].filter(Boolean);
    res.candidates.push(c);
  }
  res.candidates.sort((a, b) => (b.edge ?? -9) - (a.edge ?? -9));
  res.coverage = { moneyline: cov.moneyline, spreads: cov.spreads, totals: cov.totals, spreadLines: cov.spreadLines.size, totalLines: cov.totalLines.size,
    evaluated: res.candidates.length, jupiterPriced: cov.jupiterPriced, polymarketPriced: cov.polymarketPriced, both: cov.both };
  return res;
}
