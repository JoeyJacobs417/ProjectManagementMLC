// Cron-endpoint: aangeroepen door Vercel Cron (configuratie in vercel.json).
// Synchroniseert alle gekoppelde projecten en checkt drempels.
import { syncAllProjects } from '../../lib/sync.js';

export default async function handler(req, res) {
  // Vercel zet de Authorization-header met de CRON_SECRET op cron-jobs.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }
  try {
    const result = await syncAllProjects();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
