// GET /api/projects/:id/hours-over-time - dagelijkse + cumulatieve uren
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
  const byDay = new Map();
  for (const e of entries) {
    if (!e.started_at) continue;
    const day = String(e.started_at).slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + (Number(e.hours) || 0));
  }
  const labels = Array.from(byDay.keys()).sort();
  const daily = labels.map((d) => Math.round(byDay.get(d) * 100) / 100);
  let acc = 0;
  const cumulative = daily.map((h) => {
    acc += h;
    return Math.round(acc * 100) / 100;
  });

  res.status(200).json({
    labels,
    daily,
    cumulative,
    available: Number(project.available_hours) || 0,
  });
}
