// GET /api/projects/:id/hours?type=over-time  - dagelijkse + cumulatieve uren
// GET /api/projects/:id/hours?type=per-user   - totaal uren per medewerker
// Vervangt hours-over-time.js + hours-per-user.js
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
  const type = req.query.type;

  if (type === 'over-time') {
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
      labels, daily, cumulative,
      available: Number(project.available_hours) || 0,
    });
    return;
  }

  if (type === 'per-user') {
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
    return;
  }

  res.status(400).json({ error: "type moet 'over-time' of 'per-user' zijn" });
}
