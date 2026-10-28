#!/usr/bin/env node
// Registers (or updates) the /nba slash command. Production uses the guild command (instant updates):
//   node discord/register-command.mjs 780172495268610059   (no arg = global; do not keep both or Discord shows duplicates)
// Reads DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN from env.
// Usage: DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node discord/register-command.mjs [guildId]
const app = process.env.DISCORD_APPLICATION_ID, tok = process.env.DISCORD_BOT_TOKEN, guild = process.argv[2];
if (!app || !tok) { console.error('Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN'); process.exit(1); }
const cmd = {
  name: 'nba', type: 1, description: "Run NBA ORACLE V1.2 on today's slate: score predictions + Jupiter best bets",
  options: [{ type: 3, name: 'date', description: 'Pick Today / Tomorrow / another day, or type YYYY-MM-DD (default: today, ET)', required: false, autocomplete: true, max_length: 40 }],
  integration_types: [0], contexts: [0],
};
const url = guild ? `https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands` : `https://discord.com/api/v10/applications/${app}/commands`;
const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bot ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
const j = await r.json().catch(() => ({}));
if (!r.ok) { console.error('register failed', r.status, JSON.stringify(j).slice(0, 300)); process.exit(1); }
console.log(`registered /${j.name} (id ${j.id}) ${guild ? 'in guild ' + guild : 'globally'}`);
