# Model and Discord review — 2026-10-29

Recency weighting now sorts games chronologically; both prior/current seasons honor the date cutoff. Postponed/cancelled fixtures are skipped. A thrown GitHub/network exception now completes the deferred command reply with an explicit error.

Validation: history invariance/cutoff tests, firewall/lineups, signed Worker dispatch/error handling, and auto-post tests pass. A 68-game 2026-27 walk-forward replay at 4,000 simulations/game gives identical baseline/revised probabilities: Brier 0.213484, log loss 0.609120, winner accuracy 60.29%. This establishes no regression on that sample, not an accuracy increase. Historical absence mode uses postgame participation as a proxy for pregame inactives and is optimistic relative to a morning forecast.

Further optimization should tune on earlier seasons and evaluate on a new untouched chronological window. Preserve point-in-time player aggregates and injury snapshots; current aggregate player files cannot reconstruct old roster information by themselves.

A read-only PR workflow now runs the model/command regressions. No dashboard presentation files were changed.

## Deployment prerequisites

Merge after checks pass. Redeploy the existing Worker for NBA/NHL/LoL changes as applicable; restart the NFL gateway bot after updating its checkout. Live Discord delivery, command registration and hosted secret state have not been verified by these offline tests.
