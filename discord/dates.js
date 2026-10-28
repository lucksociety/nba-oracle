// /nba date option helpers: Discord autocomplete choices (Today / Tomorrow / next days, America/New_York)
// and parsing of whatever the user submitted (picked choice, typed YYYY-MM-DD, "today", "tomorrow").
const TZ = 'America/New_York';
export function etYMD(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
// Calendar arithmetic on a YYYY-MM-DD string (noon UTC avoids DST edges).
export function addDays(ymd, k) { const t = new Date(`${ymd}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }
const pretty = (ymd) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`)).replace(',', '');
const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

/** Choices for Discord autocomplete (max 25; name ≤100 chars, value = YYYY-MM-DD). */
export function dateChoices(typed = '', now = new Date(), days = 7) {
  const today = etYMD(now);
  const all = Array.from({ length: days }, (_, k) => { const v = addDays(today, k); return { name: k === 0 ? `Today (${pretty(v)})` : k === 1 ? `Tomorrow (${pretty(v)})` : pretty(v), value: v }; });
  const q = String(typed || '').trim().toLowerCase();
  if (!q) return all;
  const hit = all.filter((c) => c.name.toLowerCase().includes(q) || c.value.includes(q));
  const exact = parseDateOption(q, now);
  if (exact && !hit.some((c) => c.value === exact)) hit.unshift({ name: `${pretty(exact)} (${exact})`, value: exact });
  return hit.slice(0, 25);
}

/** Resolve the submitted option to YYYY-MM-DD (ET). Omitted -> today. Returns null if not understood. */
export function parseDateOption(v, now = new Date()) {
  const s = String(v ?? '').trim().toLowerCase();
  const today = etYMD(now);
  if (!s || s === 'today' || s.startsWith('today (')) return today;
  if (s === 'tomorrow' || s.startsWith('tomorrow (')) return addDays(today, 1);
  if (s === 'yesterday') return addDays(today, -1);
  const m = s.match(/(\d{4}-\d{2}-\d{2})/); if (m && valid(m[1])) return m[1];
  return null;
}
