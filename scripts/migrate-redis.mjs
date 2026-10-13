// scripts/migrate-redis.mjs — eenmalige datamigratie.
//
// Kopieert ALLE keys van Upstash (bron) naar de self-hosted Redis-stack, via de
// SRH REST-proxy (doel). Beide kanten gebruiken hetzelfde @upstash/redis-protocol,
// dus er is geen extra dependency nodig.
//
// Idempotent: opnieuw draaien overschrijft de keys met dezelfde waarde.
//
// Gebruik (lokaal, met een draaiende SRH-proxy):
//   SRC_URL="https://xxx.upstash.io" SRC_TOKEN="..." \
//   DST_URL="http://localhost:8079"  DST_TOKEN="..." \
//   node scripts/migrate-redis.mjs
//
// Of binnen de compose-stack op Coolify:
//   docker compose run --rm \
//     -e SRC_URL="https://xxx.upstash.io" -e SRC_TOKEN="..." \
//     -e DST_URL="http://redis-rest:80"   -e DST_TOKEN="$REDIS_TOKEN" \
//     app node scripts/migrate-redis.mjs

import { Redis } from '@upstash/redis';

const { SRC_URL, SRC_TOKEN, DST_URL, DST_TOKEN } = process.env;
if (!SRC_URL || !SRC_TOKEN || !DST_URL || !DST_TOKEN) {
  console.error('Vereist: SRC_URL, SRC_TOKEN, DST_URL, DST_TOKEN');
  process.exit(1);
}

const src = new Redis({ url: SRC_URL, token: SRC_TOKEN });
const dst = new Redis({ url: DST_URL, token: DST_TOKEN });

// SCAN in batches; het SDK-antwoord is een [cursor, keys]-tuple (met fallback
// voor het object-vorm-antwoord, voor de zekerheid).
async function scanAll(client) {
  const keys = [];
  let cursor = 0;
  do {
    const res = await client.scan(cursor, { match: '*', count: 100 });
    const [next, batch] = Array.isArray(res) ? res : [res?.cursor, res?.keys];
    cursor = Number(next) || 0;
    if (Array.isArray(batch)) keys.push(...batch.map(String));
  } while (cursor !== 0);
  return keys;
}

const keys = await scanAll(src);
console.log(`${keys.length} keys gevonden in de bron.`);

let copied = 0;
let skipped = 0;
for (const key of keys) {
  const value = await src.get(key);
  if (value === null || value === undefined) {
    skipped++;
    continue;
  }
  // TTL meenemen zodat sessies/caches dezelfde levensduur houden.
  const ttl = await src.ttl(key).catch(() => -1);
  if (typeof ttl === 'number' && ttl > 0) {
    await dst.set(key, value, { ex: ttl });
  } else {
    await dst.set(key, value);
  }
  copied++;
  if (copied % 25 === 0) console.log(`  ${copied}/${keys.length} gekopieerd…`);
}

console.log(`Klaar: ${copied} keys gekopieerd, ${skipped} overgeslagen (leeg).`);
