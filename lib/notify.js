// Drempel-controle + inactiviteits-alert + deadline-alert + periodieke rapportage + e-mail via Resend.
import { Resend } from 'resend';
import {
  getSettings,
  isAlertSent,
  recordAlertSent,
  isInactivityAlertSent,
  recordInactivityAlert,
  isDeadlineAlertSent,
  recordDeadlineAlert,
  listTimeEntries,
  listProjects,
  listUsers,
  getUserById,
  wasReportSentToday,
  recordReportSent,
} from './db.js';
import { ROLE_ADMIN } from './auth.js';

function levelFor(percentage, s) {
  if (percentage >= s.threshold_exceeded) return 'exceeded';
  if (percentage >= s.threshold_critical) return 'critical';
  if (percentage >= s.threshold_warning) return 'warning';
  return null;
}

export async function projectStats(project) {
  const entries = await listTimeEntries(project.id);
  const hoursUsed = entries.reduce((a, e) => a + (Number(e.hours) || 0), 0);
  const available = Number(project.available_hours) || 0;
  const pct = available > 0 ? Math.round((hoursUsed / available) * 1000) / 10 : 0;
  return { hoursUsed, available, percentage: pct };
}

async function recipientsFor(project, settings) {
  const out = [];
  if (project.manager_id) {
    const pm = await getUserById(project.manager_id);
    if (pm?.email) out.push(pm.email);
  }
  for (const u of await listUsers()) {
    if (u.role === ROLE_ADMIN && u.active && u.email && !out.includes(u.email)) {
      out.push(u.email);
    }
  }
  if (settings.notify_emails_extra) {
    for (const raw of settings.notify_emails_extra.split(',')) {
      const e = raw.trim();
      if (e && !out.includes(e)) out.push(e);
    }
  }
  return out;
}

