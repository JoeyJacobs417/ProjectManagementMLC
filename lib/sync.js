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
  const todayIso = isoNDaysAgo(0);

  // 1) Klein 7-daags venster ophalen uit Moneybird via de period-filter (YYYYMMDD..YYYYMMDD).
  //    LET OP: 'started_after' is GEEN geldige Moneybird-filter — die werd genegeerd waardoor
  //    de héle historie werd opgehaald en de cron timeoutte. De period-filter begrenst wél.
  const raw = await fetchAllTimeEntriesWithFilter(`period:${refreshSince.replace(/-/g, '')}..${todayIso.replace(/-/g, '')}`);
  const fresh = raw
    .map(normalizeTimeEntry)
    .filter((e) => e.started_at && String(e.started_at).slice(0, 10) >= refreshSince);

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

// Vult de bulk-cache voor één specifieke dag. Gebruikt Moneybird's period-filter
// (YYYYMMDD..YYYYMMDD) — de correcte manier om op datum te filteren. Eén dag is heel
// klein, dus deze call kan nooit time-outen. Door dit per dag aan te roepen (vanaf de
// medewerker-pagina) bouw je de volledige periode op, inclusief uren op ongekoppelde
// Moneybird-projecten.
export async function warmMoneybirdDay(dayIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayIso || ''))) {
    throw new Error('Ongeldige dag (verwacht YYYY-MM-DD)');
  }
  const day = String(dayIso);
  const compact = day.replace(/-/g, '');
  const cutoffIso = isoNDaysAgo(RETENTION_DAYS);

  // Alleen die ene dag ophalen via de period-filter.
  const raw = await fetchAllTimeEntriesWithFilter(`period:${compact}..${compact}`);
  const fresh = raw
    .map(normalizeTimeEntry)
    .filter((e) => e.started_at && String(e.started_at).slice(0, 10) === day);

  // Bestaande cache: behoud entries van andere dagen (binnen retention), vervang deze dag.
  const existing = await getRecentMoneybirdEntries();
  const kept = (existing && Array.isArray(existing.time_entries) ? existing.time_entries : [])
    .filter((e) => {
      if (!e.started_at) return false;
      const d = String(e.started_at).slice(0, 10);
      if (d < cutoffIso) return false;
      return d !== day;
    });

  const seen = new Set();
  const merged = [];
  for (const e of [...fresh, ...kept]) {
    const id = String(e.moneybird_id || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.push(e);
  }

  // Coverage bijhouden op basis van wat we hebben opgehaald (niet alleen waar entries staan):
  // de oudste van (deze dag, bestaande coverage), geclampt op de retention-grens.
  let effectiveSince = day;
  if (existing && existing.since && existing.since < effectiveSince) effectiveSince = existing.since;
  if (effectiveSince < cutoffIso) effectiveSince = cutoffIso;

  const payload = {
    time_entries: merged,
    since: effectiveSince,
    cached_at: new Date().toISOString(),
    retention_days: RETENTION_DAYS,
  };
  await setRecentMoneybirdEntries(payload);
  return { count: merged.length, fresh: fresh.length, day, since: effectiveSince };
}

export async function syncAllProjects() {
  // Periodieke rapportage ALS EERSTE — vóór de zware project-sync. Anders kan een trage
  // sync de 60s-functielimiet opsouperen waardoor de mail (voorheen de laatste stap)
  // nooit verstuurd werd. De rapportage leest uit Redis en heeft de verse sync niet nodig;
  // de cijfers zijn die van de vorige run (max ~1 dag oud), prima voor een periodieke mail.
  let report = null;
  try { report = await maybeSendScheduledReport(); }
  catch (err) { console.error('Rapportage mislukt:', err.message); }

  // Pre-warm cache (kleinste taak, mag niet sneuvelen door project-sync timeouts).
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
  return { totalEntries: total, projects: projects.length, succeeded, failed, recentMb, recentMbError, deadlineAlerts, report };
}
