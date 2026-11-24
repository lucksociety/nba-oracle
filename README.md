# 🏀 NBA ORACLE V1.3 — Score Prediction Dashboard

> **V1.3 (2026-10-29):** the ratings are now recency-weighted (half-life 20 games), the rating prior is lighter (K 15→8), absent-player impact is larger (×1.25), and fat-tail shocks are capped at ±4 SD. Betting rules are now model > 50%, edge 3–8 pts, price ≤ 90¢, one bet per game, plus a same-direction guard. All of this comes from a walk-forward backtest; methodology and before/after numbers are in [backtest/README.md](backtest/README.md).

**Live:** https://lucksociety.github.io/nba-oracle/

The dashboard has four tabs (same layout as the soccer and NHL dashboards):

* **Simulator** (front page, `js/simulator.js`): pick one game and it runs 100,000 simulations with a fresh random seed. It shows win chances, the predicted score, margin and total bands, the most likely exact scores, the official line-ups, and the listed players who matter most. Fixing a listed player as "plays" or "sits out" re-runs the game through the same injury logic (`userAvailability` in `prepareGame`) and shows the win chance before and after. You can type a price in to see the gap; the page itself still fetches no prices.
* **Forecasts**: the full slate report described below (fixed seed, 300,000 simulations by default).
* **Results & Record**: graded forecasts against final scores (`learning/report.json`).
* **How it works**.

A static (HTML/JS, no backend) dashboard. Pick a date (defaults to today, America/New_York) and press **SIMULATE**: the page pulls that day's schedule and the injury report, rebuilds team strength, and runs a seeded possession-level Monte Carlo (300,000 games per matchup by default; 100k/500k selectable) inside Web Workers. It outputs the full NBA ORACLE V1.3 Section 16 per-game report and the Section 17 slate view.

## Calibration check (2026-11-20)
`research/calibration-check.mjs` reads walk-forward forecasts (4,000 simulations per game, absences mode, every game predicted only from earlier games) and asks whether the probabilities match what happened and whether a correction would have helped on later games. Result on 1,457 games, 21 Oct 2025 to 19 Nov 2026 (`research/calibration-check.json`):

| Question | Checks | Model said | Happened | Fitted slope [95%] | Correction on later games |
|---|---|---|---|---|---|
| Who wins | 1,457 | 66.8% | 68.9% | 1.09 [0.95, 1.27] | log loss +0.0016 (worse) |
| Margin, seven lines per game | 10,199 | 64.4% | 64.7% | 1.02 [0.96, 1.10] | +0.0002 (worse) |
| Total, seven lines per game | 10,199 | 60.9% | 60.9% | 1.01 [0.93, 1.10] | +0.0001 (worse) |

The 80% ranges held the real margin 78.6% of the time and the real total 81.0%. A slope of 1 means no correction is needed; all three intervals include 1, and a correction fitted on earlier months and applied to later months made each slightly worse. **No correction is applied.** The check uses the players who actually missed each game, which is more than a morning forecast knows. Re-run it with the commands in `backtest/README.md` followed by `node research/calibration-check.mjs out/wf-2026.json out/wf-2027.json --out research/calibration-check.json`.

## Zero-market firewall (Section 1)
* The model **never** fetches, reads, uses or displays odds, spreads, totals, moneylines, implied probabilities, line movement, betting percentages, picks, consensus, power indexes or other models' predictions.
* ESPN's public scoreboard/summary payloads *do* contain sportsbook fields (`odds`, `pickcenter`, `againstTheSpread`, `winprobability`, `predictor`, …). [`js/firewall.js`](js/firewall.js) strips them **unread** at ingestion: a **whitelist** sanitizer copies only named basketball fields, a recursive delete removes market-like keys, and `assertNoMarketData` throws if any survive. The data builder parses only `boxscore` from game summaries.
* `test/firewall.test.mjs` runs in CI on every data refresh and fails the build if any committed data file contains a market-like key.
* Historical calibration uses **actual final scores only**.

## Data sources (free, public)
| Data | Source | When |
|---|---|---|
| Schedule, tip times, venues, status (selected date and 3 prior days for rest) | ESPN `site.api.espn.com/.../nba/scoreboard?dates=YYYYMMDD` | Live on each click via the Worker proxy → direct ESPN → repo snapshot |
| Injury report | ESPN `/nba/injuries` | Live on each click via the Worker proxy → direct ESPN → repo snapshot |
| Team & player box scores (2025-26 full regular season + 2026-27 to date) | ESPN `/nba/summary?event=ID` → `boxscore` only | GitHub Actions every 30 min → `data/*.json` |

