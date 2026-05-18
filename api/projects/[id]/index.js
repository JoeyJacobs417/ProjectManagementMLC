// GET /api/projects/:id - detail incl. stats
import { requireUser } from '../../../lib/auth.js';
import {
  getProject,
  getUserById,
  listTimeEntries,
} from '../../../lib/db.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const project = await getProject(req.query.id);
  if (!project) {
    res.status(404).json({ error: 'Niet gevonden' });
    return;
  }
  if (user.role !== 'admin' && project.manager_id !== user.id) {
    res.status(403).json({ error: 'Geen toegang' });
    return;
  }
  const entries = await listTimeEntries(project.id);
  const hoursUsed = entries.reduce((a, e) => a + (Number(e.hours) || 0), 0);
  const avail = Number(project.available_hours) || 0;
  const pct = avail > 0 ? Math.round((hoursUsed / avail) * 1000) / 10 : 0;
  const manager = project.manager_id ? await getUserById(project.manager_id) : null;
  res.status(200).json({
    project: {
      ...project,
      hours_used: hoursUsed,
      percentage_used: pct,
      manager_name: manager?.name || null,
      manager_email: manager?.email || null,
    },
  });
}
