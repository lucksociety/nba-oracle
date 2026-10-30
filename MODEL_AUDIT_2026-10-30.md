# NBA availability and simulation review — October 30, 2026

NBA ORACLE V1.3.1 retains the V1.3 rating weights, variance settings, 300,000 simulations per matchup, and tested market filters. No dashboard layout changes.

The live ESPN feed has conflicting broad categories and game-status codes. For example, Cameron Johnson and Marcus Smart had `status=Out` with `fantasyCode=GTD` and a current questionable report; Santi Aldama and Tarik Biberovic had the same categories with doubtful reports. An explicit OUT code continues to mean no participation. Only GTD allows reconciling the broad category with the current report. An expected starting five no longer increases an explicitly questionable player from 55% to 85%, downgrades a firm Out to questionable, or lifts doubtful players. Confirmed lineups can resolve an earlier report, but a later injury update takes precedence over an earlier lineup.

The predictor archives its exact sanitized basketball inputs and their SHA-256 beside the frozen predictions. This permits prospective replay without substituting later injury or roster data. Predictions include the input hash. The comparison stage also checks the actual clock against tip-off, so a cached pregame status cannot recommend a live-market bet after tip.

Validation:

- Provider-conflict, expected/confirmed starter, and late-scratch regressions pass.
- Existing firewall, history cutoff, data recovery, signed Discord dispatch, auto-post, and 8 Python prospective/evergreen tests pass.
- 44 simulator checks on two October 30 matchups pass: reproducibility, 100k/500k convergence, home/away symmetry, overtime resolution, score identities, and scoring-target agreement.
- Paired 100k-simulation replays of all 10 October 30 games use identical saved live inputs and seeds. Five games have identical outputs; five move modestly after availability fixes. Houston–Dallas home win probability changes from 32.207% to 32.610% in this replay. This measures implementation impact, not realized accuracy.
- A chronological 71-game 2026-27 replay at 4,000 simulations per game produces identical baseline/revised records (Brier 0.217244, log loss 0.617773, winner accuracy 59.15%). That historical absence-proxy replay does not contain expected-lineup snapshots, so it establishes no regression, not an estimated gain from the availability correction. The published 1,299-game V1.3 validation remains the basis for retained parameters.

NBA official injury-report guidance states that game-day reports are updated continually: https://official.nba.com/nba-injury-report-2026-27-season/. Rerun the command close to tip for new availability information; morning projections are not confirmed lineups. New input archives support future results-based assessment without retrospective injury leakage.
