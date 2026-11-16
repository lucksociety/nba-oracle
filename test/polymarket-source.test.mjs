// Polymarket-only comparison stage: structured contract parsing and pricing (Gamma shapes copied from live responses, 2026-11-16).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseGammaOutcome, matchEvent, modelProb, nickMatch } from '../js/markets-rules.js';
import { evaluateCombined, adaptGammaEvent, fetchBooks, fetchGammaNbaGames } from '../js/markets-polymarket.js';

const FEE = { exponent: 1, rate: 0.05, takerOnly: true, rebateRate: 0.15 };
const gm = (id, type, suffix, question, outcomes, line = null, extra = {}) => ({ id, sportsMarketType: type, slug: 'nba-den-por-2026-11-16' + suffix, question,
  outcomes: JSON.stringify(outcomes), clobTokenIds: JSON.stringify([`${id}a`, `${id}b`]), line, conditionId: `0x${id}`, active: true, closed: false, acceptingOrders: true,
  feesEnabled: true, feeSchedule: FEE, ...extra });
const event = { id: '900', slug: 'nba-den-por-2026-11-16', title: 'Nuggets vs. Trail Blazers', startTime: '2026-11-17T03:00:00Z', markets: [
  gm(1, 'moneyline', '', 'Nuggets vs. Trail Blazers', ['Nuggets', 'Trail Blazers']),
  gm(2, 'spreads', '-spread-away-6pt5', 'Spread: Nuggets (-6.5)', ['Nuggets', 'Trail Blazers'], -6.5),
  gm(3, 'spreads', '-spread-home-2pt5', 'Spread: Trail Blazers (-2.5)', ['Trail Blazers', 'Nuggets'], -2.5, { feeSchedule: { rate: 0.03, exponent: 1 } }),
  gm(4, 'totals', '-total-228pt5', 'Nuggets vs. Trail Blazers: O/U 228.5', ['Over', 'Under'], 228.5),
  gm(5, 'totals', '-total-230', 'Nuggets vs. Trail Blazers: O/U 230', ['Over', 'Under'], 230),                 // whole line can push
  gm(6, 'first_half_moneyline', '-1h', '1H', ['Nuggets', 'Trail Blazers']),
  gm(7, 'spreads', '-spread-away-7pt5', 'Spread: Trail Blazers (-7.5)', ['Nuggets', 'Trail Blazers'], -7.5),   // question disagrees with outcome 0
  gm(8, 'spreads', '-spread-away-8pt5', 'Spread: Nuggets (-8.5)', ['Nuggets', 'Blazers FC'], -8.5),            // unknown opponent
  gm(9, 'totals', '-total-231pt5', 'O/U 231.5', ['Over', 'Under'], 231.5, { acceptingOrders: false }),
  gm(10, 'moneyline', '-other', 'Other', ['Nuggets', 'Trail Blazers']),                                       // not the game's own moneyline
  gm(11, 'totals', '-total-229pt5', 'O/U 229.5', ['Over', 'Under'], 229.5, { feesEnabled: false }),
] };
// margin = home - away; DEN (away) by 8 in 60% of sims, POR by 3 in 40%. totals 220 / 235.
const game = { id: 'g1', sims: 300000, tip: '2026-11-17T03:00:00Z', status: { state: 'pre' }, final: { away: 118, home: 110 },
  away: { name: 'Denver Nuggets', abbr: 'DEN' }, home: { name: 'Portland Trail Blazers', abbr: 'POR' },
  marginHist: { min: -8, counts: [180000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120000] }, totalHist: { min: 220, counts: [150000, ...Array(14).fill(0), 150000] } };

// ---- parsing from structured fields
const P = (i, k) => parseGammaOutcome(event.markets[i], JSON.parse(event.markets[i].outcomes), k, game);
assert.deepEqual([P(0, 0).side, P(0, 0).label, P(0, 1).label], ['away', 'DEN ML', 'POR ML']);
assert.deepEqual([P(1, 0).label, P(1, 0).line, P(1, 1).label, P(1, 1).line], ['DEN -6.5', -6.5, 'POR +6.5', 6.5]);
assert.deepEqual([P(2, 0).label, P(2, 1).label], ['POR -2.5', 'DEN +2.5']);
assert.deepEqual([P(3, 0).label, P(3, 0).side, P(3, 1).label], ['Over 228.5', 'over', 'Under 228.5']);
for (const i of [4, 6, 7]) assert.equal(P(i, 0), null, `market ${i} must not parse`);
assert.equal(parseGammaOutcome(event.markets[5], ['Nuggets', 'Trail Blazers'], 0, game), null, 'period markets are not full-game lines');
// probabilities at the market's exact line, and complements
assert.ok(Math.abs(modelProb(P(0, 0), game) - .6) < 1e-12 && Math.abs(modelProb(P(0, 1), game) - .4) < 1e-12);
assert.ok(Math.abs(modelProb(P(1, 0), game) - .6) < 1e-12 && Math.abs(modelProb(P(1, 1), game) - .4) < 1e-12, 'DEN -6.5 wins by 8');
assert.ok(Math.abs(modelProb(P(2, 0), game) - .4) < 1e-12 && Math.abs(modelProb(P(2, 1), game) - .6) < 1e-12, 'POR -2.5 wins by 3');
assert.ok(Math.abs(modelProb(P(3, 0), game) - .5) < 1e-12 && Math.abs(modelProb(P(3, 1), game) - .5) < 1e-12);

