// Drempel-, inactiviteits-, deadline- en rapportage-mails via Resend.
// Per ontvanger gepersonaliseerde aanhef via {greeting} placeholder.
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
  listTimeEntriesBatch,
  listProjects,
  listUsers,
  getUserById,
  wasReportSentToday,
  recordReportSent,
  getCachedMoneybirdUsers,
  setCachedMoneybirdUsers,
} from './db.js';
import { ROLE_ADMIN } from './auth.js';
import { fetchUsers } from './moneybird.js';

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
function firstNameOf(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}
function renderTemplate(template, vars) {
  let s = String(template || '');
  // {greeting} → "Hi <voornaam>" of "Hi" als geen voornaam
  const greeting = vars.recipient_firstname
    ? `Hi ${vars.recipient_firstname}`
    : 'Hi';
  s = s.replace(/\{greeting\}/g, greeting);
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

// ── Default mailteksten (NL — gebruiken {greeting} voor personalisatie) ──
export const DEFAULT_TEMPLATES = {
  threshold_warning: {
    subject: '[Projectmanager] Waarschuwing — {project_name} op {percentage}%',
    body: `<h2>Waarschuwing: {project_name} zit op {percentage}% van de uren</h2>
<p>{greeting},</p>
<p>Het project <strong>{project_name}</strong> heeft op dit moment
<strong>{hours_used}</strong> van de <strong>{available_hours}</strong>
beschikbare uren verbruikt (<strong>{percentage}%</strong>).</p>
<p>Drempels: waarschuwing {threshold_warning}% / kritiek {threshold_critical}% / overschreden {threshold_exceeded}%.</p>`,
  },
  threshold_critical: {
    subject: '[Projectmanager] KRITIEK — {project_name} op {percentage}%',
    body: `<h2>Kritiek: {project_name} zit op {percentage}% van de uren</h2>
<p>{greeting},</p>
<p>Het project <strong>{project_name}</strong> heeft op dit moment
<strong>{hours_used}</strong> van de <strong>{available_hours}</strong>
beschikbare uren verbruikt (<strong>{percentage}%</strong>).</p>
<p>Drempels: waarschuwing {threshold_warning}% / kritiek {threshold_critical}% / overschreden {threshold_exceeded}%.</p>`,
  },
  threshold_exceeded: {
    subject: '[Projectmanager] OVERSCHREDEN — {project_name}',
    body: `<h2>Overschreden: {project_name} is over de urenlimiet</h2>
<p>{greeting},</p>
<p>Het project <strong>{project_name}</strong> heeft op dit moment
<strong>{hours_used}</strong> van de <strong>{available_hours}</strong>
beschikbare uren verbruikt (<strong>{percentage}%</strong>).</p>
<p>Drempels: waarschuwing {threshold_warning}% / kritiek {threshold_critical}% / overschreden {threshold_exceeded}%.</p>`,
  },
  inactivity: {
    subject: '[Projectmanager] Uren na pauze — {project_name} ({user_name})',
    body: `<h2>Uren na lange pauze op project {project_name}</h2>
<p>{greeting},</p>
<p><strong>{user_name}</strong> heeft op <strong>{returning_date}</strong> weer uren
({hours}) geschreven op project <strong>{project_name}</strong>, na <strong>{days_since} dagen</strong> inactiviteit.</p>
<p>Drempel voor deze melding staat ingesteld op {threshold} dagen.</p>`,
  },
  deadline_approaching: {
    subject: '[Projectmanager] Deadline over {days_until} dagen — {project_name}',
    body: `<h2>Deadline nadert: {project_name}</h2>
<p>{greeting},</p>
<p>De deadline van project <strong>{project_name}</strong> is op
<strong>{deadline_date}</strong> — dat is over <strong>{days_until} dagen</strong>.</p>`,
  },
  deadline_passed: {
    subject: '[Projectmanager] Deadline verlopen — {project_name}',
    body: `<h2>Deadline verlopen: {project_name}</h2>
<p>{greeting},</p>
<p>De deadline van project <strong>{project_name}</strong>
({deadline_date}) is <strong>{days_overdue} dagen geleden</strong> verlopen.</p>`,
  },
};

// ── Default mailteksten (EN — voor contactpersonen die language='en' hebben) ──
export const DEFAULT_TEMPLATES_EN = {
  threshold_warning: {
    subject: '[Projectmanager] Warning — {project_name} at {percentage}%',
    body: `<h2>Warning: {project_name} is at {percentage}% of its hours</h2>
<p>{greeting},</p>
<p>The project <strong>{project_name}</strong> has currently used
<strong>{hours_used}</strong> of the <strong>{available_hours}</strong>
available hours (<strong>{percentage}%</strong>).</p>
<p>Thresholds: warning {threshold_warning}% / critical {threshold_critical}% / exceeded {threshold_exceeded}%.</p>`,
  },
  threshold_critical: {
    subject: '[Projectmanager] CRITICAL — {project_name} at {percentage}%',
    body: `<h2>Critical: {project_name} is at {percentage}% of its hours</h2>
<p>{greeting},</p>
<p>The project <strong>{project_name}</strong> has currently used
<strong>{hours_used}</strong> of the <strong>{available_hours}</strong>
available hours (<strong>{percentage}%</strong>).</p>
<p>Thresholds: warning {threshold_warning}% / critical {threshold_critical}% / exceeded {threshold_exceeded}%.</p>`,
  },
  threshold_exceeded: {
    subject: '[Projectmanager] EXCEEDED — {project_name}',
    body: `<h2>Exceeded: {project_name} is over the hour limit</h2>
<p>{greeting},</p>
<p>The project <strong>{project_name}</strong> has currently used
<strong>{hours_used}</strong> of the <strong>{available_hours}</strong>
available hours (<strong>{percentage}%</strong>).</p>
<p>Thresholds: warning {threshold_warning}% / critical {threshold_critical}% / exceeded {threshold_exceeded}%.</p>`,
  },
  inactivity: {
    subject: '[Projectmanager] Hours after pause — {project_name} ({user_name})',
    body: `<h2>Hours after long pause on project {project_name}</h2>
<p>{greeting},</p>
<p><strong>{user_name}</strong> wrote hours ({hours}) on project <strong>{project_name}</strong>
again on <strong>{returning_date}</strong>, after <strong>{days_since} days</strong> of inactivity.</p>
<p>Threshold for this notification is set to {threshold} days.</p>`,
  },
  deadline_approaching: {
    subject: '[Projectmanager] Deadline in {days_until} days — {project_name}',
    body: `<h2>Deadline approaching: {project_name}</h2>
<p>{greeting},</p>
<p>The deadline of project <strong>{project_name}</strong> is on
<strong>{deadline_date}</strong> — that is in <strong>{days_until} days</strong>.</p>`,
  },
  deadline_passed: {
    subject: '[Projectmanager] Deadline expired — {project_name}',
    body: `<h2>Deadline expired: {project_name}</h2>
<p>{greeting},</p>
<p>The deadline of project <strong>{project_name}</strong>
({deadline_date}) expired <strong>{days_overdue} days ago</strong>.</p>`,
  },
};

function templateFor(settings, name, lang = 'nl') {
  const langKey = lang === 'en' ? `${name}_en` : name;
  const t = settings.mail_templates && settings.mail_templates[langKey];
  const defaults = lang === 'en' ? DEFAULT_TEMPLATES_EN : DEFAULT_TEMPLATES;
  const def = defaults[name] || DEFAULT_TEMPLATES[name];
  return {
    subject: (t && t.subject && t.subject.trim()) || def.subject,
    body: (t && t.body && t.body.trim()) || def.body,
  };
}

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

// ── Moneybird user lookup (gecached) ─────────────────────────────────
async function getMoneybirdUserLookup() {
  try {
    const cached = await getCachedMoneybirdUsers();
    if (cached && typeof cached === 'object') {
      const m = new Map();
      for (const [id, info] of Object.entries(cached)) m.set(String(id), info);
      return m;
    }
  } catch {}
  try {
    const users = await fetchUsers();
    const map = new Map();
    const plain = {};
    if (Array.isArray(users)) {
      for (const u of users) {
        const id = String(u.id);
        const info = { name: u.name || '', email: u.email || '' };
        map.set(id, info);
        plain[id] = info;
      }
    }
    await setCachedMoneybirdUsers(plain);
    return map;
  } catch (err) {
    console.error('Kon Moneybird users niet ophalen:', err.message);
    return new Map();
  }
}

// ── Recipients met naam + taal (voor personalisatie) ────────────────
// Returns: [{ email, name, firstName, language }]
async function recipientsForPersonalized(project, settings, { includeOptedInContacts = false, includeTeam = false } = {}) {
  const out = [];
  const seen = new Set();
  function add(email, name, language = 'nl') {
    const e = String(email || '').trim().toLowerCase();
    if (!e || seen.has(e)) return;
    seen.add(e);
    const lang = String(language || 'nl').toLowerCase() === 'en' ? 'en' : 'nl';
    out.push({ email: String(email).trim(), name: name || '', firstName: firstNameOf(name), language: lang });
  }

  // Projectmanager (interne medewerker → NL)
  if (project.manager_id) {
    const pm = await getUserById(project.manager_id);
    if (pm?.email) add(pm.email, pm.name);
  }
  // Actieve admins → NL
  for (const u of await listUsers()) {
    if (u.role === ROLE_ADMIN && u.active && u.email) add(u.email, u.name);
  }
  // Team via Moneybird → NL
  if (includeTeam && Array.isArray(project.team) && project.team.length > 0) {
    const mbUsers = await getMoneybirdUserLookup();
    for (const t of project.team) {
      const info = mbUsers.get(String(t.moneybird_user_id));
      if (info && info.email) add(info.email, info.name || t.name);
    }
  }
  // Extra ontvangers (komma-string, zonder naam) → NL
  if (settings.notify_emails_extra) {
    for (const raw of settings.notify_emails_extra.split(',')) {
      const e = raw.trim();
      if (e) add(e, '');
    }
  }
  // Klantcontacten met opt-in — gebruiken hun ingestelde taal
  if (includeOptedInContacts && Array.isArray(project.contacts)) {
    for (const c of project.contacts) {
      if (c && c.receives_threshold_mails && c.email) add(c.email, c.name || '', c.language || 'nl');
    }
  }
  return out;
}

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return null;
  return { client: new Resend(apiKey), from };
}

