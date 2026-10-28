// NBA ORACLE V1.2 — PERMANENT ZERO-MARKET-INFLUENCE FIREWALL (Section 1)
// ---------------------------------------------------------------------
// ESPN's public payloads carry sportsbook-derived fields (e.g. `odds`,
// `pickcenter`, `againstTheSpread`, `winprobability`, `predictor`).
// This module is the ONLY place raw ESPN payloads are turned into data the
// model sees. It works by WHITELIST: only explicitly named basketball fields
// are copied; everything else (including every market field) is dropped.
// As a second layer, `assertNoMarketData` scans the sanitized object and
// throws if any market-like key survived. Nothing here ever reads the
// contents of a market field — they are deleted unread.

export const MARKET_KEYS = [
  'odds', 'pickcenter', 'againstTheSpread', 'winprobability', 'predictor',
  'spread', 'overUnder', 'moneyline', 'moneyLine', 'betting', 'bets', 'tickets',
  'powerIndex', 'fpi', 'projection', 'matchupPredictor', 'gameProjection',
  'provider', 'favorite', 'underdog', 'line', 'lines', 'pointSpread', 'total'
];
const MARKET_RE = /odds|pickcenter|againstthespread|winprob|predictor|spread|overunder|moneyline|betting|^bets$|^tickets$|powerindex|^fpi$|matchupquality|gameprojection|sportsbook|^lines?$/i;

/** Delete market fields in place (without reading them), recursively. */
export function stripMarketFields(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return obj;
  if (Array.isArray(obj)) { for (const x of obj) stripMarketFields(x, depth + 1); return obj; }
  for (const k of Object.keys(obj)) {
    if (MARKET_RE.test(k)) { delete obj[k]; continue; }
    stripMarketFields(obj[k], depth + 1);
  }
  return obj;
}

/** Throw if any market-like key exists anywhere in a sanitized object. */
export function assertNoMarketData(obj, path = '$', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 14) return true;
  if (Array.isArray(obj)) { obj.forEach((x, i) => assertNoMarketData(x, `${path}[${i}]`, depth + 1)); return true; }
  for (const k of Object.keys(obj)) {
    if (MARKET_RE.test(k)) throw new Error(`FIREWALL VIOLATION: market-like key "${k}" at ${path}`);
    assertNoMarketData(obj[k], `${path}.${k}`, depth + 1);
  }
  return true;
}

function teamOf(c) {
  const t = c.team || {};
  return {
    id: String(t.id), abbr: t.abbreviation, name: t.displayName, short: t.shortDisplayName || t.name,
    logo: t.logo, color: t.color ? '#' + t.color : null, alt: t.alternateColor ? '#' + t.alternateColor : null,
    score: c.score != null && c.score !== '' ? Number(c.score) : null,
    record: (c.records || []).find(r => r.type === 'total' || r.name === 'overall')?.summary || null,
  };
}

/** Whitelist-sanitize one ESPN scoreboard event. Market fields are never copied. */
export function sanitizeEvent(e) {
  stripMarketFields(e);
  const c = e.competitions?.[0] || {};
  const comps = c.competitors || [];
  const home = comps.find(x => x.homeAway === 'home'), away = comps.find(x => x.homeAway === 'away');
  const st = c.status?.type || e.status?.type || {};
  const out = {
    id: String(e.id), date: e.date, name: e.name, shortName: e.shortName,
    seasonType: e.season?.type ?? null, seasonYear: e.season?.year ?? null,
    status: { state: st.state, name: st.name, detail: st.shortDetail || st.detail, completed: !!st.completed },
    venue: c.venue ? { name: c.venue.fullName, city: c.venue.address?.city, state: c.venue.address?.state } : null,
    neutral: !!c.neutralSite,
    home: home ? teamOf(home) : null, away: away ? teamOf(away) : null,
  };
  assertNoMarketData(out);
  return out;
}

export function sanitizeScoreboard(sb) {
  return (sb.events || []).map(sanitizeEvent);
}

/** Sanitize ESPN /injuries payload to basketball availability only. */
export function sanitizeInjuries(raw) {
  stripMarketFields(raw);
  const teams = {};
  for (const t of raw.injuries || []) {
    teams[String(t.id)] = (t.injuries || []).map(i => {
      const href = (i.athlete?.links || []).map(l => l.href).find(h => /\/id\/\d+/.test(h || '')) || '';
      const m = href.match(/\/id\/(\d+)/);
      return {
        athleteId: m ? m[1] : null,
        name: i.athlete?.displayName, pos: i.athlete?.position?.abbreviation || null,
        status: i.status, typeName: i.type?.name || null,
        fantasyCode: i.details?.fantasyStatus?.abbreviation || null, // availability code only (GTD/OUT etc.)
        detail: [i.details?.side, i.details?.type, i.details?.detail].filter(Boolean).join(' '),
        returnDate: i.details?.returnDate || null,
        comment: i.shortComment || '', date: i.date,
      };
    });
  }
  const out = { timestamp: raw.timestamp || null, teams };
  assertNoMarketData(out);
  return out;
}
