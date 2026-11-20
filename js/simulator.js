// Simulator tab: one game at a time. Pick the game, optionally fix a listed player as playing or sitting out, and run the
// same possession-level model as the Forecasts tab. Model output only: this file reads no prices; the user may type one in.
import { prepareGame, buildReport, hashSeed } from './engine.js';
import { shiftDate } from './pipeline.js';

const N = 100000;
const $ = id => document.getElementById(id);

export function initSimulator({ fetchSlate, tipET, esc, pct, f1 }) {
  let pack = null, cur = -1, picks = {}, runs = 0, running = false, again = false, last = null, price = { away: '', home: '' }, loadId = 0;
  const game = () => (pack && pack.slate.games[cur]) || null;
  const worth = p => p.netPG * p.presence;

  function runJobs(jobs) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = e => { if (e.data.type === 'done') { w.terminate(); resolve(e.data.results); } };
      w.onerror = e => { w.terminate(); reject(new Error(e.message || 'the simulation worker failed')); };
      w.postMessage({ jobs, N });
    });
  }
  const changedText = g => [...g.prep.injA, ...g.prep.injH].filter(p => picks[p.athleteId]).map(p => `${p.name} ${picks[p.athleteId] === 'in' ? 'plays' : 'sits out'}`);

  async function run() {
    const g = game(); if (!g) return;
    if (running) { again = true; return; }
    running = true; again = false; const btn = $('sim-run'); btn.disabled = true; btn.textContent = 'Running…';
    $('sim-info').textContent = `simulating ${N.toLocaleString()} games…`;
    const mine = cur, minePack = pack, t0 = performance.now();
    try {
      const changed = changedText(g);
      const prep = changed.length ? prepareGame(g.ev, { ...pack.slate.context, userAvailability: { ...picks } }) : g.prep;
      const seed = hashSeed(`sim:${Date.now()}:${Math.random()}`);
      const jobs = [{ params: prep.params, seed, bands: true }];
      if (changed.length) jobs.push({ params: g.prep.params, seed });        // same seed: the difference is the roster, not chance
      const res = await runJobs(jobs);
      if (mine === cur && minePack === pack) {
        runs++;
        last = { s: res[0].s, base: res[1] ? res[1].s : null, changed, prep,
          r: buildReport(g.ev, prep, res[0].s, { applyInjuries: pack.slate.applyInjuries, injuryNotToday: pack.slate.injuryNotToday }) };
        $('sim-info').textContent = `run ${runs} finished ${new Date().toLocaleTimeString()} · ${N.toLocaleString()} simulated games in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
        render();
      } else again = true;
    } catch (e) { $('sim-info').textContent = 'the simulation failed: ' + e.message; }
    running = false; btn.disabled = false; btn.textContent = `Run ${N.toLocaleString()} simulations again`;
    if (again) run();
  }

  function bands(el, labels, probs, awayCount) {
    const mx = Math.max(...probs, 1e-9);
    $(el).innerHTML = labels.map((l, i) => `<span>${esc(l)}</span><span class="tr"><i class="${i < awayCount ? 'aw' : ''}" style="width:${(100 * probs[i] / mx).toFixed(1)}%"></i></span><span>${pct(probs[i])}</span>`).join('');
  }
  function render() {
    const g = game(); if (!g || !last) return; const { s, r, base, changed } = last, ev = g.ev, A = ev.away.abbr, H = ev.home.abbr;
    $('sim-title').firstChild.textContent = `${A} at ${H} `;
    $('sim-bar').innerHTML = `<div style="width:${s.awayWin * 100}%;background:#7f9a8b"></div><div style="width:${s.homeWin * 100}%;background:var(--gold)"></div>`;
    $('sim-bartxt').innerHTML = `<span>${esc(A)} ${pct(s.awayWin)}</span><span>${esc(H)} ${pct(s.homeWin)}</span>`;
    const rows = [['away', `${ev.away.name} win`, s.awayWin], ['home', `${ev.home.name} win`, s.homeWin]];
    $('sim-odds').innerHTML = rows.map(([k, nm, p]) => `<tr><td>${esc(nm)}</td><td class="num"><b>${pct(p)}</b></td><td class="num"><input id="sim-price-${k}" type="number" min="1" max="99" step="0.5" value="${esc(price[k])}" aria-label="Your price for ${esc(nm)} in cents"></td><td class="num" id="sim-gap-${k}">—</td></tr>`).join('');
    rows.forEach(([k, , p]) => { const f = () => { price[k] = $('sim-price-' + k).value; const v = parseFloat(price[k]), el = $('sim-gap-' + k);
        if (!(v > 0)) { el.textContent = '—'; el.className = 'num'; return; } const d = p * 100 - v; el.textContent = (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + ' pts'; el.className = 'num ' + (d > 0 ? 'pos' : 'neg'); };
      $('sim-price-' + k).addEventListener('input', f); f(); });
    const homeFav = s.homeWin >= 0.5, fav = homeFav ? H : A, mH = s.expMarginHome;
    $('sim-kv').innerHTML = [[`${A} ${r.fin.away} – ${r.fin.home} ${H}`, 'Predicted score'], [`${mH >= 0 ? H : A} by ${f1(Math.abs(mH))}`, 'Expected margin'], [f1(s.expTotal), 'Expected total'],
      [pct(s.otProb), 'Goes to overtime'], [pct(s.close5), 'Decided by 5 or fewer'], [pct((homeFav ? s.blowouts.home : s.blowouts.away)[0]), `${fav} by 10 or more`]]
      .map(([b, l]) => `<div><span>${esc(l)}</span><b>${esc(b)}</b></div>`).join('');
    bands('sim-margin', [`${A} by 20+`, `${A} by 15–19`, `${A} by 10–14`, `${A} by 5–9`, `${A} by 1–4`, `${H} by 1–4`, `${H} by 5–9`, `${H} by 10–14`, `${H} by 15–19`, `${H} by 20+`], s.bands.margin, 5);
    const b0 = s.bands.total.base;
    bands('sim-total', [`Under ${b0}`, ...[0, 1, 2, 3, 4].map(k => `${b0 + 10 * k}–${b0 + 10 * k + 9}`), `${b0 + 50} or more`], s.bands.total.p, 0);
    $('sim-band-note').textContent = `Eight games in ten land between ${s.iTotal[0].toFixed(0)} and ${s.iTotal[1].toFixed(0)} total points. Sampling error on the win chance is about ±${(196 * s.convergence.winProbSE).toFixed(1)} points.`;
    $('sim-top').innerHTML = s.topScores.map(t => `<tr><td>${esc(A)} ${t.away} – ${t.home} ${esc(H)}</td><td class="num">${(t.p * 100).toFixed(2)}%</td></tr>`).join('');
    lineups(r);
    note(base ? `<b class="on">Your choice applied.</b> ${esc(changed.join('; '))}. ${esc(ev.home.name)} win chance ${pct(base.homeWin)} as reported, ${pct(s.homeWin)} with your choice.` : null);
  }
  function note(extra) {
    const g = game(); if (!g) return; const ev = g.ev, sl = pack.slate;
    const when = ev.status.completed ? `Final: ${ev.away.abbr} ${ev.away.score} – ${ev.home.score} ${ev.home.abbr}.` : ev.status.state === 'in' ? `In progress (${ev.status.detail}); the model uses no in-game information.` : `Tip-off ${tipET(ev.date)}.`;
    const inj = sl.applyInjuries ? (sl.injuryNotToday ? 'Uses today\'s injury report for a future date, so statuses may change.' : 'Uses the current injury report and official line-ups.') : 'Past date: the injury report is not applied.';
    const src = pack.inputs.live ? 'Schedule and injuries read live.' : 'Live data could not be read; using the stored copy, refreshed about every 30 minutes.';
    $('sim-note').innerHTML = `<b>${esc(ev.away.name)} at ${esc(ev.home.name)}</b>${ev.venue?.name ? ' · ' + esc(ev.venue.name) : ''}. ${esc(when)}<br>${esc(inj)} ${esc(src)} Probabilities are the model's own; see Results & Record for how they have held up.${extra ? '<br>' + extra : ''}`;
  }
  function availability(g) {
    const el = $('sim-avail'), sl = pack.slate;
    if (!sl.applyInjuries) { el.innerHTML = '<p class="muted sim-small" style="margin:0">Past date: the injury report is not applied, so there is nothing to change.</p>'; return; }
    const list = [[g.ev.away.abbr, g.prep.injA], [g.ev.home.abbr, g.prep.injH]].flatMap(([ab, l]) => l.filter(p => p.mpg > 0).map(p => ({ ab, p })))
      .sort((x, y) => Math.abs(worth(y.p)) - Math.abs(worth(x.p))).slice(0, 12);
    if (!list.length) { el.innerHTML = '<p class="muted sim-small" style="margin:0">No players with NBA minutes are on the injury report for this game.</p>'; return; }
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Player</th><th>Report</th><th class="num" title="Points per game the team loses when he is out, by the model's box-score estimate">Worth</th><th>In this run</th></tr></thead><tbody>${list.map(({ ab, p }) =>
      `<tr><td>${esc(p.name)} <span class="muted">${esc(ab)}</span></td><td>${esc(p.label)} <span class="muted">${(p.p * 100).toFixed(0)}% to play</span></td><td class="num">${f1(worth(p))}</td><td><select data-ath="${esc(p.athleteId)}" aria-label="Availability for ${esc(p.name)}"><option value="">As reported</option><option value="in"${picks[p.athleteId] === 'in' ? ' selected' : ''}>Plays</option><option value="out"${picks[p.athleteId] === 'out' ? ' selected' : ''}>Sits out</option></select></td></tr>`).join('')}</tbody></table></div>
      <p class="muted sim-small">The twelve listed players who matter most. Worth is the model's estimate from box scores, not a measured value.</p>`;
    el.querySelectorAll('select').forEach(s => s.addEventListener('change', () => { if (s.value) picks[s.dataset.ath] = s.value; else delete picks[s.dataset.ath]; run(); }));
  }
  function lineups(r) {
    const g = game(), LU = r && r.lineups, tag = { CONFIRMED: 'Confirmed', EXPECTED: 'Expected', NONE: 'Not posted' };
    if (!LU) { $('sim-xi').innerHTML = '<p class="muted sim-small" style="margin:0">No official line-up is available for this date.</p>'; return; }
    $('sim-xi').innerHTML = [[g.ev.away, LU.away], [g.ev.home, LU.home]].map(([t, L]) => `<div class="kv"><span>${esc(t.abbr)} <span class="status ${L.status === 'CONFIRMED' ? 'CONFIRMED' : L.status === 'EXPECTED' ? 'PROBABLE' : 'UNCERTAIN'}">${tag[L.status] || esc(L.status)}</span></span><span>${L.starters.length ? L.starters.map(p => `${esc(p.name)} <span class="muted">${esc(p.pos)}</span>`).join(' · ') : '<span class="muted">no official line-up yet</span>'}</span></div>`).join('')
      + ([LU.away, LU.home].some(L => L.inactive.length) ? `<p class="muted sim-small">Inactive: ${esc([[g.ev.away.abbr, LU.away], [g.ev.home.abbr, LU.home]].filter(([, L]) => L.inactive.length).map(([a, L]) => `${a} ${L.inactive.join(', ')}`).join(' · '))}</p>` : '');
  }
  function clear(msg) {
    ['sim-bar', 'sim-bartxt', 'sim-odds', 'sim-kv', 'sim-margin', 'sim-total', 'sim-top', 'sim-avail', 'sim-xi'].forEach(i => { $(i).innerHTML = ''; });
    $('sim-band-note').textContent = ''; $('sim-info').textContent = ''; $('sim-title').firstChild.textContent = 'Simulation '; $('sim-note').textContent = msg;
  }
  function pick(i) {
    cur = i; picks = {}; last = null; price = { away: '', home: '' };
    const g = game(); if (!g) { $('sim-run').disabled = true; return; }
    $('sim-run').disabled = false; clear(''); note(); availability(g); run();
  }
  function setSlate(p) {
    pack = p; const gs = p.slate.games, sel = $('sim-game'), keep = game() && game().ev.id;
    sel.innerHTML = gs.length ? gs.map((g, i) => `<option value="${i}">${esc(tipET(g.ev.date) + ' · ' + g.ev.away.name + ' at ' + g.ev.home.name + (g.ev.status.completed ? ' (final)' : ''))}</option>`).join('') : '<option value="">No games on this date</option>';
    let i = gs.findIndex(g => g.ev.id === keep); if (i < 0) i = gs.findIndex(g => g.ev.status.state === 'pre'); if (i < 0) i = gs.length ? 0 : -1;
    if (i < 0) { cur = -1; $('sim-run').disabled = true; clear(`No modelled NBA games on ${p.date}.` + (p.slate.skipped.length ? ' Skipped: ' + p.slate.skipped.map(s => `${s.ev.shortName} (${s.reason})`).join('; ') + '.' : '') + ' Choose another date.'); return; }
    sel.value = String(i);
    if (gs[i].ev.id === keep && last) { note(); availability(gs[i]); } else pick(i);
  }
  async function load(date, { jump = false } = {}) {
    const id = ++loadId; cur = -1; $('sim-run').disabled = true; $('sim-game').innerHTML = '<option value="">Loading games…</option>';
    clear('Loading schedule, injury report and team data…');
    try {
      let p = await fetchSlate(date);
      // No games on the opening day: show the next day that has some, so the page is never empty on arrival.
      for (let k = 1; jump && !p.slate.games.length && k <= 3; k++) { const d = shiftDate(date, k), q = await fetchSlate(d); if (q.slate.games.length) { p = q; document.getElementById('date').value = d; } }
      if (id === loadId) setSlate(p);
    } catch (e) { if (id === loadId) { $('sim-game').innerHTML = '<option value="">No games loaded</option>'; clear('The games could not be loaded: ' + e.message); } }
  }
  $('sim-game').addEventListener('change', () => pick($('sim-game').value === '' ? -1 : +$('sim-game').value));
  $('sim-run').addEventListener('click', run);
  return { load, setSlate, open(eventId) { const i = pack ? pack.slate.games.findIndex(g => String(g.ev.id) === String(eventId)) : -1; if (i >= 0) { $('sim-game').value = String(i); pick(i); } } };
}
