# Projectmanager — Vercel + Upstash Redis

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

Bouwstenen: Node.js serverless functions op **Vercel**, **Upstash Redis** voor opslag,
statische HTML/CSS/JS frontend, Chart.js voor grafieken, Vercel Cron voor periodieke sync.

## Deployen op Vercel

1. **Maak een Upstash Redis database aan** op https://console.upstash.com (gratis tier is voldoende).
   Kopieer uit **REST API** de waardes `UPSTASH_REDIS_REST_URL` en `UPSTASH_REDIS_REST_TOKEN`.
2. **Push deze map naar GitHub.**
3. Ga naar https://vercel.com → **Add New → Project** → koppel je repo. Framework preset: "Other".
4. **Settings → Environment Variables** — voeg toe:
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`
   - `MONEYBIRD_API_TOKEN`, `MONEYBIRD_ADMINISTRATION_ID`
   - `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (bv. `claude-sonnet-4-5`)
   - `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
   - `CRON_SECRET` (willekeurige string)
5. **Deploy.** Eerste login met `ADMIN_EMAIL` / `ADMIN_PASSWORD` maakt het admin-account aan.

## Bestandsstructuur

```
project-manager-vercel/
├── api/
│   ├── auth/[action].js              # login/logout/me
│   ├── admin/
│   │   ├── settings.js
│   │   ├── users.js
│   │   └── users/[id].js             # toggle/reset/rename
│   ├── cron/sync.js
│   ├── moneybird/[resource].js       # projects/employees
│   └── projects/
│       ├── index.js                  # GET list, POST create
│       ├── parse-pdf.js              # PDF → Claude parsing
│       └── [id]/
│           ├── index.js              # GET detail, PATCH update
│           ├── sync.js               # POST sync
│           ├── hours-over-time.js
│           └── hours-per-user.js
├── lib/
│   ├── auth.js                       # sessies + role guards
│   ├── claude.js                     # Claude API + PDF parsing
│   ├── db.js                         # Upstash KV wrapper
│   ├── moneybird.js                  # Moneybird REST
│   ├── notify.js                     # drempels + inactiviteit + Resend mails
│   └── sync.js                       # high-level sync
├── public/
│   ├── index.html                    # redirect naar login of dashboard
│   ├── login.html
│   ├── dashboard.html                # cards + medewerker prestaties
│   ├── projects.html                 # lijst + status filter
│   ├── project.html                  # detail + full edit form
│   ├── new-project.html              # PDF upload + alle velden
│   ├── planning.html                 # per medewerker hun projecten
│   ├── admin-settings.html           # drempels + users management
│   ├── app.js                        # gedeelde frontend logic
│   └── style.css                     # huisstijl
├── package.json
├── vercel.json
├── .env.example
└── .gitignore
```

## Data in Upstash Redis

| Key                                | Inhoud                                                  |
|------------------------------------|---------------------------------------------------------|
| `users`                            | array van user objects (admin + PM)                     |
| `projects`                         | array van project objects                               |
| `time_entries:<projectId>`         | array van time entries voor dat project                 |
| `settings`                         | drempels + inactivity_days + extra mail-ontvangers      |
| `alerts_sent`                      | dedupe drempel-mails per (project, level)               |
| `inactivity_alerts_sent`           | dedupe inactiviteit-mails per (project, user, datum)    |
| `session:<token>`                  | actieve sessie, TTL 7 dagen                             |

## Functions count

Vercel Hobby staat max **12 serverless functions** toe. Dit project zit op precies 12.
Bij verdere uitbreiding moet je consolideren (bv. de twee `hours-*` endpoints samenvoegen).
