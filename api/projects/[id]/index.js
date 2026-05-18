// GET   /api/projects/:id - detail incl. stats
// PATCH /api/projects/:id - update editable fields (status, team, name, description, ...)
import { requireUser } from '../../../lib/auth.js';
import {
  getProject,
  saveProject,
  getUserById,
  listTimeEntries,
} from '../../../lib/db.js';

const VALID_STATUSES = ['in_progress', 'on_hold', 'done', 'future'];
const EDITABLE_FIELDS = [
  'name',
  'description',
  'available_hours',
  'hourly_rate',
  'exceptions',
  'manager_id',
];

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
    team,
    team_stats,
    hours_used: hoursUsed,
    percentage_used: pct,
    within_budget: avail > 0 ? hoursUsed <= avail : null,
    manager_name: manager?.name || null,
    manager_email: manager?.email || null,
  };
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
    res.status(200).json({ project: await buildDetail(project) });
    return;
  }

  if (req.method === 'PATCH') {
    const b = req.body || {};
    for (const f of EDITABLE_FIELDS) {
      if (b[f] !== undefined) project[f] = b[f];
    }
    if (b.status !== undefined) {
      const s = String(b.status).toLowerCase();
      project.status = VALID_STATUSES.includes(s) ? s : project.status || 'in_progress';
    }
    if (b.team !== undefined) {
      project.team = normalizeTeam(b.team);
    }
    if (typeof project.available_hours === 'string') {
      project.available_hours = Number(project.available_hours) || 0;
    }
    if (typeof project.hourly_rate === 'string') {
      project.hourly_rate = Number(project.hourly_rate) || 0;
    }
    await saveProject(project);
    res.status(200).json({ project: await buildDetail(project) });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
