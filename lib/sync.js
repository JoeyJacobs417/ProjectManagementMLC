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
  // De uren zijn hierboven al opgeslagen; een fout in de meldingen mag de sync niet laten mislukken.
  try {
    await checkAndNotify(project);
    await checkInactivityAlerts(project, oldEntries, normalized);
  } catch (err) {
    console.error(`Meldingen mislukt voor project ${project.id}: ${err.message}`);
  }
  return normalized.length;
}

function isoNDaysAgo(n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Pre-warm Redis incrementeel:
// - Elke cron-run halen we de laatste 7 dagen op (kern-venster) PLUS één roulerende "achterstand-week"
//   uit de oudere historie. Zo komen uren die pas later dan 7 dagen na de werkdag zijn ingeschreven
//   (of achteraf zijn aangepast) toch binnen: elke dag in de retentie wordt zo binnen ~8 nachten
//   opnieuw gecontroleerd.
// - We mergen dat met wat al in de cache zit (de rest blijft staan).
// - Entries ouder dan 60 dagen worden gepruned.
// - Resultaat: na ~9 cron-runs heb je 60 dagen historie in cache zonder ooit een grote
//   Moneybird-call te hoeven doen die kan time-outen.
const REFRESH_WINDOW_DAYS = 7;
const RETENTION_DAYS = 60;
// Versie van de manier waarop `hours` is berekend. v2 = netto (pauzes afgetrokken).
// Een cache zonder deze versie bevat bruto uren en wordt niet hergebruikt.
const HOURS_VERSION = 2;

function isoToCompact(iso) { return iso.replace(/-/g, ''); }

export async function refreshRecentMoneybirdEntries() {
  const refreshSince = isoNDaysAgo(REFRESH_WINDOW_DAYS);
  const cutoffIso = isoNDaysAgo(RETENTION_DAYS);
  const todayIso = isoNDaysAgo(0);

  // Roulerende achterstand-week: dagen 8..RETENTION_DAYS terug, in blokken van 7 dagen.
  const olderDays = RETENTION_DAYS - REFRESH_WINDOW_DAYS; // dagen na het kern-venster
  const nSlices = Math.max(1, Math.ceil(olderDays / 7));
  const sliceIdx = Math.floor(Date.now() / 86400000) % nSlices;
  const sliceFrom = isoNDaysAgo(Math.min(RETENTION_DAYS, REFRESH_WINDOW_DAYS + 7 * (sliceIdx + 1)));
  const sliceTo = isoNDaysAgo(REFRESH_WINDOW_DAYS + 7 * sliceIdx + 1);

  // 1) Kern-venster (7 dagen) uit Moneybird via de period-filter (YYYYMMDD..YYYYMMDD).
  //    LET OP: 'started_after' is GEEN geldige Moneybird-filter — die werd genegeerd waardoor
  //    de héle historie werd opgehaald en de cron timeoutte. De period-filter begrenst wél.
  const raw = await fetchAllTimeEntriesWithFilter(`period:${isoToCompact(refreshSince)}..${isoToCompact(todayIso)}`);
  const inCore = (day) => day >= refreshSince;
  const fresh = raw
    .map(normalizeTimeEntry)
    .filter((e) => e.started_at && inCore(String(e.started_at).slice(0, 10)));

  // 1b) Achterstand-week. Mag mislukken zonder het kern-venster te laten sneuvelen.
  let sliceOk = false;
  let sliceFresh = [];
  try {
    const rawSlice = await fetchAllTimeEntriesWithFilter(`period:${isoToCompact(sliceFrom)}..${isoToCompact(sliceTo)}`);
    sliceFresh = rawSlice
      .map(normalizeTimeEntry)
      .filter((e) => {
        if (!e.started_at) return false;
        const d = String(e.started_at).slice(0, 10);
        return d >= sliceFrom && d <= sliceTo;
      });
    sliceOk = true;
  } catch (err) {
    console.error('Refresh achterstand-week faalde:', err.message);
  }
  const inSlice = (day) => sliceOk && day >= sliceFrom && day <= sliceTo;

  // 2) Bestaande cache laden. Alleen hergebruiken als de uren op dezelfde manier zijn berekend.
  //    Oude entries behouden (binnen retention en buiten de zojuist opgehaalde dagen).
  const existing = await getRecentMoneybirdEntries();
  const existingValid = existing && existing.hours_version === HOURS_VERSION;
  const olderKept = (existingValid && Array.isArray(existing.time_entries) ? existing.time_entries : [])
    .filter((e) => {
      if (!e.started_at) return false;
      const day = String(e.started_at).slice(0, 10);
      return day >= cutoffIso && !inCore(day) && !inSlice(day);
    });

  // 3) Mergen, dedupliceren op moneybird_id (voor de zekerheid).
  const seen = new Set();
  const merged = [];
  for (const e of [...fresh, ...sliceFresh, ...olderKept]) {
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
  if (sliceOk && sliceFrom < effectiveSince) effectiveSince = sliceFrom;

  const payload = {
    time_entries: merged,
    since: effectiveSince,
    cached_at: new Date().toISOString(),
    last_refresh_window_since: refreshSince,
    last_slice: sliceOk ? { from: sliceFrom, to: sliceTo } : null,
    retention_days: RETENTION_DAYS,
    hours_version: HOURS_VERSION,
  };
  await setRecentMoneybirdEntries(payload);
  return { count: merged.length, fresh: fresh.length, slice: sliceOk ? { from: sliceFrom, to: sliceTo, entries: sliceFresh.length } : null, kept_old: olderKept.length, since: effectiveSince };
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
  const existingRaw = await getRecentMoneybirdEntries();
  // Cache met bruto uren (zonder versie) niet hergebruiken: dan zouden oude en nieuwe berekening door elkaar lopen.
  const existing = existingRaw && existingRaw.hours_version === HOURS_VERSION ? existingRaw : null;
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
    hours_version: HOURS_VERSION,
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

  // Oudst gesynchroniseerde (of nog nooit gesynchroniseerde) projecten eerst, zodat projecten
  // achteraan de lijst niet blijven uitgehongerd als een run niet alles haalt. Met een tijdsbudget
  // stopt de run netjes; de rest komt de volgende keer als eerste aan de beurt.
  const projects = (await listProjects())
    .filter((p) => p.moneybird_project_id)
    .sort((a, b) => String(a.last_synced_at || '').localeCompare(String(b.last_synced_at || '')));
  const budgetMs = Number(process.env.SYNC_BUDGET_MS) || 50000;
  const startedAt = Date.now();
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];
  for (const p of projects) {
    if (Date.now() - startedAt > budgetMs) { skipped++; continue; }
    try {
      const n = await syncProject(p);
      total += n;
      succeeded++;
    } catch (err) {
      console.error(`Sync mislukt voor project ${p.id} (${p.name}): ${err.message}`);
      errors.push({ project: p.name, error: String(err.message).slice(0, 200) });
      failed++;
    }
  }
  let deadlineAlerts = [];
  try { deadlineAlerts = await checkAllDeadlines(); }
  catch (err) { console.error('Deadline check faalde:', err.message); }
  return { totalEntries: total, projects: projects.length, succeeded, failed, skipped, errors, recentMb, recentMbError, deadlineAlerts, report };
}
