// GET /api/projects/:id/hours-per-user - totaal uren per medewerker
import { requireUser } from '../../../lib/auth.js';
import { getProject, listTimeEntries } from '../../../lib/db.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const project = await getProject(req.query.id);
  if (!project) return res.status(404).json({ error: 'Niet gevonden' });
  if (user.role !== 'admin' && project.manager_id !== user.id) {
    return res.status(403).json({ error: 'Geen toegang' });
  }

  const entries = await listTimeEntries(project.id);
  const byUser = new Map();
  for (const e of entries) {
    const name = e.user_name || 'Onbekend';
    byUser.set(name, (byUser.get(name) || 0) + (Number(e.hours) || 0));
  }
  const pairs = Array.from(byUser.entries()).sort((a, b) => b[1] - a[1]);
  res.status(200).json({
    labels: pairs.map((p) => p[0]),
    hours: pairs.map((p) => Math.round(p[1] * 100) / 100),
  });
}
