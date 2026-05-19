// GET /api/projects                    -> lijst projecten
// GET /api/projects?format=xlsx        -> Excel-export
// POST /api/projects                   -> nieuw project (verplicht: moneybird_project_id)
import { Redis } from '@upstash/redis';
import * as XLSX from 'xlsx';
import { requireUser } from '../../lib/auth.js';
import { newId } from '../../lib/auth.js';
import {
  listProjects,
  saveProject,
  listUsers,
  listTimeEntries,
  savePdfBlob,
  getSettings,
} from '../../lib/db.js';
import { logActivity } from '../../lib/activity.js';

const kv = Redis.fromEnv();
const VALID_STATUSES = ['in_progress', 'on_hold', 'done', 'future'];
const VALID_MODULES = ['PowerImprove', 'PowerClass', 'PowerText', 'PowerImage', 'PowerRelate', 'Project'];

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

function normalizeStatus(s) { return VALID_STATUSES.includes(String(s || '').toLowerCase()) ? String(s).toLowerCase() : 'in_progress'; }
function normalizeModule(m) { return VALID_MODULES.includes(String(m || '').trim()) ? String(m).trim() : ''; }
function normalizeDate(d) { return isIsoDate(d) ? String(d) : ''; }

async function withStats(project) {
  const entries = await listTimeEntries(project.id);
  const hoursUsed = entries.reduce((a, e) => a + (Number(e.hours) || 0), 0);
  const avail = Number(project.available_hours) || 0;
  const pct = avail > 0 ? Math.round((hoursUsed / avail) * 1000) / 10 : 0;
  const team = Array.isArray(project.team) ? project.team : [];
  const teamStats = team.map((m) => {
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
    start_date: project.start_date || '',
    is_poc: !!project.is_poc,
    feature_requests: project.feature_requests || '',
    client_id: project.client_id || '',
    contacts: Array.isArray(project.contacts) ? project.contacts : [],
    notes: Array.isArray(project.notes) ? project.notes : [],
    activity_log: Array.isArray(project.activity_log) ? project.activity_log : [],
    team,
    team_stats: teamStats,
    hours_used: hoursUsed,
    percentage_used: pct,
    within_budget: avail > 0 ? hoursUsed <= avail : null,
    has_pdf: !!project.pdf_stored,
    time_entries: entries, // alleen gebruikt door planning-pagina voor weekly view
  };
}

function statusLabel(v) {
  return ({ in_progress: 'In progress', on_hold: 'On hold', done: 'Done', future: 'Future' })[v] || v;
}

function buildExcel(enrichedProjects, clientsById) {
  const rows = enrichedProjects.map((p) => ({
    'Project': p.name || '',
    'Status': statusLabel(p.status),
    'POC': p.is_poc ? 'Ja' : '',
    'Module': p.module || '',
    'Klant': clientsById[p.client_id]?.name || '',
    'Projectmanager': p.manager_name || '',
    'Startdatum': p.start_date || '',
    'Deadline': p.deadline || '',
    'Beschikbaar (uur)': Number(p.available_hours) || 0,
    'Verbruikt (uur)': Number(p.hours_used) || 0,
    'Resterend (uur)': Math.max(0, (Number(p.available_hours) || 0) - (Number(p.hours_used) || 0)),
    'Verbruikt (%)': Number(p.percentage_used) || 0,
    'Uurtarief (€)': Number(p.hourly_rate) || 0,
    'Begrote omzet (€)': Math.round(((Number(p.available_hours) || 0) * (Number(p.hourly_rate) || 0)) * 100) / 100,
    'Team': (p.team || []).map((t) => t.name).join(', '),
    'Contacten': (p.contacts || []).map((c) => `${c.name}${c.email ? ' <' + c.email + '>' : ''}`).join('; '),
    'Feature requests': p.feature_requests || '',
    'Moneybird ID': p.moneybird_project_id || '',
    'Aangemaakt': p.created_at || '',
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const cols = Object.keys(rows[0] || {}).map((key) => {
    const maxLen = Math.max(key.length, ...rows.map((r) => String(r[key] ?? '').length));
    return { wch: Math.min(maxLen + 2, 60) };
  });
  ws['!cols'] = cols;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Projecten');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    let projects = await listProjects();
    if (user.role !== 'admin') {
      projects = projects.filter((p) => p.manager_id === user.id);
    }
    const users = await listUsers();
    const wantsTimeEntries = req.query.with_time_entries === '1';
    const enriched = await Promise.all(
      projects.map(async (p) => {
        const stats = await withStats(p);
        const mgr = users.find((u) => u.id === p.manager_id);
        const result = { ...stats, manager_name: mgr?.name || null };
        if (!wantsTimeEntries) delete result.time_entries;
        return result;
      })
    );
    enriched.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (req.query.format === 'xlsx') {
      const settings = await getSettings();
      const clientsById = Object.fromEntries((settings.clients || []).map((c) => [c.id, c]));
      const buf = buildExcel(enriched, clientsById);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="projecten-${new Date().toISOString().slice(0,10)}.xlsx"`);
      res.status(200).send(buf);
      return;
    }

    res.status(200).json({ projects: enriched });
    return;
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    if (!b.name) {
      res.status(400).json({ error: 'Projectnaam is verplicht' });
      return;
    }
    if (!b.moneybird_project_id || !String(b.moneybird_project_id).trim()) {
      res.status(400).json({ error: 'Moneybird project is verplicht' });
      return;
    }
    const projectId = newId('p_');
    let pdfStored = false;
    let pdfFilename = b.source_pdf_filename || null;
    if (b.pdf_pending_token) {
      const pending = await kv.get(`pdf:_pending:${String(b.pdf_pending_token)}`);
      if (pending) {
        await savePdfBlob(projectId, pending.base64, pending.filename, pending.mime);
        await kv.del(`pdf:_pending:${String(b.pdf_pending_token)}`);
        pdfStored = true;
        pdfFilename = pending.filename || pdfFilename;
      }
    }

    const project = {
      id: projectId,
      name: String(b.name),
      description: String(b.description || ''),
      available_hours: Number(b.available_hours) || 0,
      hourly_rate: Number(b.hourly_rate) || 0,
      exceptions: String(b.exceptions || ''),
      moneybird_project_id: String(b.moneybird_project_id).trim(),
      source_pdf_filename: pdfFilename,
      pdf_stored: pdfStored,
      manager_id: b.manager_id || null,
      client_id: String(b.client_id || '').trim(),
      team: normalizeTeam(b.team),
      contacts: normalizeContacts(b.contacts),
      status: normalizeStatus(b.status),
      module: normalizeModule(b.module),
      deadline: normalizeDate(b.deadline),
      start_date: normalizeDate(b.start_date),
      is_poc: !!b.is_poc,
      feature_requests: String(b.feature_requests || ''),
      notes: [],
      activity_log: [],
      phases: Array.isArray(b.phases)
        ? b.phases.filter((ph) => ph && ph.name).map((ph) => ({
            name: String(ph.name),
            description: String(ph.description || ''),
            hours: Number(ph.hours) || 0,
          }))
        : [],
      created_at: new Date().toISOString(),
    };
    logActivity(project, user, 'created', { name: project.name });
    await saveProject(project);
    res.status(201).json({ project });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
