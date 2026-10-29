# NBA ORACLE walk-forward backtest (V1.3)

All scripts are offline research tools. The engine never imports anything market-related. `test/firewall.test.mjs` enforces this for `walkforward.mjs`, `metrics.mjs`, `grid.mjs` and `scripts/backtest-fetch.mjs`. `bets.mjs` and `fetch-polymarket-history.mjs` are stage-2 analysis only.

```
DATA_DIR=/path/bt-data node scripts/backtest-fetch.mjs 2024 2025 2026 2027        # ESPN box scores + per-game player lines
DATA_DIR=/path/bt-data node backtest/walkforward.mjs --season 2026 --mode absences --sims 4000 --out out.json
DATA_DIR=/path/bt-data node backtest/grid.mjs 2025 absences '[{}, {"shrinkK":{"rating":8}}]'   # fast analytic screening
DATA_DIR=/path/bt-data node backtest/fetch-polymarket-history.mjs 2025-10-20 2026-10-29        # price history (bet-rule study only)
```

## Protocol
* Each game is predicted using only games played before its date, plus the full prior season. HCA, B2B and residual calibration are fitted on the prior season only, and no market data enters the model.
* `team` mode uses ratings and schedule only. `absences` mode feeds regulars (≥12 mpg, on the roster in the last 10 games) who were missing from the box score in as OUT. That approximates the confirmed inactive list `/nba` reads about an hour before tip. It is optimistic compared with a morning run.
* Parameters were tuned on 2024-25 only. 2025-26 (1,231 games) and 2026-27 to date (68 games) are out of sample.

## Results (4,000 sims/game, out of sample = 2025-26 + 2026-27 to date, n = 1,299)
| mode | model | winner acc | Brier | log loss | MAE margin | MAE total | margin slope | 80% cov M / T |
|---|---|---|---|---|---|---|---|---|
| absences | V1.2 | 69.5% | 0.2048 | 0.5964 | 11.33 | 15.03 | 1.16 | 78.9 / 82.4 |
| absences | V1.3 | 68.9% | 0.2028 | 0.5913 | 11.26 | 15.01 | 1.06 | 79.2 / 82.4 |
| team | V1.2 | 68.0% | 0.2070 | 0.6014 | 11.46 | 15.15 | 1.07 | 78.9 / 82.2 |
| team | V1.3 | 67.8% | 0.2044 | 0.5955 | 11.40 | 15.16 | 0.99 | 79.0 / 81.4 |

Over the first 68 games of 2026-27 alone, V1.3 is worse (log loss 0.609 vs 0.597). That sample is too small to conclude from, and it is reported here anyway. Platt scaling fitted on 2024-25 did not improve out of sample, so it is not shipped.

## Bet rules (Polymarket price history, T-90 min last/mid price + 1¢ assumed half-spread + Jupiter fee)
On every price variant tried (T-150/T-90/T-30, 1–2¢ spread), bets whose model edge was above about 8 pts won at about the market's rate, not the model's. Bets with 3–8 pt edges were close to break-even. **No rule was reliably profitable.** V1.3 rules: model > 50%, edge 3–8 pts, price ≤ 90¢, one bet per game. Direction guard: if any >50% line backing the same side (home, away, over or under) shows an edge above 8 pts, that whole direction is blocked for the game. This was the most stable variant, about break-even across all 8 price/information variants (`bets.mjs`, rule `dirGuard`). They cut exposure; they do not create an edge.