// Verstuurt per ontvanger een eigen mail met gepersonaliseerde body en taal.
// Returns aantal succesvol verstuurde mails.
async function sendPersonalized(recipients, settings, templateName, vars) {
  const setup = getResend();
  if (!setup || !recipients || recipients.length === 0) return 0;
  let ok = 0;
  for (const r of recipients) {
    const tpl = templateFor(settings, templateName, r.language || 'nl');
    const personalVars = { ...vars, recipient_firstname: r.firstName || '' };
    const subject = renderTemplate(tpl.subject, personalVars);
    const html = renderTemplate(tpl.body, personalVars);
    try {
      const res = await setup.client.emails.send({ from: setup.from, to: [r.email], subject, html });
      if (res) ok++;
    } catch (err) {
      console.error(`Mail naar ${r.email} mislukt:`, err.message);
    }
  }
  return ok;
}

// ── Drempel-mails (urenverbruik) ─────────────────────────────────────
export async function checkAndNotify(project) {
  const settings = await getSettings();
  const stats = await projectStats(project);
  if (!stats.available) return null;
  const level = levelFor(stats.percentage, settings);
  if (!level) return null;
  if (await isAlertSent(project.id, level)) return null;

  // Bij drempel-mails: PM + admins + extras + opt-in klantcontacten + team-leden uit Moneybird
  const recipients = await recipientsForPersonalized(project, settings, {
    includeOptedInContacts: true,
    includeTeam: true,
  });
  if (recipients.length === 0) return null;

  const vars = {
    project_name: escapeHtml(project.name),
    percentage: stats.percentage,
    hours_used: stats.hoursUsed.toFixed(1),
    available_hours: stats.available.toFixed(1),
    threshold_warning: settings.threshold_warning,
    threshold_critical: settings.threshold_critical,
    threshold_exceeded: settings.threshold_exceeded,
  };
  const sent = await sendPersonalized(recipients, settings, `threshold_${level}`, vars);
  if (sent === 0) return null;
  await recordAlertSent(project.id, level);
  return level;
}

