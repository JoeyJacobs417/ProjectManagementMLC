// Upstash Redis wrapper — opslag voor users, projects, time entries, settings, sessions.
import { Redis } from '@upstash/redis';

const kv = Redis.fromEnv();

const KEYS = {
  users: 'users',
  projects: 'projects',
  settings: 'settings',
  alertsSent: 'alerts_sent',
  inactivityAlertsSent: 'inactivity_alerts_sent',
  deadlineAlertsSent: 'deadline_alerts_sent',
  reportSent: 'report_sent',
  timeEntries: (projectId) => `time_entries:${projectId}`,
  session: (token) => `session:${token}`,
  pdfBlob: (projectId) => `pdf:${projectId}`,
  cacheMbTimeEntries: (since, userId) => `cache:mb_time_entries:since:${since}${userId ? ':user:' + userId : ''}`,
  cacheMbUsers: 'cache:mb_users',
  recentMbEntries: 'recent_mb_entries',
};

async function readArr(key) {
  const v = await kv.get(key);
  return Array.isArray(v) ? v : [];
}
async function writeArr(key, arr) { await kv.set(key, arr); }

// ───── Users ──────────────────────────────────────────────────────────
export async function listUsers() { return readArr(KEYS.users); }
export async function getUserById(id) {
  const users = await listUsers();
  return users.find((u) => u.id === id) || null;
}
export async function getUserByEmail(email) {
  const users = await listUsers();
  return users.find((u) => u.email === (email || '').toLowerCase()) || null;
}
export async function saveUser(user) {
  const users = await listUsers();
  const idx = users.findIndex((u) => u.id === user.id);
  if (idx >= 0) users[idx] = user;
  else users.push(user);
  await writeArr(KEYS.users, users);
  return user;
}
export async function deleteUser(id) {
  const users = (await listUsers()).filter((u) => u.id !== id);
  await writeArr(KEYS.users, users);
}

// ───── Projects ───────────────────────────────────────────────────────
export async function listProjects() { return readArr(KEYS.projects); }
export async function getProject(id) {
  const all = await listProjects();
  return all.find((p) => p.id === id) || null;
}
export async function saveProject(project) {
  const all = await listProjects();
  const idx = all.findIndex((p) => p.id === project.id);
  if (idx >= 0) all[idx] = project;
  else all.push(project);
  await writeArr(KEYS.projects, all);
  return project;
}

export async function deleteProject(id) {
  const all = await listProjects();
  const filtered = all.filter((p) => p.id !== id);
  if (filtered.length === all.length) return false;
  await writeArr(KEYS.projects, filtered);
  await kv.del(KEYS.timeEntries(id));
  await kv.del(KEYS.pdfBlob(id));
  const alerts = await readArr(KEYS.alertsSent);
  await writeArr(KEYS.alertsSent, alerts.filter((a) => a.project_id !== id));
  const inactivity = await readArr(KEYS.inactivityAlertsSent);
  await writeArr(KEYS.inactivityAlertsSent, inactivity.filter((a) => a.project_id !== id));
  const deadlines = await readArr(KEYS.deadlineAlertsSent);
  await writeArr(KEYS.deadlineAlertsSent, deadlines.filter((a) => a.project_id !== id));
  return true;
}

// ───── Time entries ───────────────────────────────────────────────────
export async function listTimeEntries(projectId) { return readArr(KEYS.timeEntries(projectId)); }
export async function replaceTimeEntries(projectId, entries) { await writeArr(KEYS.timeEntries(projectId), entries); }

export async function listTimeEntriesBatch(projectIds) {
  const out = new Map();
  if (!projectIds || projectIds.length === 0) return out;
  try {
    const pipe = kv.pipeline();
    for (const id of projectIds) pipe.get(KEYS.timeEntries(id));
    const results = await pipe.exec();
    for (let i = 0; i < projectIds.length; i++) {
      const r = results[i];
      out.set(projectIds[i], Array.isArray(r) ? r : []);
    }
    return out;
  } catch {
    for (const id of projectIds) {
      out.set(id, await listTimeEntries(id));
    }
    return out;
  }
}

// ───── PDF blob ───────────────────────────────────────────────────────
export async function savePdfBlob(projectId, base64, filename, mime = 'application/pdf') {
  await kv.set(KEYS.pdfBlob(projectId), { base64, filename, mime, saved_at: new Date().toISOString() });
}
export async function getPdfBlob(projectId) { return kv.get(KEYS.pdfBlob(projectId)); }
export async function deletePdfBlob(projectId) { await kv.del(KEYS.pdfBlob(projectId)); }

// ───── Moneybird caches ──────────────────────────────────────────────
const MB_TIME_ENTRIES_TTL = 600;
const MB_USERS_TTL = 3600;
export async function getCachedMoneybirdTimeEntries(since, userId) { return kv.get(KEYS.cacheMbTimeEntries(since, userId)); }
export async function setCachedMoneybirdTimeEntries(since, userId, payload) {
  await kv.set(KEYS.cacheMbTimeEntries(since, userId), payload, { ex: MB_TIME_ENTRIES_TTL });
}
export async function getCachedMoneybirdUsers() { return kv.get(KEYS.cacheMbUsers); }
export async function setCachedMoneybirdUsers(users) { await kv.set(KEYS.cacheMbUsers, users, { ex: MB_USERS_TTL }); }

