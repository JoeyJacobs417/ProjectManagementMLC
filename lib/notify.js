// Drempel-controle + inactiviteits-alert + e-mailverzending via Resend.
import { Resend } from 'resend';
import {
  getSettings,
  isAlertSent,
  recordAlertSent,
  isInactivityAlertSent,
  recordInactivityAlert,
  listTimeEntries,
  listUsers,
  getUserById,
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
