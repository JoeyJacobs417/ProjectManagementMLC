// Gedeelde berekening van "Reeds omgezet" (gebruikt door Dashboard en Omzet-pagina),
// zodat beide pagina's altijd exact dezelfde cijfers tonen.
import { apiGet } from '/app.js';

// Haalt de projecten op met de time entries van de gekozen maand en corrigeert die met de
// Moneybird-cache (die wordt betrouwbaarder ververst dan de dagelijkse project-sync).
export async function loadProjectsForMonth(monthIso) {
  const r = await apiGet(`/api/projects?with_time_entries=1&time_entries_in_month=${encodeURIComponent(monthIso)}`);
  const projectsList = r.projects;
  try {
    const monthStart = `${monthIso}-01`;
    const cacheResp = await apiGet(`/api/moneybird/time_entries?since=${encodeURIComponent(monthStart)}`);
    const covered = !cacheResp.coverage_since || cacheResp.coverage_since <= monthStart;
    if (covered && Array.isArray(cacheResp.time_entries)) {
      const byMb = new Map();
      for (const e of cacheResp.time_entries) {
        if (!e.moneybird_project_id || !String(e.started_at || '').startsWith(monthIso)) continue;
        const k = String(e.moneybird_project_id);
        if (!byMb.has(k)) byMb.set(k, []);
        byMb.get(k).push(e);
      }
      for (const p of projectsList) {
        if (!p.moneybird_project_id) continue;
        const fresh = byMb.get(String(p.moneybird_project_id)) || [];
        const storedHours = (p.time_entries || []).reduce((a, e) => a + (Number(e.hours) || 0), 0);
        const freshHours = fresh.reduce((a, e) => a + (Number(e.hours) || 0), 0);
        p.time_entries = fresh;
        p.hours_used = Math.max(0, (Number(p.hours_used) || 0) + (freshHours - storedHours));
      }
    }
  } catch (err) { /* cache niet beschikbaar: terugvallen op de opgeslagen uren per project */ }
  return projectsList;
}

// Per medewerker: totaal (hours, revenue) + de regels per project waaruit dat is opgebouwd.
// Regels: { project_id, project_name, rate, hourly_billing, written, counted, revenue, note }
//  - written = geschreven uren in de maand (t/m vandaag), counted = uren die meetellen als omzet.
// Cap: voor niet-uurtje-factuurtje projecten stoppen we bij available_hours (uren van eerdere
// maanden tellen mee in het verbruik); bij uurtje-factuurtje tellen alle uren.
// Projecten zonder uurtarief leveren regels met revenue 0 op (uitsluitend ter uitleg).
export function computeRealizedBreakdown(projects, monthIso, todayIso) {
  const out = new Map();
  const rec = (id) => {
    if (!out.has(id)) out.set(id, { hours: 0, revenue: 0, lines: [] });
    return out.get(id);
  };
  for (const p of projects) {
    const rate = Number(p.hourly_rate) || 0;
    const entries = (p.time_entries || []).filter((e) => {
      if (!e.started_at) return false;
      const day = String(e.started_at).slice(0, 10);
      return day.startsWith(monthIso) && day <= todayIso;
    });
    if (entries.length === 0) continue;
    const hoursInMonth = entries.reduce((a, e) => a + (Number(e.hours) || 0), 0);
    if (hoursInMonth <= 0) continue;

    const byMember = new Map();
    const names = new Map();
    for (const e of entries) {
      if (!e.user_moneybird_id) continue;
      byMember.set(e.user_moneybird_id, (byMember.get(e.user_moneybird_id) || 0) + (Number(e.hours) || 0));
      if (e.user_name) names.set(e.user_moneybird_id, e.user_name);
    }

    let declarableInMonth = 0;
    let note = '';
    if (rate <= 0) {
      note = 'Geen uurtarief — telt niet mee';
    } else if (p.is_hourly_billing) {
      declarableInMonth = hoursInMonth;
      note = 'Uurtje-factuurtje — alle uren tellen';
    } else {
      // Uren vóór deze maand: van de server (klopt ook voor eerdere maanden); anders afgeleid
      // uit het totaal-verbruik (alleen juist voor de lopende maand).
      const hoursBefore = Number.isFinite(p.hours_before_month)
        ? p.hours_before_month
        : Math.max(0, (Number(p.hours_used) || 0) - hoursInMonth);
      const available = Number(p.available_hours) || 0;
      const cap = Math.max(0, available - hoursBefore);
      declarableInMonth = Math.min(cap, hoursInMonth);
      if (declarableInMonth <= 0) note = `Budget al op (${available} u beschikbaar) — telt niet mee`;
      else if (declarableInMonth < hoursInMonth) note = `Gecapped op budget (${available} u beschikbaar)`;
    }

    for (const [memberId, memberHours] of byMember) {
      const counted = (memberHours / hoursInMonth) * declarableInMonth;
      const r = rec(memberId);
      if (names.has(memberId) && !r.name) r.name = names.get(memberId);
      r.hours += counted;
      r.revenue += counted * rate;
      r.lines.push({
        project_id: p.id, project_name: p.name, rate,
        hourly_billing: !!p.is_hourly_billing,
        written: memberHours, counted, revenue: counted * rate, note,
      });
    }
  }
  return out;
}