export async function getRecentMoneybirdEntries() { return kv.get(KEYS.recentMbEntries); }
export async function setRecentMoneybirdEntries(payload) {
  await kv.set(KEYS.recentMbEntries, payload);
}

// ───── Settings ───────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  threshold_warning: 80,
  threshold_critical: 95,
  threshold_exceeded: 100,
  inactivity_days: 30,
  deadline_alert_days: 14,
  notify_emails_extra: '',
  pdf_prompt: '',
  report_period: 'off',
  report_recipients: '',
  // Dag waarop de rapportage verstuurd wordt.
  // Wekelijks: 0 = zondag, 1 = maandag, … 6 = zaterdag (default maandag).
  report_day_of_week: 1,
  // Maandelijks: 1–28 (default 1). Wordt aan einde van de maand geclampt.
  report_day_of_month: 1,
  employee_capacities: {},
  employee_vacations: {},
  clients: [],
  mail_templates: {},
  hidden_employees: [],
  // Per-maand omzettarget, key YYYY-MM → euro-bedrag (number).
  monthly_revenue_targets: {},
  // Lijst van moneybird_user_ids die in dashboard-alert verschijnen als ze binnen 7 dagen uit werk lopen.
  dashboard_planning_employees: [],
};

export async function getSettings() {
  const v = await kv.get(KEYS.settings);
  const merged = { ...DEFAULT_SETTINGS, ...(v || {}) };
  if (!merged.employee_capacities || typeof merged.employee_capacities !== 'object') merged.employee_capacities = {};
  if (!merged.employee_vacations || typeof merged.employee_vacations !== 'object') merged.employee_vacations = {};
  if (!Array.isArray(merged.clients)) merged.clients = [];
  if (!merged.mail_templates || typeof merged.mail_templates !== 'object') merged.mail_templates = {};
  if (!Array.isArray(merged.hidden_employees)) merged.hidden_employees = [];
  if (!merged.monthly_revenue_targets || typeof merged.monthly_revenue_targets !== 'object') merged.monthly_revenue_targets = {};
  if (!Array.isArray(merged.dashboard_planning_employees)) merged.dashboard_planning_employees = [];
  return merged;
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await kv.set(KEYS.settings, next);
  return next;
}

// ───── Alerts ──────────────────────────────────────────────────────────
export async function getAlertsSent() { return readArr(KEYS.alertsSent); }
export async function isAlertSent(projectId, level) {
  const all = await getAlertsSent();
  return all.some((a) => a.project_id === projectId && a.level === level);
}
export async function recordAlertSent(projectId, level) {
  const all = await getAlertsSent();
  all.push({ project_id: projectId, level, sent_at: new Date().toISOString() });
  await writeArr(KEYS.alertsSent, all);
}

export async function isInactivityAlertSent(projectId, userMoneybirdId, returningDate) {
  const all = await readArr(KEYS.inactivityAlertsSent);
  return all.some((a) =>
    a.project_id === projectId &&
    a.user_moneybird_id === userMoneybirdId &&
    a.returning_date === returningDate);
}
export async function recordInactivityAlert(projectId, userMoneybirdId, returningDate) {
  const all = await readArr(KEYS.inactivityAlertsSent);
  all.push({ project_id: projectId, user_moneybird_id: userMoneybirdId, returning_date: returningDate, sent_at: new Date().toISOString() });
  await writeArr(KEYS.inactivityAlertsSent, all);
}

export async function isDeadlineAlertSent(projectId, deadlineIso, kind) {
  const all = await readArr(KEYS.deadlineAlertsSent);
  return all.some((a) => a.project_id === projectId && a.deadline === deadlineIso && a.kind === kind);
}
export async function recordDeadlineAlert(projectId, deadlineIso, kind) {
  const all = await readArr(KEYS.deadlineAlertsSent);
  all.push({ project_id: projectId, deadline: deadlineIso, kind, sent_at: new Date().toISOString() });
  await writeArr(KEYS.deadlineAlertsSent, all);
}

export async function wasReportSentToday() {
  const v = await kv.get(KEYS.reportSent);
  if (!v || !v.last_sent_date) return false;
  return v.last_sent_date === new Date().toISOString().slice(0, 10);
}
export async function recordReportSent() {
  await kv.set(KEYS.reportSent, { last_sent_date: new Date().toISOString().slice(0, 10), sent_at: new Date().toISOString() });
}
export async function getLastReportSentDate() {
  const v = await kv.get(KEYS.reportSent);
  return v && v.last_sent_date ? v.last_sent_date : null;
}

// ───── Sessions ───────────────────────────────────────────────────────
export async function createSession(token, userId, ttlSeconds = 60 * 60 * 24 * 7) {
  await kv.set(KEYS.session(token), { user_id: userId, created_at: Date.now() }, { ex: ttlSeconds });
}
export async function getSession(token) { return token ? kv.get(KEYS.session(token)) : null; }
export async function deleteSession(token) { if (token) await kv.del(KEYS.session(token)); }
