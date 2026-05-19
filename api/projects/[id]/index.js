// GET   /api/projects/:id                       - detail incl. stats, notes, activity_log
// GET   /api/projects/:id?action=download_pdf   - serveert de opgeslagen PDF
// PATCH /api/projects/:id                       - update editable fields (auto-logt wijzigingen)
// PATCH /api/projects/:id  body { add_note:{ text } }     - voeg notitie toe
// PATCH /api/projects/:id  body { delete_note:{ id } }    - verwijder notitie (admin of auteur)
// PATCH /api/projects/:id  body { delete_pdf: true }      - verwijder opgeslagen PDF
import crypto from 'node:crypto';
import { requireUser } from '../../../lib/auth.js';
import {
  getProject,
  saveProject,
  getUserById,
  listTimeEntries,
  getPdfBlob,
  deletePdfBlob,
} from '../../../lib/db.js';
import { diffProjectActivity, appendActivity, logActivity } from '../../../lib/activity.js';

const VALID_STATUSES = ['in_progress', 'on_hold', 'done', 'future'];
const VALID_MODULES = ['PowerImprove', 'PowerClass', 'PowerText', 'PowerImage', 'PowerRelate', 'Project'];
const EDITABLE_FIELDS = [
  'name', 'description', 'available_hours', 'hourly_rate',
  'exceptions', 'manager_id', 'client_id', 'deadline',
];

function isIsoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function normalizeTeam(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const m of input) {
    if (!m) continue;
    const id = String(m.moneybird_user_id || m.id || '').trim();
    const name = String(m.name || '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ moneybird_user_id: id, name });
  }
  return out;
}

function normalizeContacts(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const c of input) {
    if (!c) continue;
    const name = String(c.name || '').trim();
    const email = String(c.email || '').trim();
    if (!name && !email) continue;
    out.push({ name, email });
  }
  return out;
}

async function buildDetail(project) {
  const entries = await listTimeEntries(project.id);
  const hoursUsed = entries.reduce((a, e) => a + (Number(e.hours) || 0), 0);
  const avail = Number(project.available_hours) || 0;
  const pct = avail > 0 ? Math.round((hoursUsed / avail) * 1000) / 10 : 0;
  const manager = project.manager_id ? await getUserById(project.manager_id) : null;
  const team = Array.isArray(project.team) ? project.team : [];
  const team_stats = team.map((m) => {
    const memberHours = entries
      .filter((e) => e.user_moneybird_id === m.moneybird_user_id)
      .reduce((a, e) => a + (Number(e.hours) || 0), 0);
    return { ...m, hours: Math.round(memberHours * 100) / 100 };
  });
  return {
    ...project,
    status: project.status || 'in_progress',
    module: project.module || '',
    deadline: project.deadline || '',
    client_id: project.client_id || '',
    contacts: Array.isArray(project.contacts) ? project.contacts : [],
    notes: Array.isArray(project.notes) ? project.notes : [],
    activity_log: Array.isArray(project.activity_log) ? project.activity_log : [],
    team,
    team_stats,
    hours_used: hoursUsed,
    percentage_used: pct,
    within_budget: avail > 0 ? hoursUsed <= avail : null,
    has_pdf: !!project.pdf_stored,
    manager_name: manager?.name || null,
    manager_email: manager?.email || null,
  };
}

async function streamPdf(res, projectId) {
  const blob = await getPdfBlob(projectId);
  if (!blob) {
    res.status(404).json({ error: 'Geen PDF opgeslagen voor dit project' });
    return;
  }
  const buf = Buffer.from(blob.base64, 'base64');
  res.setHeader('Content-Type', blob.mime || 'application/pdf');
  const safeName = (blob.filename || 'offerte.pdf').replace(/[^\w.\- ]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.status(200).send(buf);
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const project = await getProject(req.query.id);
  if (!project) {
    res.status(404).json({ error: 'Niet gevonden' });
    return;
  }
  if (user.role !== 'admin' && project.manager_id !== user.id) {
    res.status(403).json({ error: 'Geen toegang' });
    return;
  }

  if (req.method === 'GET') {
    if (req.query.action === 'download_pdf') {
      await streamPdf(res, project.id);
      return;
    }
    res.status(200).json({ project: await buildDetail(project) });
    return;
  }

  if (req.method === 'PATCH') {
    const b = req.body || {};

    // ── Notitie toevoegen ────────────────────────────────────────
    if (b.add_note) {
      const text = String(b.add_note.text || '').trim();
      if (!text) {
        res.status(400).json({ error: 'Notitie mag niet leeg zijn' });
        return;
      }
      if (!Array.isArray(project.notes)) project.notes = [];
      const note = {
        id: 'n_' + crypto.randomBytes(6).toString('hex'),
        text,
        author_id: user.id,
        author_name: user.name,
        created_at: new Date().toISOString(),
      };
      project.notes.push(note);
      logActivity(project, user, 'note_added', { note_id: note.id });
      await saveProject(project);
      res.status(200).json({ project: await buildDetail(project) });
      return;
    }

    // ── Notitie verwijderen ──────────────────────────────────────
    if (b.delete_note) {
      const id = String(b.delete_note.id || '');
      const notes = Array.isArray(project.notes) ? project.notes : [];
      const note = notes.find((n) => n.id === id);
      if (!note) {
        res.status(404).json({ error: 'Notitie niet gevonden' });
        return;
      }
      if (user.role !== 'admin' && note.author_id !== user.id) {
        res.status(403).json({ error: 'Alleen de auteur of een admin kan deze notitie verwijderen' });
        return;
      }
      project.notes = notes.filter((n) => n.id !== id);
      logActivity(project, user, 'note_deleted', { note_id: id });
      await saveProject(project);
      res.status(200).json({ project: await buildDetail(project) });
      return;
    }

    // ── PDF verwijderen ──────────────────────────────────────────
    if (b.delete_pdf) {
      await deletePdfBlob(project.id);
      project.pdf_stored = false;
      logActivity(project, user, 'pdf_deleted', {});
      await saveProject(project);
      res.status(200).json({ project: await buildDetail(project) });
      return;
    }

    // ── Reguliere update (met auto-activity-log) ─────────────────
    const before = JSON.parse(JSON.stringify(project));
    for (const f of EDITABLE_FIELDS) {
      if (b[f] !== undefined) project[f] = b[f];
    }
    if (b.status !== undefined) {
      const s = String(b.status).toLowerCase();
      project.status = VALID_STATUSES.includes(s) ? s : project.status || 'in_progress';
    }
    if (b.module !== undefined) {
      const m = String(b.module || '').trim();
      project.module = VALID_MODULES.includes(m) ? m : '';
    }
    if (b.deadline !== undefined) {
      project.deadline = isIsoDate(b.deadline) ? String(b.deadline) : '';
    }
    if (b.contacts !== undefined) project.contacts = normalizeContacts(b.contacts);
    if (b.team !== undefined) project.team = normalizeTeam(b.team);
    if (typeof project.available_hours === 'string') project.available_hours = Number(project.available_hours) || 0;
    if (typeof project.hourly_rate === 'string') project.hourly_rate = Number(project.hourly_rate) || 0;

    const activity = diffProjectActivity(before, project, user);
    appendActivity(project, activity);

    await saveProject(project);
    res.status(200).json({ project: await buildDetail(project) });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
