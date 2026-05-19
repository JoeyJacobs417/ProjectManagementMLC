// Hoge-niveau sync: haalt time entries op uit Moneybird + checkt drempels
// + verstuurt eventueel de periodieke rapportage.
import { fetchTimeEntries, normalizeTimeEntry } from './moneybird.js';
import { listProjects, listTimeEntries, replaceTimeEntries } from './db.js';
import { checkAndNotify, checkInactivityAlerts, maybeSendScheduledReport } from './notify.js';

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
  // Na alle syncs: check of er een periodieke rapportage uit moet
  let report = null;
  try {
    report = await maybeSendScheduledReport();
  } catch (err) {
    console.error('Rapportage mislukt:', err.message);
  }
  return { totalEntries: total, projects: projects.length, report };
}
