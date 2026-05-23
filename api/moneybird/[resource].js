// GET /api/moneybird/projects                                - lijst Moneybird-projecten
// GET /api/moneybird/employees                               - lijst medewerkers (incl. email + voornaam)
// GET /api/moneybird/time_entries?since=YYYY-MM-DD&user_id=X - time entries (3-pass: bulk-cache → Moneybird user-filter → lokaal)
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
  getCachedMoneybirdUsers,
  setCachedMoneybirdUsers,
  getRecentMoneybirdEntries,
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
    // Combineer Moneybird users (incl. email) + iedereen die in onze projecten uren heeft geschreven.
    // Met ?nocache=1 wordt de Moneybird users-cache eerst geforceerd ververst.
    const noCache = req.query.nocache === '1';
    const map = new Map();
    try {
      let mbUsers;
      if (noCache) {
        const users = await fetchUsers();
        const plain = {};
        if (Array.isArray(users)) {
          for (const u of users) {
            plain[String(u.id)] = { name: u.name || '', email: u.email || '' };
          }
        }
        await setCachedMoneybirdUsers(plain);
        mbUsers = plain;
      } else {
        mbUsers = await getMbUsersCached();
      }
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

      function inWindow(e) {
        if (!e.started_at) return false;
        if (String(e.started_at).slice(0, 10) < since) return false;
        if (userId && String(e.user_moneybird_id || '') !== userId) return false;
        return true;
      }

      // ─── Pass 1: incrementele bulk-cache (gevuld door cron, 7d per run) ──
      // Wordt elke nacht aangevuld; na ~5 nachten 35 dagen historie compleet.
      // ALTIJD instant. Toont entries op zowel gekoppelde als ongekoppelde
      // Moneybird-projecten — exact wat de medewerker-pagina nodig heeft.
      const recent = await getRecentMoneybirdEntries();
      if (recent && Array.isArray(recent.time_entries) && recent.time_entries.length > 0) {
        const time_entries = recent.time_entries.filter(inWindow);
        const coverageSince = recent.since || null;
        const partial = coverageSince && coverageSince > since;
        res.setHeader('X-Source', partial ? 'cache-partial' : 'cache');
        res.status(200).json({
          time_entries, since,
          source: partial ? 'cache-partial' : 'cache',
          coverage_since: coverageSince,
          cached_at: recent.cached_at || null,
        });
        return;
      }

      // ─── Pass 2: Moneybird live met user_id-filter (alleen als cache leeg) ─
      // Probeert eerst de meegegeven user_id (AdministrationUser-id uit /users.json).
      // Bij 404: zoekt in de lokale cache naar een entry van deze user en pakt diens
      // top-level user_id (uit time-entry data) — Moneybird's filter accepteert vaak
      // alleen die. Probeert maximaal 2 filter-keys.
      if (userId) {
        const filterCandidates = [userId];
        try {
          const projects = await listProjects();
          const entriesByProject = await listTimeEntriesBatch(projects.map((p) => p.id));
          for (const entries of entriesByProject.values()) {
            const found = entries.find((e) =>
              String(e.user_moneybird_id || '') === userId && e.user_top_id && e.user_top_id !== userId
            );
            if (found) { filterCandidates.push(found.user_top_id); break; }
          }
        } catch {}

        let lastErr = null;
        for (const candidate of filterCandidates) {
          try {
            const raw = await fetchAllTimeEntriesWithFilter(`started_after:${since},user_id:${candidate}`);
            const time_entries = raw.map(normalizeTimeEntry).filter(inWindow);
            res.setHeader('X-Source', 'moneybird-live-user');
            res.setHeader('X-User-Filter-Id', candidate);
            res.status(200).json({ time_entries, since, source: 'moneybird-live-user', used_filter_id: candidate });
            return;
          } catch (err) {
            lastErr = err;
            if (!/Moneybird 404/.test(err.message)) throw err;
            // 404: probeer volgende kandidaat
          }
        }
        // Beide kandidaten faalden met 404 → val door naar pass 3.
      }

      // ─── Pass 3: lokale per-project cache (alleen tracked) ───────────────
      // Allerlaatste vangnet, voor het zeldzame geval dat de bulk-cache nog
      // helemaal leeg is én de user_id-filter 404 gaf.
      const projects = await listProjects();
      const projectIds = projects.map((p) => p.id);
      const entriesByProject = await listTimeEntriesBatch(projectIds);
      const projectById = new Map(projects.map((p) => [p.id, p]));
      const time_entries = [];
      for (const [pid, entries] of entriesByProject) {
        const p = projectById.get(pid);
        if (!p) continue;
        for (const e of entries) {
          if (!inWindow(e)) continue;
          time_entries.push({
            ...e,
            moneybird_project_id: e.moneybird_project_id || p.moneybird_project_id || null,
            moneybird_project_name: e.moneybird_project_name || p.name || null,
          });
        }
      }
      res.setHeader('X-Source', 'local-tracked-only');
      res.status(200).json({ time_entries, since, source: 'local-tracked-only' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(404).json({ error: 'Unknown resource' });
}