function sendMail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from || !to || to.length === 0) return null;
  const resend = new Resend(apiKey);
  return resend.emails.send({ from, to, subject, html });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${d}-${m}-${y}`;
}

// ── Drempel-mails (% verbruikt) ──────────────────────────────────────
function buildThresholdHtml(project, stats, level, settings) {
  const titles = {
    warning: `Waarschuwing: ${project.name} zit op ${stats.percentage}% van de uren`,
    critical: `Kritiek: ${project.name} zit op ${stats.percentage}% van de uren`,
    exceeded: `Overschreden: ${project.name} is over de urenlimiet`,
  };
  return `
    <h2>${titles[level]}</h2>
    <p>Hi,</p>
    <p>Het project <strong>${project.name}</strong> heeft op dit moment
       <strong>${stats.hoursUsed.toFixed(1)}</strong> van de
       <strong>${stats.available.toFixed(1)}</strong> beschikbare uren
       verbruikt (<strong>${stats.percentage}%</strong>).</p>
    <p>Drempels: waarschuwing ${settings.threshold_warning}% /
       kritiek ${settings.threshold_critical}% /
       overschreden ${settings.threshold_exceeded}%.</p>
  `;
}

export async function checkAndNotify(project) {
  const settings = await getSettings();
  const stats = await projectStats(project);
  if (!stats.available) return null;
  const level = levelFor(stats.percentage, settings);
  if (!level) return null;
  if (await isAlertSent(project.id, level)) return null;

  const recipients = await recipientsFor(project, settings);
  if (recipients.length === 0) return null;
  if (!(await sendMail(recipients, `[Projectmanager] ${project.name}`, buildThresholdHtml(project, stats, level, settings)))) {
    return null;
  }
  await recordAlertSent(project.id, level);
  return level;
}

// ── Inactiviteits-mails ──────────────────────────────────────────────
function buildInactivityHtml(project, userName, daysSince, returningDate, hours) {
  return `
    <h2>Uren na lange pauze op project ${project.name}</h2>
    <p>Hi,</p>
    <p><strong>${userName}</strong> heeft op <strong>${returningDate}</strong> weer uren
       (<strong>${hours.toFixed(1)}</strong>) geschreven op project
       <strong>${project.name}</strong>, na <strong>${daysSince} dagen</strong> inactiviteit.</p>
    <p>Drempel voor deze melding staat ingesteld op
       ${project._inactivity_threshold} dagen.</p>
  `;
}

function dayOnly(iso) {
  return String(iso || '').slice(0, 10);
}

function daysBetween(laterIso, earlierIso) {
  const later = new Date(laterIso).getTime();
  const earlier = new Date(earlierIso).getTime();
  if (Number.isNaN(later) || Number.isNaN(earlier)) return 0;
  return Math.floor((later - earlier) / (1000 * 60 * 60 * 24));
}

export async function checkInactivityAlerts(project, oldEntries, newEntries) {
  const settings = await getSettings();
  const threshold = Number(settings.inactivity_days) || 30;
  if (threshold <= 0) return [];

  const known = new Set(oldEntries.filter((e) => e.moneybird_id).map((e) => e.moneybird_id));
  const fresh = newEntries.filter((e) => e.moneybird_id && !known.has(e.moneybird_id));
  if (fresh.length === 0) return [];

  const lastByUser = new Map();
  for (const e of oldEntries) {
    if (!e.user_moneybird_id || !e.started_at) continue;
    const prev = lastByUser.get(e.user_moneybird_id);
    if (!prev || new Date(e.started_at) > new Date(prev)) {
      lastByUser.set(e.user_moneybird_id, e.started_at);
    }
  }

  const events = new Map();
  for (const e of fresh) {
    if (!e.user_moneybird_id || !e.started_at) continue;
    const lastIso = lastByUser.get(e.user_moneybird_id);
    if (!lastIso) continue;
    const gap = daysBetween(e.started_at, lastIso);
    if (gap < threshold) continue;
    const date = dayOnly(e.started_at);
    const key = `${e.user_moneybird_id}|${date}`;
    const ex = events.get(key);
    if (!ex || new Date(e.started_at) < new Date(ex.started_at)) {
      events.set(key, {
        user_moneybird_id: e.user_moneybird_id,
        user_name: e.user_name || 'Onbekend',
        returning_date: date,
        started_at: e.started_at,
        gap_days: gap,
        hours: (ex?.hours || 0) + (Number(e.hours) || 0),
      });
    } else {
      ex.hours += Number(e.hours) || 0;
    }
  }
  if (events.size === 0) return [];

  const recipients = await recipientsFor(project, settings);
  const sent = [];
  for (const evt of events.values()) {
    if (await isInactivityAlertSent(project.id, evt.user_moneybird_id, evt.returning_date)) continue;
    if (recipients.length === 0) continue;
    const html = buildInactivityHtml(
      { ...project, _inactivity_threshold: threshold },
      evt.user_name,
      evt.gap_days,
      evt.returning_date,
      evt.hours
    );
    const r = await sendMail(
      recipients,
      `[Projectmanager] Uren na pauze — ${project.name} (${evt.user_name})`,
      html
    );
    if (!r) continue;
    await recordInactivityAlert(project.id, evt.user_moneybird_id, evt.returning_date);
    sent.push(evt);
  }
  return sent;
}

// ── Deadline-mails (naderend of verlopen) ───────────────────────────
function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

function buildDeadlineHtml(project, days, kind) {
  if (kind === 'passed') {
    return `
      <h2>Deadline verlopen: ${escapeHtml(project.name)}</h2>
      <p>De deadline van project <strong>${escapeHtml(project.name)}</strong>
         (${fmtDate(project.deadline)}) is <strong>${-days} dagen geleden</strong> verlopen.</p>
    `;
  }
  return `
    <h2>Deadline nadert: ${escapeHtml(project.name)}</h2>
    <p>Hi,</p>
    <p>De deadline van project <strong>${escapeHtml(project.name)}</strong> is
       op <strong>${fmtDate(project.deadline)}</strong> — dat is over
       <strong>${days} ${days === 1 ? 'dag' : 'dagen'}</strong>.</p>
  `;
}

export async function checkDeadlineAlertForProject(project) {
  if (!project.deadline) return null;
  if (project.status === 'done') return null;
  const days = daysUntil(project.deadline);
  if (days === null) return null;

  const settings = await getSettings();
  const threshold = Number(settings.deadline_alert_days) || 14;
  if (threshold <= 0) return null;

  const recipients = await recipientsFor(project, settings);
  if (recipients.length === 0) return null;

  // Deadline verlopen
  if (days < 0) {
    if (await isDeadlineAlertSent(project.id, project.deadline, 'passed')) return null;
    const r = await sendMail(
      recipients,
      `[Projectmanager] Deadline verlopen — ${project.name}`,
      buildDeadlineHtml(project, days, 'passed')
    );
    if (!r) return null;
    await recordDeadlineAlert(project.id, project.deadline, 'passed');
    return 'passed';
  }

  // Deadline nadert
  if (days <= threshold) {
    if (await isDeadlineAlertSent(project.id, project.deadline, 'approaching')) return null;
    const r = await sendMail(
      recipients,
      `[Projectmanager] Deadline over ${days} ${days === 1 ? 'dag' : 'dagen'} — ${project.name}`,
      buildDeadlineHtml(project, days, 'approaching')
    );
    if (!r) return null;
    await recordDeadlineAlert(project.id, project.deadline, 'approaching');
    return 'approaching';
  }
  return null;
}

export async function checkAllDeadlines() {
  const projects = await listProjects();
  const sent = [];
  for (const p of projects) {
    try {
      const r = await checkDeadlineAlertForProject(p);
      if (r) sent.push({ project_id: p.id, kind: r });
    } catch (err) {
      console.error(`Deadline check faalde voor ${p.id}:`, err.message);
    }
  }
  return sent;
}

// ── Periodieke rapportage ────────────────────────────────────────────
function statusLabel(v) {
  return ({ in_progress: 'In progress', on_hold: 'On hold', done: 'Done', future: 'Future' })[v] || v;
}

function pctColor(pct) {
  if (pct >= 100) return '#b91c1c';
  if (pct >= 80) return '#b45309';
  return '#047857';
}

function buildReportHtml(items, period) {
  const periodLabel = period === 'weekly' ? 'wekelijkse' : 'maandelijkse';
  const today = new Date().toISOString().slice(0, 10);
  const rows = items.map(({ project: p, stats }) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb"><strong>${escapeHtml(p.name)}</strong>${p.module ? ` <span style="color:#64748b">— ${escapeHtml(p.module)}</span>` : ''}${p.is_poc ? ' <span style="background:rgba(139,92,246,.12);color:#6d28d9;padding:1px 6px;border-radius:999px;font-size:11px">POC</span>' : ''}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${p.deadline ? fmtDate(p.deadline) : '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${stats.hoursUsed.toFixed(1)} / ${stats.available.toFixed(1)} u</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:${pctColor(stats.percentage)};font-weight:600">${stats.percentage}%</td>
    </tr>
  `).join('');
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px">
      <h2 style="color:#0f172a">Projectmanager — ${periodLabel} rapportage</h2>
      <p style="color:#64748b">${today} · ${items.length} ${items.length === 1 ? 'project "In progress"' : 'projecten "In progress"'}</p>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb">
        <thead>
          <tr style="background:#f7f8fc">
            <th style="text-align:left;padding:8px;color:#64748b;text-transform:uppercase;font-size:12px;letter-spacing:.04em">Project</th>
            <th style="text-align:left;padding:8px;color:#64748b;text-transform:uppercase;font-size:12px;letter-spacing:.04em">Deadline</th>
            <th style="text-align:left;padding:8px;color:#64748b;text-transform:uppercase;font-size:12px;letter-spacing:.04em">Uren</th>
            <th style="text-align:left;padding:8px;color:#64748b;text-transform:uppercase;font-size:12px;letter-spacing:.04em">%</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

