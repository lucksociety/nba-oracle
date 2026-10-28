import { loadInputs, prepareSlate, etToday, ESPN } from './pipeline.js';
// Live schedule/injuries go through our Cloudflare Worker (ESPN can refuse browser requests from github.io);
// direct ESPN is tried next, then the repo snapshot (refreshed ~every 30 min).
const LIVE_PROXY = 'https://nba-oracle-discord.dreiss324.workers.dev/espn';
// NBA.com's official lineups file sends no CORS header, so the browser reads it through the same Worker.
const LINEUP_PROXY = 'https://nba-oracle-discord.dreiss324.workers.dev/nba/lineups';
import { buildReport, hashSeed, MODEL_VERSION } from './engine.js';

const $ = s => document.querySelector(s);
const pct = x => (x * 100).toFixed(1) + '%';
const f1 = x => x.toFixed(1);
const fmtET = iso => iso ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(iso)) + ' ET' : '—';
const tipET = iso => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) + ' ET';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$('#date').value = etToday();
const getJSON = async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

function progress(text, p) { $('#progress').classList.remove('hidden'); $('#progText').textContent = text; if (p != null) $('#progBar').style.width = (p * 100).toFixed(1) + '%'; }

function runPool(jobs, N, onProg) {
  return new Promise((resolve, reject) => {
    const nW = Math.max(1, Math.min(jobs.length, (navigator.hardwareConcurrency || 4) - 1, 6));
    const results = new Array(jobs.length); const prog = new Array(jobs.length).fill(0); let next = 0, done = 0;
    const workers = [];
    const report = () => onProg(prog.reduce((a, b) => a + b, 0) / jobs.length, done);
    const feed = (w) => {
      if (next >= jobs.length) { w.terminate(); return; }
      const i = next++; w.cur = i; w.postMessage({ jobs: [jobs[i]], N });
    };
    for (let k = 0; k < nW; k++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        if (e.data.type === 'progress') { prog[w.cur] = e.data.p || (e.data.game ? 1 : 0); report(); }
        else if (e.data.type === 'done') { results[w.cur] = e.data.results[0]; prog[w.cur] = 1; done++; report(); if (done === jobs.length) resolve(results); else feed(w); }
      };
      w.onerror = (e) => { workers.forEach(x => x.terminate()); reject(new Error('Worker error: ' + (e.message || 'unknown'))); };
      workers.push(w); feed(w);
    }
  });
}

async function run() {
  const btn = $('#simulate'); btn.disabled = true; $('#error').classList.add('hidden');
  const date = $('#date').value || etToday(); const N = Number($('#sims').value);
  const seedBase = ($('#seed').value.trim()) || `oracle-${date}`;
  const clickAt = new Date().toISOString();
  try {
    progress('Fetching schedule, injury report and team data… (market fields are stripped at ingestion)', 0.02);
    const inputs = await loadInputs(date, getJSON, 'data', [
      { base: LIVE_PROXY, label: 'live via NBA Oracle Cloudflare proxy (market fields stripped at the proxy and again here)' },
      { base: ESPN, label: 'live, direct from ESPN' },
    ], [{ url: ymd => `${LINEUP_PROXY}/${ymd}`, label: 'live via NBA Oracle Cloudflare proxy' }]);
    const cutoff = new Date().toISOString();
    progress('Rebuilding team strength, rotations and schedule context…', 0.05);
    const slate = prepareSlate(date, inputs);
    if (!slate.games.length) {
      $('#results').classList.add('hidden');
      throw new Error(`No modelled NBA games on ${date}.` + (slate.skipped.length ? ' Skipped: ' + slate.skipped.map(s => `${s.ev.shortName} (${s.reason})`).join('; ') : ''));
    }
    const jobs = slate.games.map(g => ({ params: g.prep.params, seed: hashSeed(seedBase + ':' + g.ev.id) }));
    const t0 = performance.now();
    const res = await runPool(jobs, N, (p, d) => progress(`Running ${N.toLocaleString()} simulations × ${jobs.length} games… ${d}/${jobs.length} complete`, 0.05 + 0.95 * p));
    const elapsed = (performance.now() - t0) / 1000;
    const out = slate.games.map((g, i) => ({ ...g, date, s: res[i].s, seed: res[i].seed, r: buildReport(g.ev, g.prep, res[i].s, { applyInjuries: slate.applyInjuries, injuryNotToday: slate.injuryNotToday }) }));
    render({ date, N, seedBase, inputs, slate, out, cutoff, clickAt, elapsed });
    progress(`Done — ${(N * jobs.length).toLocaleString()} simulated games in ${elapsed.toFixed(1)}s.`, 1);
  } catch (e) {
    console.error(e); $('#error').textContent = '⚠️ ' + e.message; $('#error').classList.remove('hidden'); $('#progress').classList.add('hidden');
  } finally { btn.disabled = false; }
}

