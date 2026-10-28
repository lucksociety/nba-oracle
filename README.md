# 🏀 NBA ORACLE V1.2 — Score Prediction Dashboard

**Live:** https://lucksociety.github.io/nba-oracle/

A static (HTML/JS, no backend) dashboard. Pick a date (defaults to today, America/New_York) and press **SIMULATE**: the page pulls that day's schedule and the injury report, rebuilds team strength, and runs a seeded possession-level Monte Carlo (100,000 games per matchup by default; 300k/500k selectable) inside Web Workers. It outputs the full NBA ORACLE V1.2 Section 16 per-game report and the Section 17 slate view.

## Zero-market firewall (Section 1)
* The model **never** fetches, reads, uses or displays odds, spreads, totals, moneylines, implied probabilities, line movement, betting percentages, picks, consensus, power indexes or other models' predictions.
* ESPN's public scoreboard/summary payloads *do* contain sportsbook fields (`odds`, `pickcenter`, `againstTheSpread`, `winprobability`, `predictor`, …). [`js/firewall.js`](js/firewall.js) strips them **unread** at ingestion: a **whitelist** sanitizer copies only named basketball fields, a recursive delete removes market-like keys, and `assertNoMarketData` throws if any survive. The data builder parses only `boxscore` from game summaries.
* `test/firewall.test.mjs` runs in CI on every data refresh and fails the build if any committed data file contains a market-like key.
* Historical calibration uses **actual final scores only**.

## Data sources (free, public, CORS-enabled)
| Data | Source | When |
|---|---|---|
| Schedule, tip times, venues, status (selected date and 3 prior days for rest) | ESPN `site.api.espn.com/.../nba/scoreboard?dates=YYYYMMDD` | Live in browser on each click; repo snapshot fallback |
| Injury report | ESPN `/nba/injuries` | Live in browser on each click; repo snapshot fallback |
| Team & player box scores (2025-26 full regular season + 2026-27 to date) | ESPN `/nba/summary?event=ID` → `boxscore` only | GitHub Actions every 30 min → `data/*.json` |

ESPN returns `Access-Control-Allow-Origin: *`, so live fetches work from the browser. The Actions workflow (`.github/workflows/update-data.yml`) refreshes box-score data, a sanitized schedule/injury snapshot, and the historical calibration, then redeploys Pages.

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

**Missing:** tracking data, lineup/on-off data, play-by-play calibration, shot-location data, coaching-tendency data, player-level fatigue/minutes loads, time-zone effects, and — most importantly — **Section 13/14 chronological walk-forward validation and calibration** (Brier, log loss, reliability, interval coverage). Until that exists, every probability is a provisional, uncalibrated model estimate, and the HIGH confidence tier is withheld. No backtesting is claimed.

## Run locally
```bash
node scripts/build-data.mjs           # refresh data/ (uses ESPN public API)
node test/firewall.test.mjs           # firewall checks
node test/e2e.mjs 2026-10-27 100000   # full slate from the command line
python3 -m http.server 8000           # then open http://localhost:8000
```

*Not betting advice. This project deliberately ignores betting markets.*
