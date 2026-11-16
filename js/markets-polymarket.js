// STAGE 2 (post-freeze) — Polymarket public APIs: the price source and the CLOB liquidity check.
// -----------------------------------------------------------------------------------------
// FIREWALL: this module is never imported by the prediction engine (enforced by test/firewall.test.mjs).
// It only prices markets against an already-frozen, hash-verified predictions file.
//
// Endpoints (public, no key):
//   Gamma  GET  https://gamma-api.polymarket.com/events?series_slug=nba-YYYY&closed=false&limit=100&offset=N   the day's game events
//   Gamma  GET  https://gamma-api.polymarket.com/events?slug={slug}                     one game event + all its markets
//   CLOB   POST https://clob.polymarket.com/books   body [{token_id}, ...]              order books (bids/asks per outcome token)
//   CLOB   GET  https://clob.polymarket.com/clob-markets/{conditionId}                 fee curve fd:{r,e,to} (authoritative)
import { parseGammaOutcome, modelProb, RULES, ruleFails, confidenceOrder, scoreSupports, availabilityStress } from './markets-rules.js';

export const GAMMA = 'https://gamma-api.polymarket.com';
export const CLOB = 'https://clob.polymarket.com';
const TYPES = ['moneyline', 'spreads', 'totals'];
const jparse = (s, d) => { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? d); } catch { return d; } };

/** Polymarket documented fee: fee = C x rate x (p(1-p))^exponent, taker only; rate/exponent are per market
 *  (Gamma feeSchedule, CLOB clob-markets fd). Sports fallback is rate 0.05; explicit market schedules override it. If a market exposes no schedule we assume the documented sports rate (0.05). */
export function polyFee(p, sched) {
  const rate = sched && sched.rate != null ? Number(sched.rate) : 0.05; const e = sched && sched.exponent != null ? Number(sched.exponent) : 1;
  return rate * Math.pow(p * (1 - p), e);
}

/** Reduce a Gamma event to the identity fields the shared matcher (matchEvent) reads. */
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
      const depthAtAsk = bestAsk == null ? 0 : asks.filter(x => x[0] <= bestAsk + 1e-9).reduce((s, x) => s + x[1], 0);
      res.set(b.asset_id, { bestAsk, bestBid, depthAtAsk, minOrder: Number(b.min_order_size) || null });
    }
  }
  return res;
}

const venueQuote = (ask, bid, fee) => {
  if (!(ask > 0 && ask < 1)) return null;
  const cost = ask + fee; return { ask, bid: bid ?? null, fee, cost, twoSided: bid > 0 && bid <= ask && ask - bid <= RULES.maxBidAskSpread + 1e-9 };
};

/**
 * Evaluate EVERY full-game line for one game — moneyline both sides, every (alternate) spread both sides, every
 * (alternate) total over and under — on Polymarket. Price = the outcome token's best CLOB ask + the market's own
 * taker fee; liquidity = CLOB depth at that exact ask.
 */
export function evaluateCombined(game, gammaEvent, books) {
  const res = { gameId: game.id, matchup: `${game.away.abbr} @ ${game.home.abbr}`, polymarketEventId: gammaEvent ? `POLY-${gammaEvent.id}` : null,
    polymarketSlug: gammaEvent?.slug || null, candidates: [], coverage: null, unparsed: 0 };
  const cov = { moneyline: 0, spreads: 0, totals: 0, spreadLines: new Set(), totalLines: new Set(), polymarketPriced: 0 };
  for (const m of gammaEvent?.markets || []) {
    if (!TYPES.includes(m.sportsMarketType) || m.closed || m.active === false || m.acceptingOrders === false) continue;
    if (m.sportsMarketType === 'moneyline' && gammaEvent.slug && m.slug && m.slug !== gammaEvent.slug) continue;   // the game's own moneyline only
    const outs = jparse(m.outcomes, []), toks = jparse(m.clobTokenIds, []);
    for (let i = 0; i < outs.length; i++) {
      const key = `${m.id}-${i}`;
      const bet = parseGammaOutcome(m, outs, i, game); if (!bet) { res.unparsed++; continue; }
      cov[bet.type]++; if (bet.type === 'spreads') cov.spreadLines.add(String(m.id)); if (bet.type === 'totals') cov.totalLines.add(String(m.id));
      const p = modelProb(bet, game);
      const book = toks[i] ? books?.get(String(toks[i])) : null; const sched = m.feesEnabled === false ? { rate: 0, exponent: 1 } : (m.feeSchedule || null);
      const poly = book?.bestAsk ? venueQuote(book.bestAsk, book.bestBid, polyFee(book.bestAsk, sched)) : null;
      if (poly) { poly.feeRate = sched?.rate ?? 0.05; poly.feeExponent = sched?.exponent ?? 1; poly.feeType = m.feeType ?? null; cov.polymarketPriced++; }
      const c = { key, marketId: `POLY-${key}`, tokenId: toks[i] ? String(toks[i]) : null, conditionId: m.conditionId || null, type: bet.type, label: bet.label, line: bet.line, side: bet.side,
        sampleN: game.sims, modelProb: p, venue: poly ? 'Polymarket' : null, polymarket: poly ? { ...poly, edge: p - poly.cost } : null,
        liquiditySource: 'Polymarket CLOB', depth: book ? book.depthAtAsk : null, minOrder: book?.minOrder ?? null };
      if (poly) Object.assign(c, { ask: poly.ask, bid: poly.bid, fee: poly.fee, cost: poly.cost, twoSided: poly.twoSided, edge: p - poly.cost, roi: p / poly.cost - 1,
        marketMid: poly.twoSided ? (poly.ask + poly.bid) / 2 : null });
      else Object.assign(c, { ask: null, cost: null, edge: null, twoSided: false });
      c.liquid = c.depth == null ? false : c.depth >= Math.max(RULES.minDepthContracts, c.minOrder || 0);
      c.scoreConsistent = scoreSupports(c, game);
      c.availabilityChecks = availabilityStress(bet, game);
      const rf = ruleFails(c, p);
      c.qualifies = c.cost != null && c.twoSided && c.liquid && !rf.length;
      c.fails = c.qualifies ? [] : [c.cost == null && 'no price', c.cost != null && !c.twoSided && `quote not two-sided ≤${Math.round(RULES.maxBidAskSpread * 100)}¢ (bid ${poly?.bid == null ? '—' : (poly.bid * 100).toFixed(0) + '¢'})`,
        !c.liquid && `CLOB depth ${c.depth == null ? '—' : Math.round(c.depth)} < ${RULES.minDepthContracts}`, ...rf].filter(Boolean);
      res.candidates.push(c);
    }
  }
  res.candidates.sort(confidenceOrder);
  res.coverage = { moneyline: cov.moneyline, spreads: cov.spreads, totals: cov.totals, spreadLines: cov.spreadLines.size, totalLines: cov.totalLines.size,
    evaluated: res.candidates.length, polymarketPriced: cov.polymarketPriced };
  // No-vig pre-game moneyline: the benchmark the model is graded against (never a model input).
  const ml = Object.fromEntries(res.candidates.filter(c => c.type === 'moneyline' && c.marketMid != null && c.ask - c.bid <= 0.06 + 1e-9).map(c => [c.side, c.marketMid]));
  res.marketWin = ml.home != null && ml.away != null ? { home: ml.home / (ml.home + ml.away), away: ml.away / (ml.home + ml.away) } : null;
  return res;
}
