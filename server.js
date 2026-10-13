// server.js — Node/Express-host voor de Vercel-style handlers in api/**.
//
// Vervangt de Vercel runtime:
//   • statische bestanden uit public/
//   • Vercel's file-based routing van api/** (incl. [action]/[id]/[resource] params)
//   • het serverless req/res-contract — Express levert al .status()/.json()/.send()/
//     .setHeader(), dus de handlers zelf blijven ongewijzigd.
//
// Draaien: npm start  (of: node server.js). Poort via PORT, default 3000.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Handlers (Vercel file-based routing → expliciete routes hieronder) ──────
import authAction from './api/auth/[action].js';
import adminSettings from './api/admin/settings.js';
import adminUsers from './api/admin/users.js';
import adminUserById from './api/admin/users/[id].js';
import cronSync from './api/cron/sync.js';
import moneybirdResource from './api/moneybird/[resource].js';
import projectsIndex from './api/projects/index.js';
import projectsParsePdf from './api/projects/parse-pdf.js';
import projectsSyncAll from './api/projects/sync-all.js';
import projectById from './api/projects/[id]/index.js';
import projectHours from './api/projects/[id]/hours.js';
import projectSync from './api/projects/[id]/sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Coolify/Traefik staat vóór de app; zonder dit kloppen protocol/host-headers niet.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// JSON-bodies voor de API. multipart/form-data (parse-pdf) wordt NIET geconsumeerd,
// dus de busboy-stream in api/projects/parse-pdf.js blijft intact.
app.use(express.json({ limit: '10mb' }));

// Vercel stopte dynamische route-params in req.query; de handlers lezen daaruit
// (bv. req.query.id / req.query.action / req.query.resource). Express zet ze in
// req.params — samenvoegen herstelt Vercel's contract.
function mergeParams(req, _res, next) {
  Object.assign(req.query, req.params);
  next();
}

// Async-handlers: afgewezen promises naar de error-middleware i.p.v. een crash.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── API-routes (statische segmenten vóór dynamische [id]) ───────────────────
app.get('/api/health', (_req, res) => res.status(200).json({ ok: true }));
app.all('/api/auth/:action', mergeParams, wrap(authAction));
app.all('/api/admin/settings', wrap(adminSettings));
app.all('/api/admin/users', wrap(adminUsers));
app.all('/api/admin/users/:id', mergeParams, wrap(adminUserById));
app.all('/api/cron/sync', wrap(cronSync));
app.all('/api/moneybird/:resource', mergeParams, wrap(moneybirdResource));
app.all('/api/projects', wrap(projectsIndex));
app.all('/api/projects/parse-pdf', wrap(projectsParsePdf));
app.all('/api/projects/sync-all', wrap(projectsSyncAll));
app.all('/api/projects/:id', mergeParams, wrap(projectById));
app.all('/api/projects/:id/hours', mergeParams, wrap(projectHours));
app.all('/api/projects/:id/sync', mergeParams, wrap(projectSync));

// Onbekende API-routes: JSON-404 i.p.v. de HTML-fallback.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Statische frontend (public/), index.html op "/" ─────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Healthcheck voor Coolify (buiten /api, om de 404-catch niet te raken) ───
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

// ── Laatste vangnet ─────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: err?.message || 'Internal error' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Projectmanager luistert op http://0.0.0.0:${port}`);
});