function render(ctx) {
  const { date, N, seedBase, inputs, slate, out, cutoff, elapsed } = ctx;
  $('#results').classList.remove('hidden');
  // Integrity / provenance
  const m = slate.model;
  $('#integrity').innerHTML = `
    <h2>Simulation &amp; data-integrity report <small>${esc(MODEL_VERSION)}</small></h2>
    <div class="game-body" style="padding:0">
      <div class="blk"><h3>Run</h3>
        <div class="kv"><span>Date</span><span>${esc(date)}</span></div>
        <div class="kv"><span>Data cutoff</span><span>${fmtET(cutoff)}</span></div>
        <div class="kv"><span>Simulations / game</span><span>${N.toLocaleString()} (executed in-browser)</span></div>
        <div class="kv"><span>Seed base</span><span>${esc(seedBase)}</span></div>
        <div class="kv"><span>Runtime</span><span>${elapsed.toFixed(1)} s</span></div>
      </div>
      <div class="blk span2"><h3>Sources &amp; timestamps</h3>
        ${inputs.sources.map(s => `<div class="kv"><span>${esc(s.what)} — <span class="muted">${esc(s.src)}</span></span><span>${fmtET(s.at)}</span></div>`).join('')}
        <div class="kv"><span>Team-season sample before cutoff</span><span>${m.curGames} games this season · ${m.priorGames} prior season</span></div>
      </div>
      <div class="blk wide"><h3>Status</h3><ul>
        <li>Zero-market firewall: ESPN <code>odds</code> and all market fields are deleted unread at ingestion (whitelist sanitizer + key scan). No sportsbook, consensus, expert-pick or third-party model data is used anywhere.</li>
        <li>Injuries: ${slate.applyInjuries ? (slate.injuryNotToday ? 'current ESPN report applied to a future date — statuses may change (UNCERTAIN).' : 'current ESPN report applied with scenario weighting (Out / Doubtful / Questionable / Probable).') : 'NOT applied — the current report would be post-cutoff information for a past date.'} Starting lineups are not available from a verified feed, so no game is marked CONFIRMED.</li>
        <li>Calibration: probabilities are <strong>provisional</strong>. No chronological walk-forward validation, Brier/log-loss audit or reliability curve has been run. Home court (${m.cal.homeCourtPts} pts) and back-to-back (${m.cal.backToBackPts} pts) are fitted on ${m.cal.sampleGames} prior-season results; other effects are documented priors.</li>
        ${slate.skipped.length ? `<li>Skipped: ${slate.skipped.map(s => esc(`${s.ev.shortName} — ${s.reason}`)).join('; ')}</li>` : ''}
      </ul></div>
    </div>`;
  // Slate table ranked
  const ranked = [...out].sort((a, b) => b.r.favP - a.r.favP);
  $('#slate').innerHTML = `<thead><tr><th>#</th><th>Matchup</th><th>Predicted score</th><th class="num">Winner prob.</th><th class="num">Proj. total</th><th class="num">Exp. margin</th><th>Confidence</th><th>Lineups</th></tr></thead><tbody>` +
    ranked.map((g, i) => `<tr><td>${i + 1}</td><td>${esc(g.ev.away.abbr)} @ ${esc(g.ev.home.abbr)}</td><td><strong>${esc(g.ev.away.abbr)} ${g.r.fin.away} – ${esc(g.ev.home.abbr)} ${g.r.fin.home}</strong></td><td class="num">${esc(g.r.fav.abbr)} ${pct(g.r.favP)}</td><td class="num">${f1(g.s.expTotal)}</td><td class="num">${esc(g.r.fav.abbr)} ${f1(Math.abs(g.s.expMarginHome))}</td><td><span class="tier ${g.r.confidence}">${g.r.confidence}</span></td><td><span class="status ${g.r.lineupStatus}">${g.r.lineupStatus}</span></td></tr>`).join('') + '</tbody>';
  // Leans (not forced)
  const leans = ranked.filter(g => g.r.confidence !== 'LOW').slice(0, 5);
  $('#leans').innerHTML = `<h2>Strongest independent model leans <small>max 5 · not forced</small></h2>` + (leans.length ? leans.map((g, i) => `<div class="lean"><span>${i + 1}. <strong>${esc(g.r.fav.name)}</strong> over ${esc(g.r.dog.abbr)}</span><span>${pct(g.r.favP)} · exp. margin ${f1(Math.abs(g.s.expMarginHome))}</span></div>`).join('') : '<p class="muted">The model does not support any lean at MODERATE confidence on this slate.</p>') +
    (leans.length < 5 && leans.length ? `<p class="muted" style="font-size:12.5px">Only ${leans.length} game(s) clear the MODERATE bar (≥64% and limited lineup uncertainty); no further selections are forced.</p>` : '') +
    `<p class="muted" style="font-size:12px">Leans are based only on independently simulated outcome probabilities — never on prices or outside opinions.</p>`;
  $('#sheet').value = out.map(g => g.r.sheetLine).join('\n');
  $('#games').innerHTML = out.map(gameCard).join('');
}

