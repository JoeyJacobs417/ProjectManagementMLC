// GET /api/moneybird/projects   - lijst Moneybird-projecten voor dropdown
// GET /api/moneybird/employees  - lijst medewerkers (Moneybird users + iedereen uit time entries)
import { requireUser } from '../../lib/auth.js';
import { fetchProjects, fetchUsers } from '../../lib/moneybird.js';
import { listProjects, listTimeEntries } from '../../lib/db.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const resource = req.query.resource;

  if (resource === 'projects') {
    try {
      const raw = await fetchProjects();
      const simplified = raw
        .filter((p) => p.state !== 'archived')
        .map((p) => ({ id: String(p.id), name: p.name }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      res.status(200).json({ projects: simplified });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (resource === 'employees') {
    const seen = new Map();

    try {
      const users = await fetchUsers();
      if (Array.isArray(users)) {
        for (const u of users) {
          const id = String(u.id);
          if (!seen.has(id)) seen.set(id, u.name || u.email || 'Onbekend');
        }
      }
    } catch {
      // Token heeft geen toegang tot users — vallen terug op time entries
    }

    const projects = await listProjects();
    for (const p of projects) {
      const entries = await listTimeEntries(p.id);
      for (const e of entries) {
        if (e.user_moneybird_id && !seen.has(e.user_moneybird_id)) {
          seen.set(e.user_moneybird_id, e.user_name || 'Onbekend');
        }
      }
    }

    const employees = Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
    employees.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.status(200).json({ employees });
    return;
  }

  res.status(404).json({ error: 'Unknown resource' });
}
