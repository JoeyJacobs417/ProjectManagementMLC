// GET /api/projects  -> lijst projecten (PM ziet alleen eigen, admin ziet alles)
// POST /api/projects -> nieuw project aanmaken
import { requireUser } from '../../lib/auth.js';
import { newId } from '../../lib/auth.js';
import {
  listProjects,
  saveProject,
  listUsers,
  listTimeEntries,
} from '../../lib/db.js';

async function withStats(project) {
  const entries = await listTimeEntries(project.id);
  const hoursUsed = entries.reduce((a, e) => a + (Number(e.hours) || 0), 0);
  const avail = Number(project.available_hours) || 0;
  const pct = avail > 0 ? Math.round((hoursUsed / avail) * 1000) / 10 : 0;
  return { ...project, hours_used: hoursUsed, percentage_used: pct };
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    let projects = await listProjects();
    if (user.role !== 'admin') {
      projects = projects.filter((p) => p.manager_id === user.id);
    }
    // Voeg manager-naam en stats toe
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
      res.status(400).json({ error: 'name verplicht' });
      return;
    }
    const project = {
      id: newId('p_'),
      name: String(b.name),
      description: String(b.description || ''),
      available_hours: Number(b.available_hours) || 0,
      hourly_rate: Number(b.hourly_rate) || 0,
      exceptions: String(b.exceptions || ''),
      moneybird_project_id: b.moneybird_project_id || null,
      source_pdf_filename: b.source_pdf_filename || null,
      manager_id: b.manager_id || null,
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
