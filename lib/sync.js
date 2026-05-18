// Hoge-niveau sync: haalt time entries voor één project of alle projecten op uit Moneybird.
import { fetchTimeEntries, normalizeTimeEntry } from './moneybird.js';
import { listProjects, replaceTimeEntries } from './db.js';
import { checkAndNotify } from './notify.js';

export async function syncProject(project) {
  if (!project.moneybird_project_id) return 0;
  const raw = await fetchTimeEntries(project.moneybird_project_id);
  const normalized = raw.map(normalizeTimeEntry);
  await replaceTimeEntries(project.id, normalized);
  await checkAndNotify(project);
  return normalized.length;
}

export async function syncAllProjects() {
  const projects = await listProjects();
  let total = 0;
  const notified = [];
  for (const p of projects) {
    if (!p.moneybird_project_id) continue;
    try {
      const n = await syncProject(p);
      total += n;
    } catch (err) {
      console.error(`Sync mislukt voor project ${p.id}: ${err.message}`);
    }
  }
  return { totalEntries: total, projects: projects.length };
}