function gameCard(g) {
  const { ev, s, r, prep } = g; const F = prep.factors;
  const homeWins = r.fin.home > r.fin.away;
  const bo = s.blowouts; const mH = s.expMarginHome;
  const injRows = (team, list) => list.filter(p => p.p < 0.999 || p.override).map(p => `<tr><td>${esc(team)}</td><td>${esc(p.name)}</td><td>${esc(p.label)}</td><td>${(p.p * 100).toFixed(0)}%</td><td>${p.mpg ? f1(p.mpg) : '—'}</td><td>${f1(p.netPG * p.presence)}</td><td class="muted">${esc(p.comment?.slice(0, 140) || p.note || '')}</td></tr>`).join('');
  const inj = injRows(ev.away.abbr, prep.injA) + injRows(ev.home.abbr, prep.injH);
  const LU = r.lineups; const luTag = { CONFIRMED: 'Confirmed', EXPECTED: 'Expected', NONE: 'Not posted' };
  const luRow = (t, L) => `<div class="kv"><span>${esc(t.abbr)} <span class="status ${L.status === 'CONFIRMED' ? 'CONFIRMED' : L.status === 'EXPECTED' ? 'PROBABLE' : 'UNCERTAIN'}">${luTag[L.status] || esc(L.status)}</span></span><span>${L.starters.length ? L.starters.map(p => `${esc(p.name)} <span class="muted">${esc(p.pos)}</span>`).join(' · ') : '<span class="muted">no official lineup yet</span>'}</span></div>`;
  const lineupBlk = LU ? `<div class="blk span2"><h3>Starting lineups <span class="muted" style="font-weight:400">· NBA.com official</span></h3>${luRow(ev.away, LU.away)}${luRow(ev.home, LU.home)}${[LU.away, LU.home].some(L => L.inactive.length) ? `<div class="muted" style="font-size:12px">Inactive: ${esc([[ev.away.abbr, LU.away], [ev.home.abbr, LU.home]].filter(([, L]) => L.inactive.length).map(([a, L]) => `${a} ${L.inactive.join(', ')}`).join(' · '))}</div>` : ''}</div>` : '';
  const luTime = LU ? [[ev.away.abbr, LU.away], [ev.home.abbr, LU.home]].map(([a, L]) => `${a} ${luTag[L.status] || L.status}${L.updatedAt ? ' @ ' + fmtET(L.updatedAt) : ''}`).join(' · ') + ` — ${LU.away.source || ''}` : 'no official lineup used (historical date or source unavailable)';
  const actual = ev.status.completed ? `<div class="actual">Actual: ${esc(ev.away.abbr)} ${ev.away.score} – ${esc(ev.home.abbr)} ${ev.home.score} (${esc(ev.status.detail)}) · forecast frozen from pre-date data</div>` : (ev.status.state === 'in' ? `<div class="actual" style="color:var(--warn)">In progress at data cutoff (${esc(ev.status.detail)}) — model uses no in-game info</div>` : '');
  return `<article class="game" style="--ca:${esc(ev.away.color || '#1d2742')}55;--ch:${esc(ev.home.color || '#1d2742')}55">
  <div class="game-head">
    <div class="team away ${homeWins ? '' : 'win'}"><img src="${esc(ev.away.logo)}" alt=""><div><div class="nm">${esc(ev.away.name)}</div><div class="rec">${esc(ev.away.record || '')} · Away</div></div><div class="sc">${r.fin.away}</div></div>
    <div class="mid"><div class="at">@</div>${esc(tipET(ev.date))}<br>${esc(ev.venue?.name || '')}${ev.neutral ? ' (neutral)' : ''}</div>
    <div class="team home ${homeWins ? 'win' : ''}"><div class="sc">${r.fin.home}</div><div><div class="nm">${esc(ev.home.name)}</div><div class="rec">Home · ${esc(ev.home.record || '')}</div></div><img src="${esc(ev.home.logo)}" alt=""></div>
  </div>
  <div class="probbar"><div style="width:${s.awayWin * 100}%;background:${esc(ev.away.color || '#4da3ff')}"></div><div style="width:${s.homeWin * 100}%;background:${esc(ev.home.color || '#ff7a18')}"></div></div>
  <div class="probtxt"><span>${esc(ev.away.abbr)} ${pct(s.awayWin)}</span><span>${esc(ev.home.abbr)} ${pct(s.homeWin)}</span></div>
  <div class="meta-line">GAME: ${esc(ev.away.name)} @ ${esc(ev.home.name)} · DATE: ${esc(g.date)} · MODEL: NBA ORACLE V1.2 · LINEUP STATUS: <span class="status ${r.lineupStatus}">${r.lineupStatus}</span> · <span class="tier ${r.confidence}">${r.confidence} CONFIDENCE</span></div>
  ${actual ? `<div class="meta-line">${actual}</div>` : ''}
  <div class="final-line">${esc(r.finalLine)} <span class="muted" style="font-weight:400">· predicted winner: ${esc(homeWins ? ev.home.name : ev.away.name)}</span></div>
  <div class="game-body">
    <div class="blk"><h3>C · Probability forecast</h3>
      <div class="kv"><span>${esc(ev.away.abbr)} win</span><span>${pct(s.awayWin)}</span></div>
      <div class="kv"><span>${esc(ev.home.abbr)} win</span><span>${pct(s.homeWin)}</span></div>
      <div class="kv"><span>Overtime</span><span>${pct(s.otProb)}</span></div>
      <div class="kv"><span>Expected margin</span><span>${esc(mH >= 0 ? ev.home.abbr : ev.away.abbr)} ${f1(Math.abs(mH))} (median ${f1(Math.abs(s.medMarginHome))})</span></div>
      <div class="kv"><span>Expected total</span><span>${f1(s.expTotal)} (median ${f1(s.medTotal)})</span></div>
      <div class="kv"><span>Decided by ≤5</span><span>${pct(s.close5)}</span></div>
    </div>
    <div class="blk"><h3>D · Scoring projection</h3>
      <div class="kv"><span>${esc(ev.away.abbr)} expected</span><span>${f1(s.expAway)} <span class="muted">[${s.iAway[0].toFixed(0)}–${s.iAway[1].toFixed(0)}]</span></span></div>
      <div class="kv"><span>${esc(ev.home.abbr)} expected</span><span>${f1(s.expHome)} <span class="muted">[${s.iHome[0].toFixed(0)}–${s.iHome[1].toFixed(0)}]</span></span></div>
      <div class="kv"><span>Projected possessions <span class="muted">(per team, box-score est.)</span></span><span>${f1(s.expPoss)}</span></div>
      <div class="kv"><span>${esc(ev.away.abbr)} pts / 100</span><span>${f1(s.expAway / s.expPoss * 100)}</span></div>
      <div class="kv"><span>${esc(ev.home.abbr)} pts / 100</span><span>${f1(s.expHome / s.expPoss * 100)}</span></div>
      <div class="kv"><span>80% total</span><span>${s.iTotal[0].toFixed(0)}–${s.iTotal[1].toFixed(0)}</span></div>
      <div class="kv"><span>80% margin (${esc(ev.home.abbr)}−${esc(ev.away.abbr)})</span><span>${s.iMarginHome[0].toFixed(0)} to ${s.iMarginHome[1] > 0 ? '+' : ''}${s.iMarginHome[1].toFixed(0)}</span></div>
      <div class="kv"><span>Median scores</span><span>${s.medAway.toFixed(0)} – ${s.medHome.toFixed(0)}</span></div>
    </div>
    <div class="blk"><h3>E · Blowout probabilities</h3>
      <table><thead><tr><th>Wins by</th><th class="num">${esc(ev.away.abbr)}</th><th class="num">${esc(ev.home.abbr)}</th></tr></thead><tbody>
      ${bo.thresholds.map((t, i) => `<tr><td>${t}+</td><td class="num">${pct(bo.away[i])}</td><td class="num">${pct(bo.home[i])}</td></tr>`).join('')}</tbody></table>
      <h3 style="margin-top:12px">F · Most probable exact scores</h3>
      <ol>${s.topScores.map(t => `<li>${esc(ev.away.abbr)} ${t.away} – ${esc(ev.home.abbr)} ${t.home} <span class="muted">${(t.p * 100).toFixed(2)}%</span></li>`).join('')}</ol>
      <div class="muted" style="font-size:12px">${s.distinctScores.toLocaleString()} distinct final scores simulated; the official pick uses medians, not the mode.</div>
    </div>
    ${lineupBlk}
    <div class="blk span2"><h3>G · Five most important matchup factors</h3>
      <ol>${r.keyFactors.map(k => `<li><strong>${esc(k.label)}</strong>: ${esc(k.text)} <span class="muted">— ${esc(k.detail)}</span></li>`).join('')}</ol>
      <div class="muted" style="font-size:12px">Effects in points of expected margin. Four-factor rows decompose team strength (they overlap, not additive).</div>
    </div>
    <div class="blk"><h3>H · Three greatest uncertainty sources</h3><ol>${r.uncertainty.map(u => `<li>${esc(u)}</li>`).join('')}</ol></div>
    <div class="blk wide"><h3>I · Confidence &amp; J · Integrity</h3>
      <div class="kv"><span>Confidence</span><span><span class="tier ${r.confidence}">${r.confidence}</span></span></div>
      <div class="kv"><span>Simulations executed</span><span>${s.N.toLocaleString()} · seed ${g.seed} · ${s.ms} ms</span></div>
      <div class="kv"><span>Convergence</span><span>win-prob SE ±${(s.convergence.winProbSE * 100).toFixed(2)} pts · split-half diff ${(s.convergence.splitHalfDiff * 100).toFixed(2)} pts</span></div>
      <div class="kv"><span>Lineup verification</span><span>${r.lineupStatus} · ${esc(luTime)}</span></div>
      <div class="kv"><span>Schedule</span><span>${esc(ev.away.abbr)}: ${F.sA.rest}d rest${F.sA.b2b ? ', B2B' : ''}${F.sA.travelMi ? `, ${F.sA.travelMi} mi since last game` : ''} · ${esc(ev.home.abbr)}: ${F.sH.rest}d rest${F.sH.b2b ? ', B2B' : ''}</span></div>
      <div class="kv"><span>Ratings sample</span><span>${esc(ev.away.abbr)} ${prep.A.gCur} gp (${Math.round(prep.A.wCur * 100)}% weight) · ${esc(ev.home.abbr)} ${prep.H.gCur} gp (${Math.round(prep.H.wCur * 100)}% weight)</span></div>
      <div class="kv"><span>Score selection</span><span>${esc(r.fin.rule)}</span></div>
      <div class="kv"><span>Probabilities</span><span>Provisional / uncalibrated. ${esc(r.confidenceNote)}</span></div>
      ${inj ? `<details><summary>Availability inputs (${prep.injA.length + prep.injH.length} listed)</summary><table class="inj"><thead><tr><th>Team</th><th>Player</th><th>Status</th><th>P(play)</th><th>MPG</th><th>Net pts if out</th><th>Report</th></tr></thead><tbody>${inj}</tbody></table></details>` : '<div class="muted" style="font-size:12.5px">No listed injuries for either team in the report used.</div>'}
    </div>
  </div>
</article>`;
}

$('#simulate').addEventListener('click', run);
$('#copy').addEventListener('click', async () => { const t = $('#sheet'); t.select(); try { await navigator.clipboard.writeText(t.value); $('#copy').textContent = 'Copied ✓'; } catch { document.execCommand('copy'); } setTimeout(() => $('#copy').textContent = 'Copy', 1500); });
