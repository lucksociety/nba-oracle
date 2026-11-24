# NBA regulation-tempo total calibration — November 24, 2026

## Problem and change

Season-average possession counts treat overtime-heavy teams as playing faster in regulation. Recent tempo also receives no recency weighting, unlike team offense/defense. A ten-game tempo half-life was selected on 217 games from January 15–February 14, 2026. Overtime-adjusted tempo scales each historical game's possessions by 48/(48+5×OT periods), then applies the league's prior-game mean duration to retain expected final-game scoring rather than pretending overtime never occurs.

Replacing the entire possession model's pace improved totals but worsened winner probability diagnostics. That direct challenger was rejected (pace-full-confirmation.json). The adopted model uses the new tempo only to estimate the shared scoring level. After the existing possession/endgame/availability simulation, both teams receive the same integer point offset, with independently seeded fractional rounding. Every margin, winner, spread outcome, OT flag and player-availability draw is therefore exactly preserved. Nonnegative scores and total/margin parity are enforced. This is a transparent joint score calibration, not a claim to reconstruct each possession under a new physical tempo.

The correction's inputs are earlier basketball games only, never market prices. The NBA point forecast and totals distribution use the corrected scores, and tempoCorrection metadata is frozen alongside them. Betting thresholds, fee/depth checks, calibration reserves, score agreement and roster sensitivity remain unchanged.

## Confirmation

Paired 4,000-draw simulations on 411 later 2025–26 games and 258 2026–27 games through November 23 show consistent directional score/total improvements. In the team-only mode, team MAE improved 9.4407→9.3532 and 9.6513→9.5865; total MAE 14.4848→14.4333 and 14.8510→14.7468. With the optimistic actual-participant absence proxy, team MAE improved 9.4104→9.3362 and 9.5922→9.5284; total MAE 14.5807→14.5243 and 14.8646→14.7729.

Fixed-line total Brier score improved in all four comparisons. Winner probability, winner Brier/log loss, margin histogram and fixed-line spread Brier were identical for every paired game. The gains are small; paired uncertainty intervals generally include zero. Architecture choices were reviewed against these historical periods, so they are exploratory comparative evidence, not untouched prospective confirmation. These fixed diagnostic lines are correlated and are not executable historical bets. No improved profitability or 80% win rate is claimed.

Recent tempo without OT normalization and the wholesale tempo replacement are retained as rejected screens. The selected common-score correction avoids their winner-probability regression.

## Reproduction

DATA_DIR must contain strictly independent games/players files for 2025–27, teams.json and per-game cache/lines-YEAR.json, as described in backtest/README.md. Input SHA-256s are recorded here; large raw data and per-game simulation files are excluded. run-full.py recreates direct-pace baseline/challenger comparisons (both disable tempoTotalCorrection); run-common.py enables the adopted correction. summarize-full.py and summarize-common.py create metric tables. `--from` limits evaluated games while preserving all earlier input-state updates.

Tests cover overtime normalization, prior-date exclusion, deterministic rounding, mean-offset accuracy, nonnegative scores, preserved margins and existing model/roster/Discord/firewall checks. Prospective daily grading remains the real test of future performance. No Discord messages were posted during validation.
