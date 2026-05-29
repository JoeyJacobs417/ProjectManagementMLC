// Hoge-niveau sync: haalt time entries op uit Moneybird, slaat last_synced_at op,
// checkt drempels + inactiviteit + deadlines + periodieke rapportage.
import { fetchTimeEntries, fetchAllTimeEntriesWithFilter, normalizeTimeEntry } from './moneybird.js';
import {
  listProjects,
  listTimeEntries,
  replaceTimeEntries,
  saveProject,
  getRecentMoneybirdEntries,
  setRecentMoneybirdEntries,
} from './db.js';
import { checkAndNotify, checkInactivityAlerts, maybeSendScheduledReport, checkAllDeadlines } from './notify.js';

export async function syncProject(project) {
  if (!project.moneybird_project_id) return 0;
  const oldEntries = await listTimeEntries(project.id);
  const raw = await fetchTimeEntries(project.moneybird_project_id);
  const normalized = raw.map(normalizeTimeEntry);
  await replaceTimeEntries(project.id, normalized);
  // Werk last_synced_at bij op het project zelf
  project.last_synced_at = new Date().toISOString();
  await saveProject(project);
  await checkAndNotify(project);
  await checkInactivityAlerts(project, oldEntries, normalized);
  return normalized.length;
}

function isoNDaysAgo(n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Pre-warm Redis incrementeel:
// - Elke cron-run halen we alleen de laatste 7 dagen op (klein, past in cron-budget).
// - We mergen die met wat al in de cache zit (oudere entries blijven staan).
// - Entries ouder dan 35 dagen worden gepruned.
// - Resultaat: na ~5 cron-runs heb je 35 dagen historie in cache zonder ooit een grote
//   Moneybird-call te hoeven doen die kan time-outen.
const REFRESH_WINDOW_DAYS = 7;
const RETENTION_DAYS = 35;

export async function refreshRecentMoneybirdEntries() {
  const refreshSince = isoNDaysAgo(REFRESH_WINDOW_DAYS);
  const cutoffIso = isoNDaysAgo(RETENTION_DAYS);

  // 1) Klein 7-daags venster ophalen uit Moneybird.
  const raw = await fetchAllTimeEntriesWithFilter(`started_after:${refreshSince}`);
  const fresh = raw.map(normalizeTimeEntry);

  // 2) Bestaande cache laden, oude entries behouden (binnen retention en buiten refresh-window),
  //    entries die we opnieuw ophalen droppen, entries voorbij retention pruneren.
  const existing = await getRecentMoneybirdEntries();
  const olderKept = (existing && Array.isArray(existing.time_entries) ? existing.time_entries : [])
    .filter((e) => {
      if (!e.started_at) return false;
      const day = String(e.started_at).slice(0, 10);
      return day >= cutoffIso && day < refreshSince;
    });

  // 3) Mergen, dedupliceren op moneybird_id (voor de zekerheid).
  const seen = new Set();
  const merged = [];
  for (const e of [...fresh, ...olderKept]) {
    const id = String(e.moneybird_id || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.push(e);
  }

  // 4) Effectieve coverage = oudste datum daadwerkelijk in de cache.
  let effectiveSince = refreshSince;
  for (const e of merged) {
    const day = String(e.started_at || '').slice(0, 10);
    if (day && day < effectiveSince) effectiveSince = day;
  }

  const payload = {
    time_entries: merged,
    since: effectiveSince,
    cached_at: new Date().toISOString(),
    last_refresh_window_since: refreshSince,
    retention_days: RETENTION_DAYS,
  };
  await setRecentMoneybirdEntries(payload);
  return { count: merged.length, fresh: fresh.length, kept_old: olderKept.length, since: effectiveSince };
}

export async function syncAllProjects() {
  // Pre-warm cache eerst (kleinste taak, mag niet sneuvelen door project-sync timeouts).
  let recentMb = null;
  let recentMbError = null;
  try { recentMb = await refreshRecentMoneybirdEntries(); }
  catch (err) {
    console.error('Refresh recent Moneybird entries faalde:', err.message);
    recentMbError = err.message;
  }

  const projects = await listProjects();
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  for (const p of projects) {
    if (!p.moneybird_project_id) continue;
    try {
      const n = await syncProject(p);
      total += n;
      succeeded++;
    } catch (err) {
      console.error(`Sync mislukt voor project ${p.id}: ${err.message}`);
      failed++;
    }
  }
  let deadlineAlerts = [];
  try { deadlineAlerts = await checkAllDeadlines(); }
  catch (err) { console.error('Deadline check faalde:', err.message); }
  let report = null;
  try { report = await maybeSendScheduledReport(); }
  catch (err) { console.error('Rapportage mislukt:', err.message); }
  return { totalEntries: total, projects: projects.length, succeeded, failed, recentMb, recentMbError, deadlineAlerts, report };
}
