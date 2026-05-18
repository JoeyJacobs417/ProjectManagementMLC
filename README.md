# Projectmanager — Vercel + Upstash Redis

Project management webapp:
- Geschreven uren uit **Moneybird** automatisch synchroniseren per project.
- Per project urenverbruik bekijken met grafieken (uren in de tijd, per medewerker).
- Nieuw project aanmaken via **PDF-upload** — Claude leest beschikbare uren, fases, beschrijving,
  uurtarief en uitzonderingen automatisch uit het document.
- Inloggen als **Admin** of **Projectmanager** (PM ziet alleen eigen projecten).
- Automatische waarschuwings-mails via **Resend** bij overschrijden van configureerbare drempels.

Bouwstenen: Node.js serverless functions op **Vercel**, **Upstash Redis** voor opslag,
statische HTML/CSS/JS frontend, Chart.js voor grafieken, Vercel Cron voor periodieke sync.

## Bestandsstructuur

```
project-manager-vercel/
├── api/
│   ├── auth/{login,logout,me}.js
│   ├── projects/
│   │   ├── index.js                   # GET list, POST create
│   │   ├── parse-pdf.js               # POST PDF -> Claude parsing
│   │   └── [id]/
│   │       ├── index.js               # GET detail
│   │       ├── sync.js                # POST sync Moneybird
│   │       ├── hours-over-time.js
│   │       └── hours-per-user.js
│   ├── admin/
│   │   ├── users.js                   # GET list, POST nieuw
│   │   ├── users/[id].js              # PATCH toggle/reset wachtwoord
│   │   └── settings.js
│   └── cron/sync.js                   # door Vercel Cron aangeroepen
├── lib/
│   ├── db.js                          # Upstash Redis wrapper
│   ├── auth.js                        # sessies, password hashing
│   ├── moneybird.js                   # Moneybird REST API
│   ├── claude.js                      # PDF parsing via Claude
│   ├── notify.js                      # drempel-check + Resend
│   └── sync.js                        # high-level sync
├── public/
│   ├── index.html                     # redirect
│   ├── login.html
│   ├── dashboard.html
│   ├── projects.html
│   ├── project.html
│   ├── new-project.html
│   ├── admin-users.html
│   ├── admin-settings.html
│   ├── app.js                         # gedeelde frontend logic
│   └── style.css                      # huisstijl
├── package.json
├── vercel.json                        # cron + function settings
├── .env.example
└── .gitignore
```

## Deployen op Vercel (vanuit GitHub)

1. **Maak een Upstash Redis database aan** op https://console.upstash.com (gratis tier is voldoende). Of hergebruik je bestaande Upstash-database. Kopieer uit **REST API** de waardes `UPSTASH_REDIS_REST_URL` en `UPSTASH_REDIS_REST_TOKEN`.
2. **Push deze map naar GitHub.**
3. Ga naar https://vercel.com → **Add New → Project** → koppel je repo. Framework preset: "Other". Build command leeg laten.
4. Onder **Settings → Environment Variables**, voeg toe:
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (uit stap 1)
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` — voor initiële admin
   - `MONEYBIRD_API_TOKEN`, `MONEYBIRD_ADMINISTRATION_ID`
   - `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (bv. `claude-sonnet-4-5`)
   - `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
   - `CRON_SECRET` — willekeurige string (`openssl rand -hex 32`); Vercel zet deze als Bearer-token bij cron-aanroepen
5. **Deploy.** De eerste keer dat je `/login.html` opent en met de admin-mail/wachtwoord uit env inlogt, wordt het admin-account aangemaakt in Upstash.
6. **Cron** draait automatisch elke 6 uur (`vercel.json`) — synct alle gekoppelde projecten en checkt drempels.

> **Tip:** je kunt je bestaande Upstash-database uit het KTO-project hergebruiken — onze keys (`users`, `projects`, `time_entries:*`, `settings`, `alerts_sent`, `session:*`) botsen niet als KTO andere keynamen gebruikt. Veiliger is wel om een aparte database aan te maken in Upstash (gratis).

## Lokaal draaien

```bash
npm install
npm install -g vercel        # eerste keer
vercel link                  # koppel aan je Vercel-project
vercel env pull .env.local   # haalt env vars op uit Vercel
vercel dev
```

Of zonder Vercel CLI: kopieer `.env.example` naar `.env`, vul alle vars in (inclusief `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` uit je Upstash dashboard) en draai `vercel dev`.

Open `http://localhost:3000`.

## Hoe het werkt

### Nieuw project aanmaken
1. Klik op **Nieuw project**.
2. Upload de offerte/voorstel-PDF — Claude haalt automatisch uren, fases, beschrijving,
   uurtarief en uitzonderingen eruit en vult het formulier voor.
3. Vul eventueel Moneybird-Project-ID en projectmanager in.
4. Opslaan.

### Moneybird sync
- Op de project-detail pagina zit een **Synchroniseer Moneybird** knop.
- De Vercel Cron draait elke 6 uur en doet hetzelfde voor alle gekoppelde projecten.

### Drempels & mails
- Admin → **Instellingen**: drempels (% waarschuwing / kritiek / overschreden) + extra mailontvangers.
- Bij het bereiken van een drempel: mail naar PM + alle admins + extra ontvangers.
- Per drempelniveau wordt maximaal één mail per project verstuurd (geen spam).

## Data in Upstash Redis

Alles staat als JSON-waardes per key:

| Key | Inhoud |
|---|---|
| `users` | array van users `{id, email, name, role, active, password_hash}` |
| `projects` | array van projects |
| `time_entries:<projectId>` | array van time entries per project |
| `settings` | object met drempels + extra mailontvangers |
| `alerts_sent` | array — welke drempelmails al verstuurd zijn |
| `session:<token>` | actieve sessie, TTL 7 dagen |
