# Projectmanager — Coolify + Redis

Project management webapp:
- Geschreven uren uit **Moneybird** automatisch synchroniseren per project.
- Per project urenverbruik bekijken met grafieken (uren in de tijd, per medewerker).
- Nieuw project aanmaken via **PDF-upload** — Claude leest beschikbare uren, fases, beschrijving,
  uurtarief en uitzonderingen automatisch uit het document.
- **Planning** pagina: per medewerker zichtbaar welke projecten lopen, hoeveel uren resterend,
  en welke nieuwe (future) projecten aan ze zijn toegewezen.
- **Status** per project: In progress / On hold / Done / Future.
- Inloggen als **Admin** of **Projectmanager** (PM ziet alleen eigen projecten).
- Automatische waarschuwings-mails via **Resend**:
  - Bij overschrijden van configureerbare uren-drempels (waarschuwing / kritiek / overschreden).
  - Bij weer geschreven uren na inactiviteit op een project (configureerbare drempel in dagen).

Bouwstenen: Node.js/**Express** server, **Redis** (self-hosted of Upstash), statische
HTML/CSS/JS frontend, Chart.js voor grafieken, een **Coolify Scheduled Task** voor de
periodieke sync. Gedeployed als **Docker Compose**-stack op **Coolify**.

## Architectuur

De `api/**` bestanden zijn geschreven in Vercel's serverless-stijl
(`export default async function handler(req, res)` met `res.status().json()`).
`server.js` is een dunne Express-host die dit contract nabootst:

- statische bestanden uit `public/` serveren;
- Vercel's file-based routing van `api/**` (incl. `[action]`/`[id]`/`[resource]` params)
  via een expliciete routetabel;
- Express levert `.status()`/`.json()`/`.send()`/`.setHeader()` al, dus de handlers
  blijven ongewijzigd.

De stack (`docker-compose.yaml`):

| Service      | Rol |
|--------------|-----|
| `app`        | Express-server (`server.js`), bouwt uit de `Dockerfile` |
| `redis`      | self-hosted Redis, AOF-persistentie op een volume |
| `redis-rest` | Upstash-compatibele REST-proxy (**SRH**) — zie "Database" |
| `cron`       | sidecar die dagelijks de sync aanroept — zie "Cron" |

## Lokaal draaien

**Met npm** (tegen bestaande Redis/Upstash):
```sh
cp .env.example .env   # vul de waarden in
npm install
npm run dev            # http://localhost:3000
```

**Met Docker Compose** (volledige stack, inclusief Redis):
```sh
cp .env.example .env   # vul REDIS_TOKEN + de overige waarden in
docker compose up --build
```

## Verhuizen naar GitLab

1. Maak een **leeg** GitLab-project aan (zonder README/`.gitignore`, om een divergerende
   history te voorkomen).
2. Voeg een SSH-key of access token toe in GitLab.
3. In deze map:
   ```sh
   git remote rename origin github        # oude remote bewaren (optioneel)
   git remote add origin git@gitlab.com:<namespace>/<repo>.git
   git push -u origin --all
   git push origin --tags
   ```

## Deployen op Coolify (Docker Compose)

1. **New Resource → Docker Compose** → koppel de GitLab-repo, kies de branch (`main`) en
   compose-bestand `docker-compose.yaml`.
2. **Environment Variables** — voeg toe (zie `.env.example`):
   - `REDIS_TOKEN` (willekeurige string; wordt zowel het proxy-token als het app-token)
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`
   - `MONEYBIRD_API_TOKEN`, `MONEYBIRD_ADMINISTRATION_ID`
   - `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (bv. `claude-sonnet-4-5`)
   - `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
   - `CRON_SECRET` (willekeurige string) en optioneel `CRON_HOUR` (UTC, default 7)
   - blijf je voorlopig op Upstash? Zet dan `UPSTASH_REDIS_REST_URL` / `_TOKEN` en volg
     de instructie in de `app`-service in de compose-comments.
3. **Domain:** zet je FQDN op de **`app`**-service en schakel **HTTPS (Let's Encrypt)** in.
   Verplicht, want `lib/auth.js` zet de sessie-cookie op `Secure` zodra `NODE_ENV=production`.
4. **Deploy.** Eerste login met `ADMIN_EMAIL` / `ADMIN_PASSWORD` maakt het admin-account aan.
5. Als je van Upstash overstapt: **migreer eerst de data** (zie hieronder).

> **Replica's:** houd de `app` op 1 replica, anders draait de sync-taak dubbel.

> **Reverse proxy:** `parse-pdf` accepteert uploads tot 25 MB. Traefik staat dat toe;
> zet je er nginx voor, verhoog dan `client_max_body_size`.

## Database

De app praat met Redis via **`@upstash/redis`**, dat over **HTTP/REST** gaat en niet over
het Redis-protocol. Daarom draait er in de compose een **REST-proxy (SRH)** vóór Redis:
daarmee blijft de app-code ongewijzigd. `UPSTASH_REDIS_REST_URL` wijst dan naar
`http://redis-rest:80` en het token is `REDIS_TOKEN`.

**Let op — persistentie & backups:** Redis is alleen duurzaam dankzij het named volume
`redis-data` i.c.m. `--appendonly yes`. Verlies je dat volume, dan ben je projecten,
gebruikers en opgeslagen PDF's kwijt. Regel een back-up van dat volume (of exporteer de
keys periodiek) voordat je echt op self-hosted overstapt.

### Migreren van Upstash naar self-hosted Redis

Doe dit **vóór** je de app op de interne proxy laat wijzen, anders start hij leeg.
`scripts/migrate-redis.mjs` kopieert alle keys (inclusief TTL's) van Upstash naar de
nieuwe Redis:

```sh
SRC_URL="https://xxx.upstash.io" SRC_TOKEN="..." \
DST_URL="http://localhost:8079"  DST_TOKEN="..." \
node scripts/migrate-redis.mjs
```

Op de Coolify-stack:
```sh
docker compose run --rm \
  -e SRC_URL="https://xxx.upstash.io" -e SRC_TOKEN="..." \
  -e DST_URL="http://redis-rest:80"   -e DST_TOKEN="$REDIS_TOKEN" \
  app node scripts/migrate-redis.mjs
```

Het script is idempotent; opnieuw draaien overschrijft dezelfde waarden.

## Cron / dagelijkse sync

De sync loopt via het endpoint `/api/cron/sync`, beveiligd met `CRON_SECRET` als
`Authorization: Bearer <secret>`. De **`cron`-sidecar** (`scripts/cron-runner.mjs`) roept
dit dagelijks aan op `CRON_HOUR` (UTC, default 07:00) en logt het resultaat. Zo is de
planning self-contained en niet afhankelijk van Coolify's Scheduled Tasks-feature.

- `CRON_TARGET` — endpoint-URL (default `http://app:3000/api/cron/sync`)
- `CRON_HOUR` — uur in UTC, 0-23 (default `7`)

Eenmalig testen:
```sh
docker compose run --rm -e RUN_ONCE=1 cron
```

> Gebruik je liever de Coolify Scheduled Task (of een externe planner)? Verwijder dan de
> `cron`-service uit de compose en plan `http://<app>:3000/api/cron/sync` op `0 7 * * *`.

## Bestandsstructuur

```
project-manager/
├── server.js                          # Express-host: static + api-routing
├── Dockerfile
├── docker-compose.yaml                # app + redis + redis-rest + cron
├── scripts/
│   ├── migrate-redis.mjs              # eenmalige Upstash → self-hosted migratie
│   └── cron-runner.mjs                # dagelijkse sync-taak (cron-sidecar)
├── api/
│   ├── auth/[action].js               # login/logout/me
│   ├── admin/
│   │   ├── settings.js
│   │   ├── users.js
│   │   └── users/[id].js              # toggle/reset/rename/change_role
│   ├── cron/sync.js
│   ├── moneybird/[resource].js        # projects/employees/time_entries
│   └── projects/
│       ├── index.js                   # GET list, POST create
│       ├── parse-pdf.js               # PDF → Claude parsing
│       ├── sync-all.js                # sync alle projecten
│       └── [id]/
│           ├── index.js               # GET detail, PATCH update, DELETE
│           ├── sync.js                # POST sync
│           └── hours.js               # over-time / per-user
├── lib/
│   ├── activity.js                    # activiteitenlog per project
│   ├── auth.js                        # sessies + role guards
│   ├── claude.js                      # Claude API + PDF parsing
│   ├── db.js                          # Redis KV wrapper
│   ├── moneybird.js                   # Moneybird REST
│   ├── notify.js                      # drempels + inactiviteit + Resend mails
│   └── sync.js                        # high-level sync
├── public/                            # statische HTML/CSS/JS frontend
├── package.json
├── .env.example
├── .gitignore
└── .dockerignore
```

## Data in Redis

| Key                                | Inhoud                                                  |
|------------------------------------|---------------------------------------------------------|
| `users`                            | array van user objects (admin + PM)                     |
| `projects`                         | array van project objects                               |
| `time_entries:<projectId>`         | array van time entries voor dat project                 |
| `settings`                         | drempels + inactivity_days + extra mail-ontvangers      |
| `alerts_sent`                      | dedupe drempel-mails per (project, level)               |
| `inactivity_alerts_sent`           | dedupe inactiviteit-mails per (project, user, datum)    |
| `session:<token>`                  | actieve sessie, TTL 7 dagen                             |
