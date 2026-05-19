// Upstash Redis wrapper — opslag voor users, projects, time entries, settings, sessions.
import { Redis } from '@upstash/redis';

const kv = Redis.fromEnv();

const KEYS = {
  users: 'users',
  projects: 'projects',
  settings: 'settings',
  alertsSent: 'alerts_sent',
  inactivityAlertsSent: 'inactivity_alerts_sent',
  reportSent: 'report_sent',
  timeEntries: (projectId) => `time_entries:${projectId}`,
  session: (token) => `session:${token}`,
};

async function readArr(key) {
  const v = await kv.get(key);
  return Array.isArray(v) ? v : [];
}

async function writeArr(key, arr) {
  await kv.set(key, arr);
}

// ───── Users ──────────────────────────────────────────────────────────
export async function listUsers() {
  return readArr(KEYS.users);
}

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
export async function listProjects() {
  return readArr(KEYS.projects);
}

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

// ───── Time entries ───────────────────────────────────────────────────
export async function listTimeEntries(projectId) {
  return readArr(KEYS.timeEntries(projectId));
}

export async function replaceTimeEntries(projectId, entries) {
  await writeArr(KEYS.timeEntries(projectId), entries);
}

// ───── Settings ───────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  threshold_warning: 80,
  threshold_critical: 95,
  threshold_exceeded: 100,
  inactivity_days: 30,
  notify_emails_extra: '',
  pdf_prompt: '',
  report_period: 'off',
  report_recipients: '',
  employee_capacities: {},
  employee_vacations: {},   // moneybird_user_id -> [{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', label }]
};

export async function getSettings() {
  const v = await kv.get(KEYS.settings);
  const merged = { ...DEFAULT_SETTINGS, ...(v || {}) };
  if (!merged.employee_capacities || typeof merged.employee_capacities !== 'object') {
    merged.employee_capacities = {};
  }
  if (!merged.employee_vacations || typeof merged.employee_vacations !== 'object') {
    merged.employee_vacations = {};
  }
  return merged;
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await kv.set(KEYS.settings, next);
  return next;
}

// ───── Alerts sent ────────────────────────────────────────────────────
export async function getAlertsSent() {
  return readArr(KEYS.alertsSent);
}

export async function isAlertSent(projectId, level) {
  const all = await getAlertsSent();
  return all.some((a) => a.project_id === projectId && a.level === level);
}

export async function recordAlertSent(projectId, level) {
  const all = await getAlertsSent();
  all.push({ project_id: projectId, level, sent_at: new Date().toISOString() });
  await writeArr(KEYS.alertsSent, all);
}

// ───── Inactivity alerts ─────────────────────────────────────────────
export async function isInactivityAlertSent(projectId, userMoneybirdId, returningDate) {
  const all = await readArr(KEYS.inactivityAlertsSent);
  return all.some(
    (a) =>
      a.project_id === projectId &&
      a.user_moneybird_id === userMoneybirdId &&
      a.returning_date === returningDate
  );
}

export async function recordInactivityAlert(projectId, userMoneybirdId, returningDate) {
  const all = await readArr(KEYS.inactivityAlertsSent);
  all.push({
    project_id: projectId,
    user_moneybird_id: userMoneybirdId,
    returning_date: returningDate,
    sent_at: new Date().toISOString(),
  });
  await writeArr(KEYS.inactivityAlertsSent, all);
}

// ───── Report dedupe ──────────────────────────────────────────────────
export async function wasReportSentToday() {
  const v = await kv.get(KEYS.reportSent);
  if (!v || !v.last_sent_date) return false;
  const today = new Date().toISOString().slice(0, 10);
  return v.last_sent_date === today;
}

export async function recordReportSent() {
  await kv.set(KEYS.reportSent, {
    last_sent_date: new Date().toISOString().slice(0, 10),
    sent_at: new Date().toISOString(),
  });
}

// ───── Sessions ──────────────────────────────────────────────────────
export async function createSession(token, userId, ttlSeconds = 60 * 60 * 24 * 7) {
  await kv.set(KEYS.session(token), { user_id: userId, created_at: Date.now() }, { ex: ttlSeconds });
}

export async function getSession(token) {
  if (!token) return null;
  return kv.get(KEYS.session(token));
}

export async function deleteSession(token) {
  if (!token) return;
  await kv.del(KEYS.session(token));
}
