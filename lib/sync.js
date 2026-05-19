// Hoge-niveau sync: haalt time entries op uit Moneybird, slaat last_synced_at op,
// checkt drempels + inactiviteit + deadlines + periodieke rapportage.
import { fetchTimeEntries, normalizeTimeEntry } from './moneybird.js';
import { listProjects, listTimeEntries, replaceTimeEntries, saveProject } from './db.js';
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

export async function syncAllProjects() {
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
  return { totalEntries: total, projects: projects.length, succeeded, failed, deadlineAlerts, report };
}