The page fetches live data through the NBA Oracle Cloudflare Worker (`/espn/scoreboard`, `/espn/injuries` only; market-like fields deleted at the proxy and again by the page's sanitizer, 60 s edge cache), then tries ESPN directly, and only then uses the snapshot. The data-sources panel shows which one was used. `scripts/build-data.mjs` retries empty/invalid ESPN responses (8 attempts, exponential backoff) and keeps the previous snapshot piece instead of failing the whole refresh. The Actions workflow (`.github/workflows/update-data.yml`) refreshes box-score data, a sanitized schedule/injury snapshot, and the historical calibration, then redeploys Pages.

## What the engine does (`js/engine.js`)
1. **Team strength (S3):** per-season possessions, ORtg/DRtg and four factors (2P%, 3P%, 3PA rate, TOV%, ORB%, FT rate, FT%) for offense and defense; iterative **opponent adjustment** with home court neutralised.
2. **Early-season Bayesian shrinkage:** current-season stats are blended with the prior season using weight `g/(g+K)` (K = 15 games for ratings; 6–25 for individual factors by how fast they stabilise). The prior season is first regressed toward league average by an amount that depends on **roster continuity** (share of this season's minutes played by returning players).
3. **Matchup four factors (S6/S7):** each offense's factors meet the opposing defense's (additive deviations from league average). A possession engine (turnover → shooting foul → 2/3-pt attempt → and-one → offensive rebound loop) turns factors into points per possession. Its scoring level is calibrated to the opponent-adjusted rating prediction; the **non-additive interaction** of the two specific profiles is kept as a matchup term. `Expected points = possessions × points per possession`; pace = `paceA × paceB / league pace`.
4. **Home court & schedule (S8):** home court (**~1.7 pts**) and back-to-back cost (**~2.1 pts**) are **fitted by ridge regression on the 1,231 2025-26 regular-season final scores** (values refresh in `data/calibration.json`). 3-in-4 (0.6), travel since last game when on ≤1 day rest (0.3 / 1000 mi, cap 1.0), altitude for DEN/UTA (0.7), OT-last-night on a B2B (0.3) are documented priors; total schedule penalty capped at 3.5 to avoid double counting.
5. **Injuries (S4/S5, simplified):** each listed player gets a box-score impact (points produced above a replacement rate per possession used, plus assists/offensive rebounds; steals/blocks/defensive rebounds/fouls for defense), compared with a replacement level estimated from 8–16 mpg players, scaled by 0.8 to reflect redistribution of minutes/usage across the rotation, and weighted by how much the player is **already present in the baseline ratings** (so long-term absences are not double-counted). Status → play probability: Out 0, Doubtful 0.25, Questionable 0.55, Probable 0.85, report-text "available" 0.93, unspecified Day-To-Day 0.6. **Scenario A/B/C** (active / restricted at 70% minutes with 25% probability / inactive) is sampled per simulated game. Injuries are not applied to past dates (that would leak post-cutoff information).
6. **Monte Carlo (S9–S11):** every simulated game plays every possession: shared pace shock (t-distributed), shared scoring-environment shock, team shooting and extra 3-pt shocks (fat-tailed t, df=5), turnover/offensive-rebound/free-throw-rate shocks with a shared whistle component, game-state feedback, garbage-time regression for big leads, late-game intentional fouling, and repeated overtime when tied. Seeded (Mulberry32) and reproducible: same date + seed → same results.
7. **Outputs:** win probs, OT prob, expected/median margin and total, P(≤5), expected scores, possessions, points per 100, 80% intervals (each team, total, margin), blowout probabilities 10/15/20/30 for each team, five most probable exact scores, five key factors with point effects, three uncertainty sources, confidence tier, integrity report (sim count, seed, cutoff, sources and timestamps, convergence: win-prob standard error and split-half difference), and the `FINAL:` line. Slate: table ranked by winner probability, up to five MODERATE-confidence leans (never forced), and a copy-paste `AWAY XXX - HOME XXX` list in schedule order.
8. **Final-score selection (S12):** the conditional **median** margin and median total (absolute-error baseline), rounded to a coherent integer pair whose sign agrees with the simulated favourite. Not the mode.

## Implemented vs. simplified vs. missing — honestly
**Implemented:** zero-market firewall; live schedule & injury verification with timestamps; opponent-adjusted four-factor team ratings; early-season shrinkage; possession-level engine; home court & B2B fitted on independent historical results; rest/3-in-4/travel/altitude; scenario-weighted injuries; correlated variance, fat tails, garbage time, OT; 100k+ seeded simulations per game; every Section 16/17 output.

**Simplified:**
* Player-level engine (S4) is a box-score impact estimate, not a per-player minutes/usage/shot projection; minutes redistribution is a single 0.8 factor rather than an explicit 240-minute allocation.
* Tactical matchups (S7) are limited to what team four factors capture (shooting, TOV, ORB, FT); no rim-protection, pick-and-roll, switching or zone data.
* Status-to-participation probabilities, restricted-minutes probabilities, travel/altitude/3-in-4 effects and variance parameters are documented priors / hand-tuned, **not** fitted out of sample. Variance was tuned so the average simulated margin SD (~13.7) is close to the 2025-26 fitted residual SD (14.0); simulated total SD (~19.8) is somewhat wider than the residual (18.4).
* Lineup status is never CONFIRMED pregame (no verified starting-lineup feed); it is PROBABLE or UNCERTAIN.
* Recent-form weighting is not separate from the season blend.

**Missing:** tracking data, lineup/on-off data, play-by-play calibration, shot-location data, coaching-tendency data, player-level fatigue/minutes loads, time-zone effects, and a live record long enough to confirm the walk-forward calibration check above on real pre-game forecasts. Until that exists, treat every probability as a model estimate, and the HIGH confidence tier is withheld. No backtesting is claimed.

## Run locally
```bash
node scripts/build-data.mjs           # refresh data/ (uses ESPN public API)
node test/firewall.test.mjs           # firewall checks
node test/e2e.mjs 2026-10-27 100000   # full slate from the command line
python3 -m http.server 8000           # then open http://localhost:8000
```

*Not betting advice. This project deliberately ignores betting markets.*

## Discord `/nba` + Polymarket best bets

```
Discord /nba ─► Cloudflare Worker (discord/worker.js)  verify Ed25519 · defer (type 5) · AES-GCM-encrypt interaction token
              └► GitHub Actions workflow_dispatch (.github/workflows/discord-nba.yml)
                   1. test/firewall.test.mjs          engine files may not reference any market source
                   2. scripts/predict.mjs             300k sims/game (worker_threads) → out/predictions.json + SHA-256 (frozen)
                   3. scripts/compare.mjs             verify hash → only now fetch Polymarket prices → out/bets.json
                   4. scripts/discord-post.mjs        interaction follow-ups (fallback: channel webhook)
```

* Engine never sees odds; predictions are hashed before the market stage runs.
* Polymarket (prices and liquidity) — public, no key: Gamma `GET https://gamma-api.polymarket.com/events?slug=nba-mia-atl-2026-10-28` (all game markets incl. every alternate line), CLOB `POST https://clob.polymarket.com/books` (order books per outcome token), `GET https://clob.polymarket.com/clob-markets/{conditionId}` (fee curve `fd`). Polymarket's NBA markets are Polymarket markets (`POLY-{gammaMarketId}-{outcomeIndex}`, same `conditionId`), so the venues are joined exactly by id. Polymarket fee = C·rate·(p(1−p))^exponent per market `feeSchedule`; NBA game markets are currently `zero_fees` (rate 0), vs. the 0.05 sports default in Polymarket's docs.
* Every full-game line is evaluated: moneyline both sides, every alternate spread both sides, every alternate total over and under (≈118–120 outcomes per game). Edge = model probability − (Polymarket ask + Polymarket fee); Polymarket ask + fee is used only when Polymarket has no usable quote, and the Discord post names the venue. A bet needs model probability > 50 %, edge > 0, a two-sided quote ≤ 10¢ wide and ≥ 10 contracts within 1¢ of the ask on the Polymarket CLOB; otherwise **NO BET**. The best line is the highest edge among those; the next three are listed for sanity checks. Edges above 15 points are flagged as likely model blind spots.
* Secrets: Worker — `GITHUB_TOKEN`, `RELAY_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_WEBHOOK_URL`; repo Actions — `RELAY_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_WEBHOOK_URL`, `DISCORD_BOT_TOKEN`, optional `JUPITER_API_KEY` (Polymarket needs no key). Nothing secret is committed.
* `/nba` has an optional `date` option with autocomplete (Today, Tomorrow and the next 5 days in ET; typed `YYYY-MM-DD`, `today`, `tomorrow` also accepted; default today). Registered as a guild command (`node discord/register-command.mjs <guildId>`); handler tests: `node discord/test-worker.mjs`.
* Local: `node scripts/predict.mjs 2026-10-28 && node scripts/compare.mjs && DRY_RUN=1 node scripts/discord-post.mjs`; `node test/sanity.mjs` for simulator verification.


### November 24 scoring calibration (V1.3.6)

A recent regulation-tempo estimate now calibrates the shared scoring level, accounting for overtime-heavy historical schedules. Equal point offsets keep the existing simulated margin/winner model intact while modestly improving historical score/total errors. Inputs remain independent of market prices. [Validation, limitations and reproduction](research/nov24/README.md).