// ── Inactiviteits-mails ──────────────────────────────────────────────
function dayOnly(iso) { return String(iso || '').slice(0, 10); }
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
    } else { ex.hours += Number(e.hours) || 0; }
  }
  if (events.size === 0) return [];

  const recipients = await recipientsForPersonalized(project, settings);
  const sent = [];
  for (const evt of events.values()) {
    if (await isInactivityAlertSent(project.id, evt.user_moneybird_id, evt.returning_date)) continue;
    if (recipients.length === 0) continue;
    const vars = {
      project_name: escapeHtml(project.name),
      user_name: escapeHtml(evt.user_name),
      returning_date: fmtDate(evt.returning_date),
      days_since: evt.gap_days,
      hours: evt.hours.toFixed(1),
      threshold,
    };
    const okCount = await sendPersonalized(recipients, settings, 'inactivity', vars);
    if (okCount === 0) continue;
    await recordInactivityAlert(project.id, evt.user_moneybird_id, evt.returning_date);
    sent.push(evt);
  }
  return sent;
}

// ── Deadline-mails ───────────────────────────────────────────────────
function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

export async function checkDeadlineAlertForProject(project) {
  if (!project.deadline) return null;
  if (project.status === 'done') return null;
  const days = daysUntil(project.deadline);
  if (days === null) return null;

  const settings = await getSettings();
  const threshold = Number(settings.deadline_alert_days) || 14;
  if (threshold <= 0) return null;

  const recipients = await recipientsForPersonalized(project, settings);
  if (recipients.length === 0) return null;

  if (days < 0) {
    if (await isDeadlineAlertSent(project.id, project.deadline, 'passed')) return null;
    const vars = {
      project_name: escapeHtml(project.name),
      deadline_date: fmtDate(project.deadline),
      days_overdue: -days,
    };
    const okCount = await sendPersonalized(recipients, settings, 'deadline_passed', vars);
    if (okCount === 0) return null;
    await recordDeadlineAlert(project.id, project.deadline, 'passed');
    return 'passed';
  }

  if (days <= threshold) {
    if (await isDeadlineAlertSent(project.id, project.deadline, 'approaching')) return null;
    const vars = {
      project_name: escapeHtml(project.name),
      deadline_date: fmtDate(project.deadline),
      days_until: days,
    };
    const okCount = await sendPersonalized(recipients, settings, 'deadline_approaching', vars);
    if (okCount === 0) return null;
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
    } catch (err) { console.error(`Deadline check faalde voor ${p.id}:`, err.message); }
  }
  return sent;
}

