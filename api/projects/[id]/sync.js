// POST /api/projects/:id/sync - synchroniseer time entries vanuit Moneybird
import { requireUser } from '../../../lib/auth.js';
import { getProject } from '../../../lib/db.js';
import { syncProject } from '../../../lib/sync.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') {
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
  if (!project.moneybird_project_id) {
    res.status(400).json({ error: 'Geen Moneybird-project gekoppeld' });
    return;
  }
  try {
    const count = await syncProject(project);
    res.status(200).json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
