// scripts/cron-runner.mjs — dagelijkse sync-taak als losse container.
//
// Roept /api/cron/sync aan op een vast tijdstip (default dagelijks 07:00 UTC) en
// logt het resultaat. Vervangt de Vercel cron. Draait in de `cron`-service van
// docker-compose.yaml (zelfde image als de app, andere command).
//
// Env:
//   CRON_TARGET  volledige URL van het endpoint   (default http://app:3000/api/cron/sync)
//   CRON_SECRET  zelfde waarde als de app gebruikt
//   CRON_HOUR    uur in UTC, 0-23                  (default 7)
//   RUN_ONCE     indien gezet: één keer draaien en stoppen (handig voor tests)

const target = process.env.CRON_TARGET || 'http://app:3000/api/cron/sync';
const secret = process.env.CRON_SECRET;

function resolveHour(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 7;
}
const hour = resolveHour(process.env.CRON_HOUR);

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0,
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function runOnce() {
  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(target, {
      method: 'POST', // het endpoint accepteert elke methode; POST is expliciet
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    const body = await res.text();
    console.log(`[${startedAt}] sync → ${res.status} ${body.slice(0, 500)}`);
  } catch (err) {
    console.error(`[${startedAt}] sync faalde:`, err?.message || err);
  }
}

function schedule() {
  const delay = msUntilNextRun();
  const nextAt = new Date(Date.now() + delay).toISOString();
  console.log(`Volgende sync: ${nextAt} (over ${Math.round(delay / 60000)} min)`);
  setTimeout(async () => {
    await runOnce();
    schedule();
  }, delay);
}

if (!secret) {
  console.warn('CRON_SECRET niet gezet — de app weigert de call als daar wél een secret is ingesteld.');
}

if (process.env.RUN_ONCE) {
  console.log(`RUN_ONCE: eenmalige sync → ${target}`);
  await runOnce();
} else {
  console.log(`Cron-runner gestart → ${target} (dagelijks ${String(hour).padStart(2, '0')}:00 UTC)`);
  schedule();
}
