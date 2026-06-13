// GET    /api/projects/:id
// GET    /api/projects/:id?action=download_pdf
// PATCH  /api/projects/:id                       - update (auto-logt wijzigingen)
// PATCH  /api/projects/:id  body { add_note }
// PATCH  /api/projects/:id  body { delete_note }
// PATCH  /api/projects/:id  body { delete_pdf }
// DELETE /api/projects/:id                       - admin only
import crypto from 'node:crypto';
import { requireUser } from '../../../lib/auth.js';
import {
  getProject,
  saveProject,
  deleteProject,
  getUserById,
  listTimeEntries,
  getPdfBlob,
  deletePdfBlob,
} from '../../../lib/db.js';
import { diffProjectActivity, appendActivity, logActivity } from '../../../lib/activity.js';

const VALID_STATUSES = ['in_progress', 'on_hold', 'done', 'future', 'recurring'];
const VALID_MODULES = ['PowerImprove', 'PowerClass', 'PowerText', 'PowerImage', 'PowerRelate', 'Project'];
const VALID_SENTIMENTS = ['green', 'orange', 'red', ''];
const EDITABLE_FIELDS = [
  'name', 'description', 'available_hours', 'hourly_rate',
  'exceptions', 'manager_id', 'client_id', 'feature_requests',
];

function isIsoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

// Meerdere deadlines per project: [{ date, description }]. Met legacy-fallback naar
// het oude enkele `deadline`-veld. Gesorteerd op datum (oplopend).
function normalizeDeadlines(input, legacyDeadline) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (legacyDeadline && isIsoDate(legacyDeadline)) arr = [{ date: legacyDeadline, description: '' }];
  const out = [];
  const seen = new Set();
  for (const d of arr) {
    if (!d) continue;
    const date = String(d.date || '').trim();
    if (!isIsoDate(date)) continue;
    const description = String(d.description || '').trim();
    const key = `${date}|${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, description });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function earliestDeadline(deadlines) {
  if (!Array.isArray(deadlines) || deadlines.length === 0) return '';
  return deadlines.reduce((acc, d) => (acc === '' || d.date < acc ? d.date : acc), '');
}

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

function normalizeWeeklyAllocations(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const a of input) {
    if (!a) continue;
    const userId = String(a.moneybird_user_id || '').trim();
    const week = String(a.week_start || '').trim();
    const hours = Number(a.hours);
    if (!userId) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) continue;
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const key = `${userId}|${week}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ moneybird_user_id: userId, week_start: week, hours: Math.round(hours * 100) / 100 });
  }
  return out;
}

function normalizeTeamAllocations(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const a of input) {
    if (!a) continue;
    const id = String(a.moneybird_user_id || '').trim();
    const h = Number(a.allocated_hours);
    if (!id || seen.has(id)) continue;
    if (!Number.isFinite(h) || h < 0) continue;
    seen.add(id);
    out.push({ moneybird_user_id: id, allocated_hours: Math.round(h * 100) / 100 });
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
    const lang = String(c.language || 'nl').toLowerCase() === 'en' ? 'en' : 'nl';
    out.push({ name, email, receives_threshold_mails: !!c.receives_threshold_mails, language: lang });
  }
  return out;
}

