# Rotation evaluation — 2026-11-22

NBA v1.3.5 freezes expected minutes alongside each prediction and grades them after official results. Central score targets and betting gates remain unchanged. Recent three-game minutes receive 80% weight; the last 20-game average receives 20%. Player capacity, resolved availability probabilities, known absences and confirmed lineups constrain the 240-minute team budget. Missing recent boxes or unknown starters are labeled rather than guessed.

The 2026–27 historical screen (241 games) reduced misallocated regulation minutes per team from 85.54 to 60.03 without knowing current participants. This metric is half the L1 distance to normalized actual minutes, not point-score error. A separately labeled optimistic actual-participant proxy improved 52.82 to 37.23. Neither is a live injury-history reconstruction.

The bounded player-profile score challenger was rejected: blind team score MAE worsened 9.412 to 9.456 on later 2025–26 games and 9.579 to 9.685 on 2026–27. No NBA score-accuracy or profitability improvement is claimed. Daily prospective reports now record score errors plus recent-versus-baseline minute error.

Research uses strictly earlier completed box scores, shrunk player box profiles, and chronological training/development. Actual participants are only an optimistic comparison. JSON files retain candidate and rejection evidence. Reproduction scripts expect ROTATION_RESEARCH_ROOT pointing at a workspace with nba-oracle/, college/, nba-history/, baseline JSON and generated rotation-feature files; large downloaded data are intentionally not committed. Run rotation_research.py nba, then impact_research.py nba. Historical screens are exploratory evidence; prospective monitoring is the promotion gate for further score changes.