export async function sendProjectReport({ force = false } = {}) {
  const settings = await getSettings();
  if (!force && settings.report_period === 'off') return { sent: false, reason: 'period_off' };

  const recipients = (settings.report_recipients || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (recipients.length === 0) return { sent: false, reason: 'no_recipients' };

  const projects = await listProjects();
  const items = [];
  for (const p of projects) {
    if (p.status !== 'in_progress') continue;
    const stats = await projectStats(p);
    items.push({ project: p, stats });
  }
  if (items.length === 0) return { sent: false, reason: 'no_projects' };

  const period = force ? (settings.report_period === 'off' ? 'weekly' : settings.report_period) : settings.report_period;
  const subject = `[Projectmanager] ${period === 'monthly' ? 'Maandelijkse' : 'Wekelijkse'} rapportage`;
  const r = await sendMail(recipients, subject, buildReportHtml(items, period));
  if (!r) return { sent: false, reason: 'mail_failed' };
  if (!force) await recordReportSent();
  return { sent: true, count: items.length, recipients };
}

export async function maybeSendScheduledReport(now = new Date()) {
  const settings = await getSettings();
  if (settings.report_period === 'off') return { sent: false, reason: 'period_off' };
  const isMonday = now.getUTCDay() === 1;
  const isFirstOfMonth = now.getUTCDate() === 1;
  if (settings.report_period === 'weekly' && !isMonday) return { sent: false, reason: 'not_monday' };
  if (settings.report_period === 'monthly' && !isFirstOfMonth) return { sent: false, reason: 'not_first_of_month' };
  if (await wasReportSentToday()) return { sent: false, reason: 'already_sent_today' };
  return sendProjectReport();
}
