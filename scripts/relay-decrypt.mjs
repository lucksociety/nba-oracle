// Decrypts the Discord interaction token relayed by the Cloudflare Worker (AES-256-GCM, key = SHA-256(RELAY_KEY)).
// Prints nothing secret: writes INTERACTION_TOKEN (masked) to $GITHUB_ENV.
import fs from 'node:fs/promises';
const payload = process.env.RELAY_PAYLOAD || '', secret = process.env.RELAY_KEY || '';
if (!payload) { console.log('no relay payload (manual run)'); process.exit(0); }
if (!secret) throw new Error('RELAY_KEY secret missing');
const raw = Buffer.from(payload, 'base64url'); const iv = raw.subarray(0, 12), ct = raw.subarray(12);
const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
const msg = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)));
if (Date.now() - msg.ts > 15 * 60 * 1000) { console.log('relayed interaction token already expired; will use channel webhook'); process.exit(0); }
console.log(`::add-mask::${msg.token}`);
if (process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, `INTERACTION_TOKEN=${msg.token}\nREQUESTED_BY=${String(msg.user || '').replace(/[^\w .#-]/g, '')}\n`);
console.log('interaction token decrypted and masked');
