// GET   /api/admin/settings  - alle instellingen (alle ingelogde users mogen lezen)
// POST  /api/admin/settings  - update (alleen aanwezige velden in body); admin-only
// POST  /api/admin/settings?action=test_report - stuur direct een test-rapportage; admin-only
import crypto from 'node:crypto';
import { requireUser, requireAdmin } from '../../lib/auth.js';
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

function isIsoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function normalizeVacations(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [k, list] of Object.entries(input)) {
    const id = String(k).trim();
    if (!id || !Array.isArray(list)) continue;
    const periods = [];
    for (const p of list) {
      if (!p) continue;
      const start = String(p.start || '').trim();
      const end = String(p.end || '').trim();
      const label = String(p.label || '').trim();
      if (!isIsoDate(start) || !isIsoDate(end) || start > end) continue;
      periods.push({ start, end, label });
    }
    periods.sort((a, b) => a.start.localeCompare(b.start));
    if (periods.length) out[id] = periods;
  }
  return out;
}

function normalizeClients(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const c of input) {
    if (!c) continue;
    const name = String(c.name || '').trim();
    if (!name) continue;
    const id = String(c.id || '').trim() || 'c_' + crypto.randomBytes(6).toString('hex');
    if (seen.has(id)) continue;
    seen.add(id);
    const contacts = Array.isArray(c.contacts) ? c.contacts.map((x) => ({
      name: String(x.name || '').trim(),
      email: String(x.email || '').trim(),
    })).filter((x) => x.name || x.email) : [];
    out.push({ id, name, contacts });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    const s = await getSettings();
    res.status(200).json({ settings: s });
    return;
  }

  if (req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

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
    const patch = {};
    if (b.threshold_warning !== undefined) patch.threshold_warning = Number(b.threshold_warning) || 80;
    if (b.threshold_critical !== undefined) patch.threshold_critical = Number(b.threshold_critical) || 95;
    if (b.threshold_exceeded !== undefined) patch.threshold_exceeded = Number(b.threshold_exceeded) || 100;
    if (b.inactivity_days !== undefined) patch.inactivity_days = Number(b.inactivity_days) || 30;
    if (b.deadline_alert_days !== undefined) patch.deadline_alert_days = Number(b.deadline_alert_days) || 14;
    if (b.notify_emails_extra !== undefined) patch.notify_emails_extra = String(b.notify_emails_extra || '').trim();
    if (b.pdf_prompt !== undefined) patch.pdf_prompt = String(b.pdf_prompt || '').trim();
    if (b.report_period !== undefined) {
      const v = String(b.report_period || '').trim();
      patch.report_period = REPORT_PERIODS.includes(v) ? v : 'off';
    }
    if (b.report_recipients !== undefined) patch.report_recipients = String(b.report_recipients || '').trim();
    if (b.employee_capacities !== undefined) patch.employee_capacities = normalizeCapacities(b.employee_capacities);
    if (b.employee_vacations !== undefined) patch.employee_vacations = normalizeVacations(b.employee_vacations);
    if (b.clients !== undefined) patch.clients = normalizeClients(b.clients);
    const next = await saveSettings(patch);
    res.status(200).json({ settings: next });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
