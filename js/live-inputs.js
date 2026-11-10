// Validate source structure and report age before marking a live refresh successful.
// HTTP 200 alone is not evidence of current basketball availability.
export const MAX_INJURY_AGE_MS=30*60*1000;
export function validateInjuryFeed(raw,now=Date.now()) {
  const at=Date.parse(raw?.timestamp);
  if (!Array.isArray(raw?.injuries) || (raw.status!=null && raw.status!=='success')) throw new Error('injury feed schema/status unavailable');
  if (!Number.isFinite(at) || at>now+60000 || now-at>MAX_INJURY_AGE_MS) throw new Error('injury report timestamp missing, future-dated or older than 30 minutes');
  for(const team of raw.injuries) {
    if(!/^\d+$/.test(String(team?.id ?? '')) || !Array.isArray(team.injuries))throw new Error('injury team schema unavailable');
    for(const p of team.injuries)if(typeof p?.athlete?.displayName!=='string' || !p.athlete.displayName.trim() || typeof p.status!=='string')throw new Error('injury player schema unavailable');
  }
  return raw;
}
export function validateScoreboard(raw) {
  if(!Array.isArray(raw?.events))throw new Error('scoreboard schema unavailable');
  return raw;
}
export function validateLineupFeed(raw) {
  if(!Array.isArray(raw?.games))throw new Error('lineup schema unavailable');
  for(const g of raw.games)for(const side of ['homeTeam','awayTeam'])if(!Array.isArray(g?.[side]?.players))throw new Error('lineup team schema unavailable');
  return raw;
}
export function inputBetBlock(pred,now=Date.now()) {
  if(pred.availabilityRefresh?.injuriesLive===false)return 'Live injury refresh failed validation — rerun when current availability can be verified';
  if(pred.availabilityRefresh?.injuryReportAt){const at=Date.parse(pred.availabilityRefresh.injuryReportAt);if(!Number.isFinite(at)||at>now+60000||now-at>MAX_INJURY_AGE_MS)return 'Injury report is no longer current at price comparison — rerun the model';}
  if(pred.availabilityRefresh?.scheduleLive===false)return 'Live schedule refresh failed validation — saved forecast only; no verified pregame bet';
  return null;
}
