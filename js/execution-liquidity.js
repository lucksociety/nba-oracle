// Post-forecast only. Verify depth on the venue and exact ask used to calculate EV.
import { depthAtAsk, ruleFails, RULES } from './markets-jupiter.js';
export async function verifyExecutionLiquidity(result, fetchBook) {
  for (const c of result.candidates) {
    if (c.venue !== 'Jupiter') continue;
    const failures = ruleFails(c, c.modelProb);
    c.liquiditySource = 'Jupiter'; c.depth = null; c.liquid = false; c.qualifies = false;
    if (!c.twoSided || failures.length) continue;
    try {
      const book = await fetchBook(c.marketId);
      // Never count contracts a cent above the quote without repricing the edge.
      c.depth = depthAtAsk(book, c.ask, 0);
      c.liquid = c.depth >= RULES.minDepthContracts;
      c.qualifies = c.liquid;
      c.fails = c.liquid ? [] : [`Jupiter depth at quoted ask ${c.depth} < ${RULES.minDepthContracts}`];
    } catch {
      c.fails = ['Jupiter order book unavailable; executable depth unverified'];
    }
  }
  return result;
}