// ── Periodieke rapportage ────────────────────────────────────────────
function statusLabel(v) {
  return ({ in_progress: 'In progress', on_hold: 'On hold', done: 'Done', future: 'Future', recurring: 'Recurring' })[v] || v;
}
function pctColor(pct) { if (pct >= 100) return '#b91c1c'; if (pct >= 80) return '#b45309'; return '#047857'; }

// ── Forecast-berekening (server-side variant van dashboard.html) ─────
const AVG_HOURLY_RATE = 145;

function toIso(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fmtEuro(n) {
  const v = Number(n) || 0;
  return '€ ' + Math.round(v).toLocaleString('nl-NL');
}

function easterSundayInYear(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}
const _holidayCache = new Map();
function dutchHolidaysForYear(year) {
  if (_holidayCache.has(year)) return _holidayCache.get(year);
  const set = new Set();
  set.add(`${year}-01-01`);
  const easter = easterSundayInYear(year);
  const add = (d) => set.add(toIso(d));
  const offset = (n) => { const d = new Date(easter); d.setDate(easter.getDate() + n); return d; };
  add(offset(-2)); // Goede Vrijdag
  add(easter);     // Paaszondag
  add(offset(1));  // 2e Paasdag
  let king = new Date(year, 3, 27);
  if (king.getDay() === 0) king = new Date(year, 3, 26);
  add(king);
  set.add(`${year}-05-05`); // Bevrijdingsdag
  add(offset(39));  // Hemelvaart
  add(offset(49));  // Pinksterzondag
  add(offset(50));  // 2e Pinksterdag
  set.add(`${year}-12-25`);
  set.add(`${year}-12-26`);
  _holidayCache.set(year, set);
  return set;
}
function isDutchHoliday(iso) {
  const [y] = iso.split('-').map(Number);
  return dutchHolidaysForYear(y).has(iso);
}
function isOnVacation(iso, periods) {
  return (periods || []).some((p) => p.start <= iso && iso <= p.end);
}
function workdaysInRange(startD, endD, vacationPeriods) {
  if (startD > endD) return 0;
  let count = 0;
  const d = new Date(startD);
  while (d <= endD) {
    const iso = toIso(d);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !isDutchHoliday(iso) && !isOnVacation(iso, vacationPeriods)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}
function getFutureWorkdaysInMonth(monthIso, empVacations) {
  const [y, m] = monthIso.split('-').map(Number);
  const firstDay = new Date(y, m - 1, 1);
  const lastDay = new Date(y, m, 0);
  const tomorrow = new Date(); tomorrow.setHours(0, 0, 0, 0); tomorrow.setDate(tomorrow.getDate() + 1);
  const start = tomorrow > firstDay ? tomorrow : firstDay;
  return workdaysInRange(start, lastDay, empVacations);
}
function weekStartsInMonth(monthIso) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  const thisMonday = new Date(today); thisMonday.setDate(thisMonday.getDate() + diff);
  const out = [];
  const [y, m] = monthIso.split('-').map(Number);
  const lastDayNum = new Date(y, m, 0).getDate();
  const first = `${monthIso}-01`;
  const last = `${monthIso}-${String(lastDayNum).padStart(2, '0')}`;
  for (let i = 0; i < 4; i++) {
    const d = new Date(thisMonday); d.setDate(d.getDate() + i * 7);
    const iso = toIso(d);
    if (iso >= first && iso <= last) out.push(iso);
  }
  return out;
}

function computeRealizedForMonth(projects, monthIso, todayIso) {
  const out = new Map();
  for (const p of projects) {
    const rate = Number(p.hourly_rate) || 0;
    if (rate <= 0) continue;
    const entries = (p.time_entries || []).filter((e) => {
      if (!e.started_at) return false;
      const day = String(e.started_at).slice(0, 10);
      return day.startsWith(monthIso) && day <= todayIso;
    });
    if (entries.length === 0) continue;
    const hoursInMonth = entries.reduce((a, e) => a + (Number(e.hours) || 0), 0);
    if (hoursInMonth <= 0) continue;
    const hoursTotal = Number(p.hours_used) || 0;
    const hoursBefore = Math.max(0, hoursTotal - hoursInMonth);
    let declarable;
    if (p.is_hourly_billing) declarable = hoursInMonth;
    else {
      const cap = Math.max(0, (Number(p.available_hours) || 0) - hoursBefore);
      declarable = Math.min(cap, hoursInMonth);
    }
    if (declarable <= 0) continue;
    const byMember = new Map();
    for (const e of entries) {
      if (!e.user_moneybird_id) continue;
      byMember.set(e.user_moneybird_id, (byMember.get(e.user_moneybird_id) || 0) + (Number(e.hours) || 0));
    }
    for (const [memberId, memberHours] of byMember) {
      const memberDeclarable = (memberHours / hoursInMonth) * declarable;
      const cur = out.get(memberId) || { hours: 0, revenue: 0 };
      cur.hours += memberDeclarable;
      cur.revenue += memberDeclarable * rate;
      out.set(memberId, cur);
    }
  }
  return out;
}

function computePlannedForWeeks(projects, weekStarts) {
  const weekSet = new Set(weekStarts);
  const out = new Map();
  for (const p of projects) {
    if (p.status === 'done') continue;
    const rate = Number(p.hourly_rate) || 0;
    if (rate <= 0) continue;
    const allocs = (p.weekly_allocations || []).filter((a) => weekSet.has(a.week_start));
    if (allocs.length === 0) continue;
    const byMember = new Map();
    for (const a of allocs) {
      const h = Number(a.hours) || 0;
      if (h <= 0) continue;
      byMember.set(a.moneybird_user_id, (byMember.get(a.moneybird_user_id) || 0) + h);
    }
    const totalAlloc = Array.from(byMember.values()).reduce((a, h) => a + h, 0);
    if (totalAlloc <= 0) continue;
    let cappedTotal = totalAlloc;
    if (!p.is_hourly_billing) {
      const remaining = Math.max(0, (Number(p.available_hours) || 0) - (Number(p.hours_used) || 0));
      cappedTotal = Math.min(totalAlloc, remaining);
    }
    if (cappedTotal <= 0) continue;
    const factor = cappedTotal / totalAlloc;
    for (const [memberId, memberHours] of byMember) {
      const capped = memberHours * factor;
      const cur = out.get(memberId) || { hours: 0, revenue: 0 };
      cur.hours += capped;
      cur.revenue += capped * rate;
      out.set(memberId, cur);
    }
  }
  return out;
}

export async function computeMonthForecast() {
  const settings = await getSettings();
  const capacities = settings.employee_capacities || {};
  const vacations = settings.employee_vacations || {};
  const monthlyTargets = settings.monthly_revenue_targets || {};
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monthIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const todayIso = toIso(today);

  const projects = await listProjects();
  const entriesByProject = await listTimeEntriesBatch(projects.map((p) => p.id));
  const enriched = projects.map((p) => {
    const entries = entriesByProject.get(p.id) || [];
    const hoursUsed = entries.reduce((a, e) => a + (Number(e.hours) || 0), 0);
    return { ...p, hours_used: hoursUsed, time_entries: entries };
  });

  const empMap = new Map();
  function ensureEmp(id, name) {
    if (!empMap.has(id)) {
      empMap.set(id, {
        id, name: name || 'Onbekend',
        realizedHours: 0, realizedRevenue: 0,
        plannedHours: 0, plannedRevenue: 0,
        potentialRevenue: 0,
      });
    }
    return empMap.get(id);
  }
  for (const p of enriched) {
    if (p.status === 'done') continue;
    for (const t of (p.team || [])) ensureEmp(t.moneybird_user_id, t.name);
  }
  for (const p of enriched) {
    for (const e of (p.time_entries || [])) {
      if (e.user_moneybird_id) ensureEmp(e.user_moneybird_id, e.user_name);
    }
  }

  const realized = computeRealizedForMonth(enriched, monthIso, todayIso);
  for (const [id, r] of realized) {
    const rec = ensureEmp(id);
    rec.realizedHours = r.hours;
    rec.realizedRevenue = r.revenue;
  }

  const weeks = weekStartsInMonth(monthIso);
  const planned = computePlannedForWeeks(enriched, weeks);
  for (const [id, pl] of planned) {
    const rec = ensureEmp(id);
    rec.plannedHours = pl.hours;
    rec.plannedRevenue = pl.revenue;
  }

  for (const rec of empMap.values()) {
    const cap = Number(capacities[rec.id]) || 0;
    if (cap <= 0) continue;
    const empVacations = vacations[rec.id] || [];
    const workdays = getFutureWorkdaysInMonth(monthIso, empVacations);
    rec.potentialRevenue = (cap / 5) * workdays * AVG_HOURLY_RATE;
  }

  const rows = Array.from(empMap.values())
    .map((r) => ({ ...r, forecastRevenue: r.realizedRevenue + r.plannedRevenue }))
    .filter((r) => r.realizedRevenue > 0 || r.plannedRevenue > 0 || r.potentialRevenue > 0)
    .sort((a, b) => b.forecastRevenue - a.forecastRevenue);
  const grandTotal = rows.reduce((a, r) => a + r.forecastRevenue, 0);
  const target = Number(monthlyTargets[monthIso] || 0);
  return { rows, grandTotal, target, monthIso };
}

function buildForecastSectionHtml({ rows, grandTotal, target, monthIso }) {
  let targetHtml = '';
  if (target > 0) {
    const diff = grandTotal - target;
    const pct = target > 0 ? Math.round((grandTotal / target) * 100) : 0;
    const onTarget = grandTotal >= target;
    const color = onTarget ? '#047857' : '#b91c1c';
    const icon = onTarget ? '✓' : '⚠';
    const label = onTarget
      ? `target ${fmtEuro(target)} gehaald (+${fmtEuro(Math.max(0, diff))})`
      : `tekort ${fmtEuro(Math.abs(diff))} op target ${fmtEuro(target)}`;
    targetHtml = `<div style="margin:8px 0 12px;color:${color};font-weight:600">${icon} ${pct}% — ${label}</div>`;
  }
  if (rows.length === 0) {
    return `<h2 style="color:#0f172a;margin:0 0 8px">Voorspelde omzet — ${monthIso}</h2>
      ${targetHtml}
      <p style="color:#64748b">Geen actieve projecten of geen gewerkte/ingeplande uren voor deze maand.</p>`;
  }
  const cellStyle = 'padding:8px;border-bottom:1px solid #e5e7eb';
  const tableRows = rows.map((r) => `
    <tr>
      <td style="${cellStyle}"><strong>${escapeHtml(r.name)}</strong></td>
      <td style="${cellStyle}">${r.realizedRevenue > 0
        ? `<strong>${fmtEuro(r.realizedRevenue)}</strong> <span style="color:#64748b">(${r.realizedHours.toFixed(1)} u)</span>`
        : '<span style="color:#64748b">—</span>'}</td>
      <td style="${cellStyle}">${r.potentialRevenue > 0
        ? fmtEuro(r.potentialRevenue)
        : '<span style="color:#64748b">geen capaciteit</span>'}</td>
      <td style="${cellStyle}">${r.plannedRevenue > 0
        ? `<strong>${fmtEuro(r.plannedRevenue)}</strong> <span style="color:#64748b">(${r.plannedHours.toFixed(1)} u)</span>`
        : '<span style="color:#64748b">—</span>'}</td>
      <td style="${cellStyle}"><strong>${fmtEuro(r.forecastRevenue)}</strong></td>
    </tr>`).join('');
  const thStyle = 'text-align:left;padding:8px;color:#64748b;text-transform:uppercase;font-size:12px;letter-spacing:.04em';
  return `<h2 style="color:#0f172a;margin:0 0 8px">Voorspelde omzet — ${monthIso}</h2>
    <div style="color:#64748b;margin-bottom:8px">Totaal voorspelde omzet t/m einde van de maand: <strong style="color:#0f172a">${fmtEuro(grandTotal)}</strong></div>
    ${targetHtml}
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;margin-bottom:24px">
      <thead><tr style="background:#f7f8fc">
        <th style="${thStyle}">Medewerker</th>
        <th style="${thStyle}">Reeds omgezet</th>
        <th style="${thStyle}">Potentiele omzet</th>
        <th style="${thStyle}">Geplande omzet</th>
        <th style="${thStyle}">Voorspelde omzet</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>`;
}
function buildProjectsSectionHtml(items) {
  const rows = items.map(({ project: p, stats }) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb"><strong>${escapeHtml(p.name)}</strong>${p.module ? ` <span style="color:#64748b">— ${escapeHtml(p.module)}</span>` : ''}${p.is_poc ? ' <span style="background:rgba(139,92,246,.12);color:#6d28d9;padding:1px 6px;border-radius:999px;font-size:11px">POC</span>' : ''}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${p.deadline ? fmtDate(p.deadline) : '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${stats.hoursUsed.toFixed(1)} / ${stats.available.toFixed(1)} u</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:${pctColor(stats.percentage)};font-weight:600">${stats.percentage}%</td>
    </tr>`).join('');
  const thStyle = 'text-align:left;padding:8px;color:#64748b;text-transform:uppercase;font-size:12px;letter-spacing:.04em';
  return `<h2 style="color:#0f172a;margin:0 0 8px">Status projecten</h2>
    <div style="color:#64748b;margin-bottom:8px">${items.length} ${items.length === 1 ? 'project "In progress"' : 'projecten "In progress"'}</div>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb">
      <thead><tr style="background:#f7f8fc">
        <th style="${thStyle}">Project</th>
        <th style="${thStyle}">Deadline</th>
        <th style="${thStyle}">Uren</th>
        <th style="${thStyle}">%</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
}

function buildReportHtml(items, period, forecast) {
  const periodLabel = period === 'weekly' ? 'wekelijkse' : 'maandelijkse';
  const today = new Date().toISOString().slice(0, 10);
  const forecastHtml = forecast ? buildForecastSectionHtml(forecast) : '';
  const projectsHtml = buildProjectsSectionHtml(items);
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px">
    <h1 style="color:#0f172a;font-size:20px;margin:0 0 4px">Projectmanager — ${periodLabel} rapportage</h1>
    <p style="color:#64748b;margin:0 0 24px">${today}</p>
    ${forecastHtml}
    ${projectsHtml}
  </div>`;
}

export async function sendProjectReport({ force = false } = {}) {
  const settings = await getSettings();
  if (!force && settings.report_period === 'off') return { sent: false, reason: 'period_off' };

  const emails = (settings.report_recipients || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (emails.length === 0) return { sent: false, reason: 'no_recipients' };

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
  const setup = getResend();
  if (!setup) return { sent: false, reason: 'mail_failed' };
  let forecast = null;
  try { forecast = await computeMonthForecast(); }
  catch (err) { console.error('Forecast voor rapportage faalde:', err.message); }
  try {
    await setup.client.emails.send({ from: setup.from, to: emails, subject, html: buildReportHtml(items, period, forecast) });
  } catch (err) {
    return { sent: false, reason: 'mail_failed', error: err.message };
  }
  if (!force) await recordReportSent();
  return { sent: true, count: items.length, recipients: emails };
}

export async function maybeSendScheduledReport(now = new Date()) {
  const settings = await getSettings();
  if (settings.report_period === 'off') return { sent: false, reason: 'period_off' };
  if (settings.report_period === 'weekly') {
    const wantDow = Number.isInteger(settings.report_day_of_week) ? settings.report_day_of_week : 1;
    if (now.getUTCDay() !== wantDow) return { sent: false, reason: 'not_scheduled_day' };
  } else if (settings.report_period === 'monthly') {
    const wantDom = Number.isInteger(settings.report_day_of_month) && settings.report_day_of_month >= 1 && settings.report_day_of_month <= 28
      ? settings.report_day_of_month : 1;
    // Clamp aan einde van de maand (bv. 31e in februari → laatste dag).
    const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const effectiveDom = Math.min(wantDom, lastDayOfMonth);
    if (now.getUTCDate() !== effectiveDom) return { sent: false, reason: 'not_scheduled_day' };
  }
  if (await wasReportSentToday()) return { sent: false, reason: 'already_sent_today' };
  return sendProjectReport();
}
