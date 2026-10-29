// Bet-selection backtest (STAGE-2 analysis only; never imported by the engine).
// Prices: Polymarket CLOB price history (last-trade/mid "p" of outcome 0 at T-90 min), outcome 1 = 1 - p.
// Assumed execution: ask = p + HALF_SPREAD, plus Jupiter's 0.07·a·(1-a) fee (bets are placed on Jupiter).
// These are approximations of executable prices — not recorded asks.
import fs from 'node:fs';
const DIR = process.env.DATA_DIR || '/workspace/bt-data';
const HALF_SPREAD = Number(process.env.HALF_SPREAD ?? 0.01), T = process.env.PRICE_T || 't90';
const teams = JSON.parse(fs.readFileSync(`${DIR}/teams.json`)); const hist = JSON.parse(fs.readFileSync(`${DIR}/polymarket-history.json`));
const nick = Object.fromEntries(Object.entries(teams).map(([id, t]) => [t.short.toLowerCase(), id]));
const etDate = iso => new Date(Date.parse(iso) - 4.5 * 3600e3).toISOString().slice(0, 10);
const pr = (h, pred) => { let w = 0, n = 0; h.counts.forEach((c, i) => { n += c; if (pred(h.min + i)) w += c; }); return w / n; };
const fee = a => 0.07 * a * (1 - a);

export function candidates(recs) {
  const idx = {}; for (const r of recs) idx[`${r.d}|${r.h}|${r.a}`] = r;
  const out = [];
  for (const [slug, e] of Object.entries(hist)) {
    const [x, y] = e.title.split(/\s+vs\.?\s+/i).map(s => nick[s.trim().toLowerCase()]); if (!x || !y) continue;
    const d = etDate(e.start); const r = idx[`${d}|${y}|${x}`] || idx[`${d}|${x}|${y}`]; if (!r || !r.mh) continue;
    const m = r.hs - r.as, tot = r.hs + r.as; const side = id => (id === r.h ? 1 : -1);
    const cands = [];
    for (const mk of e.markets) {
      const p0 = mk.p?.[T]; if (p0 == null || p0 <= 0.02 || p0 >= 0.98) continue;
      mk.outcomes.forEach((o, i) => {
        const price = i === 0 ? p0 : 1 - p0; let prob, won, label, dir;
        if (mk.type === 'moneyline') { const id = nick[o.toLowerCase()]; if (!id) return; const s = side(id); prob = pr(r.mh, v => s * v > 0); won = s * m > 0; label = `${teams[id].abbr} ML`; dir = s > 0 ? 'home' : 'away'; }
        else if (mk.type === 'spreads') { const fav = nick[(mk.q.match(/Spread:\s*(.+?)\s*\(/) || [])[1]?.toLowerCase()]; const id = nick[o.toLowerCase()]; if (!fav || !id) return; const L = Math.abs(mk.line); const fs_ = side(fav);
          const favCovers = v => fs_ * v > L; prob = id === fav ? pr(r.mh, favCovers) : 1 - pr(r.mh, favCovers); won = id === fav ? favCovers(m) : !favCovers(m); label = `${teams[id].abbr} ${id === fav ? '-' : '+'}${L}`; dir = side(id) > 0 ? 'home' : 'away'; }
        else if (mk.type === 'totals') { const over = /^over$/i.test(o); const L = mk.line; const po = pr(r.th, v => v > L); prob = over ? po : 1 - po; won = over ? tot > L : tot < L; if (tot === L) return; label = `${over ? 'O' : 'U'} ${L}`; dir = over ? 'over' : 'under'; }
        else return;
        const ask = Math.min(0.99, price + HALF_SPREAD), cost = ask + fee(ask);
        cands.push({ dir, game: `${teams[r.a].abbr}@${teams[r.h].abbr}`, d: r.d, type: mk.type, label, prob, price, ask, cost, edge: prob - cost, won, n: mk.n, mainness: Math.abs(price - 0.5) });
      });
    }
    out.push({ d: r.d, slug, cands });
  }
  return out;
}
export function select(games, rule) {
  const bets = [];
  for (const g of games) {
    const blocked = new Set(rule.dirGuard ? g.cands.filter(c => c.prob > 0.5 && c.edge > rule.maxEdge).map(c => c.dir) : []);
    let c = g.cands.filter(c => !blocked.has(c.dir) && c.prob > 0.5 && c.edge > (rule.minEdge ?? 0) && c.edge <= (rule.maxEdge ?? 9) && c.ask <= (rule.priceCap ?? 1) && (c.n ?? 0) >= (rule.minPts ?? 0) && (!rule.types || rule.types.includes(c.type)) && (!rule.mainOnly || c.mainness <= rule.mainOnly));
    if (!c.length) continue; c.sort((a, b) => b.edge - a.edge);
    bets.push(...(rule.onePerGame === false ? c : [c[0]]));
  }
  return bets;
}
export function score(bets) { let pnl = 0, staked = 0, w = 0; for (const b of bets) { staked += b.cost; pnl += (b.won ? 1 : 0) - b.cost; w += b.won ? 1 : 0; } return { n: bets.length, w, l: bets.length - w, units: pnl, roi: staked ? pnl / staked : 0, avgEdge: bets.reduce((s, b) => s + b.edge, 0) / (bets.length || 1), avgProb: bets.reduce((s, b) => s + b.prob, 0) / (bets.length || 1) }; }
