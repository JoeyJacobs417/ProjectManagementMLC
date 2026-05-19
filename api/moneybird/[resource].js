// GET /api/moneybird/projects                                - lijst Moneybird-projecten
// GET /api/moneybird/employees                               - lijst medewerkers (incl. email + voornaam)
// GET /api/moneybird/time_entries?since=YYYY-MM-DD&user_id=X - alle time entries sinds datum (gecached)
import { requireUser } from '../../lib/auth.js';
import {
  fetchProjects,
  fetchUsers,
  fetchAllTimeEntriesWithFilter,
  normalizeTimeEntry,
} from '../../lib/moneybird.js';
import {
  listProjects,
  listTimeEntriesBatch,
  getCachedMoneybirdTimeEntries,
  setCachedMoneybirdTimeEntries,
  getCachedMoneybirdUsers,
  setCachedMoneybirdUsers,
} from '../../lib/db.js';

function firstNameOf(name) {
  const t = String(name || '').trim();
  return t ? t.split(/\s+/)[0] : '';
}

async function getMbUsersCached() {
  const cached = await getCachedMoneybirdUsers();
  if (cached && typeof cached === 'object') return cached;
  const users = await fetchUsers();
  const plain = {};
  if (Array.isArray(users)) {
    for (const u of users) {
      plain[String(u.id)] = { name: u.name || '', email: u.email || '' };
    }
  }
  await setCachedMoneybirdUsers(plain);
  return plain;
}

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
    // Combineer Moneybird users (incl. email) + iedereen die in onze projecten uren heeft geschreven
    const map = new Map();
    try {
      const mbUsers = await getMbUsersCached();
      for (const [id, info] of Object.entries(mbUsers)) {
        map.set(id, { id, name: info.name || 'Onbekend', email: info.email || '', first_name: firstNameOf(info.name) });
      }
    } catch (err) {
      console.error('Moneybird users fetch failed:', err.message);
    }
    const projects = await listProjects();
    const entriesByProject = await listTimeEntriesBatch(projects.map((p) => p.id));
    for (const entries of entriesByProject.values()) {
      for (const e of entries) {
        if (!e.user_moneybird_id) continue;
        const id = String(e.user_moneybird_id);
        if (!map.has(id)) {
          map.set(id, { id, name: e.user_name || 'Onbekend', email: '', first_name: firstNameOf(e.user_name) });
        }
      }
    }
    const employees = Array.from(map.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.status(200).json({ employees });
    return;
  }

  if (resource === 'time_entries') {
    try {
      let since = req.query.since;
      if (!since) {
        const d = new Date();
        d.setDate(d.getDate() - 35);
        since = d.toISOString().slice(0, 10);
      }
      const userId = req.query.user_id ? String(req.query.user_id) : null;
      const noCache = req.query.nocache === '1';

      if (!noCache) {
        const cached = await getCachedMoneybirdTimeEntries(since, userId);
        if (cached) {
          res.setHeader('X-Cache', 'HIT');
          res.status(200).json(cached);
          return;
        }
      }

      const filters = [`started_after:${since}`];
      if (userId) filters.push(`user_id:${userId}`);
      const raw = await fetchAllTimeEntriesWithFilter(filters.join(','));
      const time_entries = raw.map(normalizeTimeEntry);
      const payload = { time_entries, since, cached_at: new Date().toISOString() };
      await setCachedMoneybirdTimeEntries(since, userId, payload);
      res.setHeader('X-Cache', 'MISS');
      res.status(200).json(payload);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(404).json({ error: 'Unknown resource' });
}
