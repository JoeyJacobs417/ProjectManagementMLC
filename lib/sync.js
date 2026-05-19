// Hoge-niveau sync: haalt time entries op uit Moneybird + checkt drempels
// + verstuurt eventueel de periodieke rapportage + checkt alle deadlines.
import { fetchTimeEntries, normalizeTimeEntry } from './moneybird.js';
import { listProjects, listTimeEntries, replaceTimeEntries } from './db.js';
import { checkAndNotify, checkInactivityAlerts, maybeSendScheduledReport, checkAllDeadlines } from './notify.js';

export async function syncProject(project) {
  if (!project.moneybird_project_id) return 0;
  const oldEntries = await listTimeEntries(project.id);
  const raw = await fetchTimeEntries(project.moneybird_project_id);
  const normalized = raw.map(normalizeTimeEntry);
  await replaceTimeEntries(project.id, normalized);
  await checkAndNotify(project);
  await checkInactivityAlerts(project, oldEntries, normalized);
  return normalized.length;
}

export async function syncAllProjects() {
  const projects = await listProjects();
  let total = 0;
  for (const p of projects) {
    if (!p.moneybird_project_id) continue;
    try {
      const n = await syncProject(p);
      total += n;
    } catch (err) {
      console.error(`Sync mislukt voor project ${p.id}: ${err.message}`);
    }
  }
  // Deadline-alerts voor alle projecten met deadline
  let deadlineAlerts = [];
  try { deadlineAlerts = await checkAllDeadlines(); }
  catch (err) { console.error('Deadline check faalde:', err.message); }
  // Periodieke rapportage
  let report = null;
  try { report = await maybeSendScheduledReport(); }
  catch (err) { console.error('Rapportage mislukt:', err.message); }
  return { totalEntries: total, projects: projects.length, deadlineAlerts, report };
}
