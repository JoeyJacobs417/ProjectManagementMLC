// Drempel-controle + e-mailverzending via Resend.
import { Resend } from 'resend';
import {
  getSettings,
  isAlertSent,
  recordAlertSent,
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

function buildHtml(project, stats, level, settings) {
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

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return null;

  const resend = new Resend(apiKey);
  await resend.emails.send({
    from,
    to: recipients,
    subject: `[Projectmanager] ${project.name}`,
    html: buildHtml(project, stats, level, settings),
  });
  await recordAlertSent(project.id, level);
  return level;
}
