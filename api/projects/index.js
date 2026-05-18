// GET /api/projects  -> lijst projecten (PM ziet alleen eigen, admin ziet alles)
// POST /api/projects -> nieuw project aanmaken (moneybird_project_id verplicht)
import { requireUser } from '../../lib/auth.js';
import { newId } from '../../lib/auth.js';
import {
  listProjects,
  saveProject,
  listUsers,
  listTimeEntries,
} from '../../lib/db.js';

const VALID_STATUSES = ['in_progress', 'on_hold', 'done', 'future'];

function normalizeTeam(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const m of input) {
    if (!m) continue;
    const id = String(m.moneybird_user_id || m.id || '').trim();
    const name = String(m.name || '').trim();
    if (!id || !name) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ moneybird_user_id: id, name });
  }
  return out;
}

function normalizeStatus(s) {
  const v = String(s || 'in_progress').toLowerCase();
  return VALID_STATUSES.includes(v) ? v : 'in_progress';
}

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
    team,
    team_stats: teamStats,
    hours_used: hoursUsed,
    percentage_used: pct,
    within_budget: avail > 0 ? hoursUsed <= avail : null,
  };
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
    const enriched = await Promise.all(
      projects.map(async (p) => {
        const stats = await withStats(p);
        const mgr = users.find((u) => u.id === p.manager_id);
        return { ...stats, manager_name: mgr?.name || null };
      })
    );
    enriched.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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
    const project = {
      id: newId('p_'),
      name: String(b.name),
      description: String(b.description || ''),
      available_hours: Number(b.available_hours) || 0,
      hourly_rate: Number(b.hourly_rate) || 0,
      exceptions: String(b.exceptions || ''),
      moneybird_project_id: String(b.moneybird_project_id).trim(),
      source_pdf_filename: b.source_pdf_filename || null,
      manager_id: b.manager_id || null,
      team: normalizeTeam(b.team),
      status: normalizeStatus(b.status),
      phases: Array.isArray(b.phases)
        ? b.phases
            .filter((ph) => ph && ph.name)
            .map((ph) => ({
              name: String(ph.name),
              description: String(ph.description || ''),
              hours: Number(ph.hours) || 0,
            }))
        : [],
      created_at: new Date().toISOString(),
    };
    await saveProject(project);
    res.status(201).json({ project });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
