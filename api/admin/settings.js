// GET   /api/admin/settings  - alle instellingen (alle ingelogde users)
// POST  /api/admin/settings  - update (alleen aanwezige velden); admin-only
// POST  /api/admin/settings?action=test_report - test-rapportage; admin-only
import crypto from 'node:crypto';
import { requireUser, requireAdmin } from '../../lib/auth.js';
import { getSettings, saveSettings } from '../../lib/db.js';
import { sendProjectReport, DEFAULT_TEMPLATES } from '../../lib/notify.js';

const REPORT_PERIODS = ['off', 'weekly', 'monthly'];
const VALID_TEMPLATE_KEYS = Object.keys(DEFAULT_TEMPLATES);

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

function normalizeMailTemplates(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const key of VALID_TEMPLATE_KEYS) {
    const t = input[key];
    if (!t || typeof t !== 'object') continue;
    const subject = String(t.subject || '').trim();
    const body = String(t.body || '').trim();
    if (subject || body) out[key] = { subject, body };
  }
  return out;
}

function normalizeHiddenEmployees(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const id of input) {
    const v = String(id || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function normalizeMonthlyRevenueTargets(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!/^\d{4}-\d{2}$/.test(String(k))) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    out[k] = Math.round(n);
  }
  return out;
}

function normalizeDashboardPlanningEmployees(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const id of input) {
    const v = String(id || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function normalizeManualRevenue(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const m of input) {
    if (!m || typeof m !== 'object') continue;
    const moneybird_user_id = String(m.moneybird_user_id || '').trim();
    const month = String(m.month || '').trim();
    const amount = Number(m.amount);
    if (!moneybird_user_id) continue;
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const id = String(m.id || '').trim() || 'mr_' + crypto.randomBytes(6).toString('hex');
    const employee_name = String(m.employee_name || '').trim().slice(0, 200);
    const description = String(m.description || '').trim().slice(0, 500);
    const created_at = String(m.created_at || '').trim() || new Date().toISOString();
    out.push({
      id,
      moneybird_user_id,
      employee_name,
      month,
      amount: Math.round(amount * 100) / 100,
      description,
      created_at,
    });
  }
  out.sort((a, b) => (b.month.localeCompare(a.month)) || (b.created_at.localeCompare(a.created_at)));
  return out;
}

function normalizeOverig(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [empId, weeks] of Object.entries(input)) {
    const id = String(empId).trim();
    if (!id || !weeks || typeof weeks !== 'object') continue;
    const empOut = {};
    for (const [week, val] of Object.entries(weeks)) {
      if (!isIsoDate(week)) continue;
      const hours = Number(val?.hours ?? val);
      const note = String(val?.note || '').trim().slice(0, 500);
      if (!Number.isFinite(hours) || hours < 0) continue;
      empOut[week] = { hours: Math.round(hours * 10) / 10, note };
    }
    if (Object.keys(empOut).length) out[id] = empOut;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    const s = await getSettings();
    res.status(200).json({ settings: s, default_templates: DEFAULT_TEMPLATES });
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
    if (b.report_day_of_week !== undefined) {
      const n = Math.trunc(Number(b.report_day_of_week));
      patch.report_day_of_week = Number.isFinite(n) && n >= 0 && n <= 6 ? n : 1;
    }
    if (b.report_day_of_month !== undefined) {
      const n = Math.trunc(Number(b.report_day_of_month));
      patch.report_day_of_month = Number.isFinite(n) && n >= 1 && n <= 28 ? n : 1;
    }
    if (b.employee_capacities !== undefined) patch.employee_capacities = normalizeCapacities(b.employee_capacities);
    if (b.employee_vacations !== undefined) patch.employee_vacations = normalizeVacations(b.employee_vacations);
    if (b.clients !== undefined) patch.clients = normalizeClients(b.clients);
    if (b.mail_templates !== undefined) patch.mail_templates = normalizeMailTemplates(b.mail_templates);
    if (b.hidden_employees !== undefined) patch.hidden_employees = normalizeHiddenEmployees(b.hidden_employees);
    if (b.monthly_revenue_targets !== undefined) patch.monthly_revenue_targets = normalizeMonthlyRevenueTargets(b.monthly_revenue_targets);
    if (b.dashboard_planning_employees !== undefined) patch.dashboard_planning_employees = normalizeDashboardPlanningEmployees(b.dashboard_planning_employees);
    if (b.employee_overig !== undefined) patch.employee_overig = normalizeOverig(b.employee_overig);
    if (b.manual_revenue !== undefined) patch.manual_revenue = normalizeManualRevenue(b.manual_revenue);
    const next = await saveSettings(patch);
    res.status(200).json({ settings: next });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
