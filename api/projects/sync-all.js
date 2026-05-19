// POST /api/projects/sync-all
// Synchroniseert alle gekoppelde Moneybird-projecten in één keer.
// Beschikbaar voor alle ingelogde gebruikers.
import { requireUser } from '../../lib/auth.js';
import { syncAllProjects } from '../../lib/sync.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const result = await syncAllProjects();
    res.status(200).json({ ok: true, ...result, synced_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