function normalizeModules(input) {
  let raw = [];
  if (Array.isArray(input)) raw = input;
  else if (typeof input === 'string' && input.trim()) raw = [input];
  const seen = new Set();
  const out = [];
  for (const m of raw) {
    const v = String(m || '').trim();
    if (!VALID_MODULES.includes(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function modulesOf(p) {
  if (Array.isArray(p.modules) && p.modules.length > 0) return p.modules;
  if (p.module) return [p.module];
  return [];
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
  const mods = modulesOf(project);
  return {
    ...project,
    status: project.status || 'in_progress',
    modules: mods,
    module: mods[0] || '',
    deadlines: normalizeDeadlines(project.deadlines, project.deadline),
    deadline: earliestDeadline(normalizeDeadlines(project.deadlines, project.deadline)),
    start_date: project.start_date || '',
    is_poc: !!project.is_poc,
    is_hourly_billing: !!project.is_hourly_billing,
    feature_requests: project.feature_requests || '',
    sentiment: project.sentiment || '',
    sentiment_by: project.sentiment_by || null,
    sentiment_by_id: project.sentiment_by_id || null,
    sentiment_at: project.sentiment_at || null,
    client_id: project.client_id || '',
    contacts: Array.isArray(project.contacts) ? project.contacts : [],
    team_allocations: Array.isArray(project.team_allocations) ? project.team_allocations : [],
    weekly_allocations: Array.isArray(project.weekly_allocations) ? project.weekly_allocations : [],
    notes: Array.isArray(project.notes) ? project.notes : [],
    activity_log: Array.isArray(project.activity_log) ? project.activity_log : [],
    last_synced_at: project.last_synced_at || null,
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
    if (req.query.action === 'download_pdf') { await streamPdf(res, project.id); return; }
    res.status(200).json({ project: await buildDetail(project) });
    return;
  }

  if (req.method === 'DELETE') {
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Alleen een admin kan projecten verwijderen' });
      return;
    }
    const ok = await deleteProject(project.id);
    if (!ok) { res.status(404).json({ error: 'Niet gevonden' }); return; }
    res.status(200).json({ ok: true, deleted_id: project.id });
    return;
  }

  if (req.method === 'PATCH') {
    const b = req.body || {};

    if (b.add_note) {
      const text = String(b.add_note.text || '').trim();
      if (!text) { res.status(400).json({ error: 'Notitie mag niet leeg zijn' }); return; }
      if (!Array.isArray(project.notes)) project.notes = [];
      const note = {
        id: 'n_' + crypto.randomBytes(6).toString('hex'),
        text, author_id: user.id, author_name: user.name,
        created_at: new Date().toISOString(),
      };
      project.notes.push(note);
      logActivity(project, user, 'note_added', { note_id: note.id });
      await saveProject(project);
      res.status(200).json({ project: await buildDetail(project) });
      return;
    }

    if (b.delete_note) {
      const id = String(b.delete_note.id || '');
      const notes = Array.isArray(project.notes) ? project.notes : [];
      const note = notes.find((n) => n.id === id);
      if (!note) { res.status(404).json({ error: 'Notitie niet gevonden' }); return; }
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

    if (b.delete_pdf) {
      await deletePdfBlob(project.id);
      project.pdf_stored = false;
      logActivity(project, user, 'pdf_deleted', {});
      await saveProject(project);
      res.status(200).json({ project: await buildDetail(project) });
      return;
    }

    const before = JSON.parse(JSON.stringify(project));
    for (const f of EDITABLE_FIELDS) {
      if (b[f] !== undefined) project[f] = b[f];
    }
    if (b.status !== undefined) {
      const s = String(b.status).toLowerCase();
      project.status = VALID_STATUSES.includes(s) ? s : project.status || 'in_progress';
    }
    if (b.modules !== undefined || b.module !== undefined) {
      const mods = normalizeModules(b.modules !== undefined ? b.modules : b.module);
      if (mods.length === 0) {
        res.status(400).json({ error: 'Selecteer minstens 1 module' });
        return;
      }
      project.modules = mods;
      delete project.module; // legacy weghalen
    }
    if (b.deadlines !== undefined || b.deadline !== undefined) {
      const list = normalizeDeadlines(b.deadlines, b.deadline);
      project.deadlines = list;
      project.deadline = earliestDeadline(list); // legacy-veld bijhouden voor backward compat
    }
    if (b.start_date !== undefined) project.start_date = isIsoDate(b.start_date) ? String(b.start_date) : '';
    if (b.is_poc !== undefined) project.is_poc = !!b.is_poc;
    if (b.is_hourly_billing !== undefined) project.is_hourly_billing = !!b.is_hourly_billing;
    if (b.contacts !== undefined) project.contacts = normalizeContacts(b.contacts);
    if (b.team !== undefined) project.team = normalizeTeam(b.team);
    if (b.team_allocations !== undefined) project.team_allocations = normalizeTeamAllocations(b.team_allocations);
    if (b.weekly_allocations !== undefined) project.weekly_allocations = normalizeWeeklyAllocations(b.weekly_allocations);
    if (b.sentiment !== undefined) {
      const next = String(b.sentiment || '').toLowerCase();
      const val = VALID_SENTIMENTS.includes(next) ? next : '';
      const prev = project.sentiment || '';
      if (val !== prev) {
        project.sentiment = val;
        project.sentiment_by_id = user.id;
        project.sentiment_by = user.name;
        project.sentiment_at = new Date().toISOString();
        logActivity(project, user, 'sentiment_changed', { from: prev, to: val });
      }
    }
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
