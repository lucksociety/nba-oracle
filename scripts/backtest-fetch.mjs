#!/usr/bin/env node
// Fetch historical seasons (box scores + per-game player lines) for the walk-forward backtest.
// Usage: DATA_DIR=/path node scripts/backtest-fetch.mjs 2024 2025   (ESPN season year N = (N-1)-N season)
import fs from 'node:fs/promises';
import path from 'node:path';
const dir = process.env.DATA_DIR; if (!dir) throw new Error('set DATA_DIR (keeps backtest data out of the site data/ folder)');
await fs.mkdir(path.join(dir, 'cache'), { recursive: true });
const { buildSeason } = await import('./build-data.mjs');
const teamMeta = {};
for (const s of process.argv.slice(2).map(Number)) await buildSeason(s, new Date(), teamMeta);
await fs.writeFile(path.join(dir, 'teams.json'), JSON.stringify(teamMeta));