// ---- team matching is by whole words (live case 2026-11-16: "Nets vs. Hornets" — "Hornets" ends with the letters "nets")
assert.equal(nickMatch('Charlotte Hornets', 'Nets'), false); assert.equal(nickMatch('Brooklyn Nets', 'Nets'), true);
assert.equal(nickMatch('Portland Trail Blazers', 'Trail Blazers'), true); assert.equal(nickMatch('Philadelphia 76ers', '76ers'), true);
assert.equal(nickMatch('Portland Trail Blazers', 'Blazers FC'), false); assert.equal(nickMatch('Nets', ''), false);
const bkn = { ...game, away: { name: 'Brooklyn Nets', abbr: 'BKN' }, home: { name: 'Charlotte Hornets', abbr: 'CHA' } };
const ml = gm(20, 'moneyline', '', 'Nets vs. Hornets', ['Nets', 'Hornets']);
assert.deepEqual([parseGammaOutcome(ml, ['Nets', 'Hornets'], 0, bkn).label, parseGammaOutcome(ml, ['Nets', 'Hornets'], 1, bkn).label], ['BKN ML', 'CHA ML']);
const wrongGame = { eventId: 'POLY-1', slug: 'nba-phi-bkn-2026-11-16', metadata: { title: '76ers vs. Nets' }, beginAt: String(Date.parse(game.tip) / 1000) };
assert.equal(matchEvent({ ...game, away: { name: 'Philadelphia 76ers' }, home: { name: 'Charlotte Hornets' } }, [wrongGame]), null, 'a Hornets game must not match a Nets market');

// ---- pricing: CLOB best ask + the market's own fee, depth only at that ask
const raw = (ask, bid, size = 50) => ({ asks: [{ price: '0.99', size: '9' }, { price: String(ask + .01), size: '500' }, { price: String(ask), size: String(size) }], bids: [{ price: '0.01', size: '9' }, { price: String(bid), size: '20' }], min_order_size: '5' });
const table = { '1a': raw(.55, .54), '1b': raw(.46, .45), '2a': raw(.54, .53), '2b': raw(.47, .46), '3a': raw(.30, .29), '3b': raw(.71, .70, 4), '4a': raw(.50, .49), '4b': raw(.51, .50), '11a': raw(.50, .49), '11b': raw(.51, .50) };
const books = await fetchBooks(async (url, body) => body.filter(t => table[t.token_id]).map(t => ({ asset_id: t.token_id, ...table[t.token_id] })), Object.keys(table));
const r = evaluateCombined(game, event, books);
const by = Object.fromEntries(r.candidates.map(c => [c.label + (c.key.startsWith('11-') ? '*' : ''), c]));
assert.equal(r.polymarketEventId, 'POLY-900'); assert.equal(r.jupiterEventId, undefined);
assert.deepEqual(r.coverage, { moneyline: 2, spreads: 4, totals: 4, spreadLines: 2, totalLines: 2, evaluated: 10, polymarketPriced: 10 });
assert.equal(r.unparsed, 6, 'whole line, mismatched question and unknown opponent (both outcomes each)');
const den = by['DEN ML'];
assert.deepEqual([den.venue, den.ask, den.bid, den.depth, den.tokenId, den.marketId, den.liquiditySource], ['Polymarket', .55, .54, 50, '1a', 'POLY-1-0', 'Polymarket CLOB']);
assert.ok(Math.abs(den.fee - .05 * .55 * .45) < 1e-12 && Math.abs(den.cost - (.55 + den.fee)) < 1e-12 && Math.abs(den.edge - (.6 - den.cost)) < 1e-12);
assert.equal(den.jupiter, undefined);
assert.ok(Math.abs(by['POR -2.5'].fee - .03 * .30 * .70) < 1e-12, "a market's own fee schedule is used");
assert.equal(by['Over 229.5*'].fee, 0, 'fee-free markets stay fee-free');
assert.equal(by['DEN +2.5'].liquid, false, '4 contracts at the ask is below the depth minimum even with 500 a cent higher');
assert.ok(by['DEN +2.5'].fails.some(x => x.includes('CLOB depth')));
assert.equal(den.qualifies, true, 'DEN ML: 60% vs 56.2c cost, edge 3.8 pts, liquid, two-sided, wins at the displayed score');
assert.equal(by['DEN -6.5'].qualifies, true);
assert.ok(Math.abs(r.marketWin.away - .545 / (.545 + .455)) < 1e-12 && Math.abs(r.marketWin.home + r.marketWin.away - 1) < 1e-12);
const none = evaluateCombined(game, null, new Map());
assert.deepEqual([none.polymarketEventId, none.candidates.length, none.marketWin], [null, 0, null]);
const unpriced = evaluateCombined(game, event, new Map());
assert.ok(unpriced.candidates.every(c => c.cost == null && !c.qualifies && c.fails.includes('no price')) && unpriced.marketWin === null);

// ---- discovery and matching use Gamma only
const urls = [];
const list = await fetchGammaNbaGames(async (u) => { urls.push(u); return [event, { slug: 'nba-champion-2027' }]; }, '2026-11-16');
assert.ok(urls.length === 1 && urls[0].startsWith('https://gamma-api.polymarket.com/events?series_slug=nba-2026') && !/jup/.test(urls[0]));
assert.equal(matchEvent(game, list.map(adaptGammaEvent)).slug, 'nba-den-por-2026-11-16');
for (const f of ['scripts/compare.mjs', 'js/markets-rules.js', 'js/markets-polymarket.js', 'scripts/discord-post.mjs'])
  assert.equal(/jup\.ag|jupiter/i.test(await fs.readFile(new URL('../' + f, import.meta.url), 'utf8')), false, `${f} still references Jupiter`);
console.log('Polymarket-only contract parsing, per-market fees, exact-ask depth, market benchmark and discovery passed');
