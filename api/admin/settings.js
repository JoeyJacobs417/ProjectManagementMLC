// GET   /api/admin/settings            - alle instellingen
// POST  /api/admin/settings            - update instellingen
// POST  /api/admin/settings?action=test_report - stuur direct een test-rapportage
import { requireAdmin } from '../../lib/auth.js';
import { getSettings, saveSettings } from '../../lib/db.js';
import { sendProjectReport } from '../../lib/notify.js';

const REPORT_PERIODS = ['off', 'weekly', 'monthly'];

function normalizeCapacities(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const id = String(k).trim();
    const hours = Number(v);
    if (!id) continue;
    if (Number.isFinite(hours) && hours >= 0) out[id] = Math.round(hours * 10) / 10;
  }
  return out;
}

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const s = await getSettings();
    res.status(200).json({ settings: s });
    return;
  }

  if (req.method === 'POST') {
    // Speciale actie: stuur testrapportage
    if (req.query.action === 'test_report') {
      try {
        const result = await sendProjectReport({ force: true });
        res.status(200).json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    const b = req.body || {};
    const patch = {
      threshold_warning: Number(b.threshold_warning) || 80,
      threshold_critical: Number(b.threshold_critical) || 95,
      threshold_exceeded: Number(b.threshold_exceeded) || 100,
      inactivity_days: Number(b.inactivity_days) || 30,
      notify_emails_extra: String(b.notify_emails_extra || '').trim(),
      pdf_prompt: String(b.pdf_prompt || '').trim(),
      report_period: REPORT_PERIODS.includes(String(b.report_period || '').trim())
        ? String(b.report_period).trim()
        : 'off',
      report_recipients: String(b.report_recipients || '').trim(),
    };
    if (b.employee_capacities !== undefined) {
      patch.employee_capacities = normalizeCapacities(b.employee_capacities);
    }
    const next = await saveSettings(patch);
    res.status(200).json({ settings: next });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
