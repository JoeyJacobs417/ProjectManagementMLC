// GET  /api/admin/settings - drempel-instellingen + inactivity_days
// POST /api/admin/settings - opslaan
import { requireAdmin } from '../../lib/auth.js';
import { getSettings, saveSettings } from '../../lib/db.js';

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const s = await getSettings();
    res.status(200).json({ settings: s });
    return;
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const next = await saveSettings({
      threshold_warning: Number(b.threshold_warning) || 80,
      threshold_critical: Number(b.threshold_critical) || 95,
      threshold_exceeded: Number(b.threshold_exceeded) || 100,
      inactivity_days: Number(b.inactivity_days) || 30,
      notify_emails_extra: String(b.notify_emails_extra || '').trim(),
    });
    res.status(200).json({ settings: next });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
