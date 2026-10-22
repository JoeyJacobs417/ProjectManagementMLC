// Vergrendeling van de planning: vanaf zaterdag springt de planning door naar de volgende week
// en is de afgelopen week (en alles daarvoor) alleen nog inzichtelijk, niet meer aanpasbaar.

// Maandag (YYYY-MM-DD) van de "planningsweek": ma t/m vr = maandag van deze week,
// za/zo = maandag van de volgende week. Berekend in tijdzone Europe/Amsterdam.
export function planningMondayIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[get('weekday')];
  const base = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')));
  const offset = dow === 6 ? 2 : dow === 0 ? 1 : -(dow - 1);
  return new Date(base + offset * 86400000).toISOString().slice(0, 10);
}

// Weken vóór de planningsweek zijn vergrendeld: bestaande waarden blijven staan,
// wijzigingen daarin worden genegeerd. Weken vanaf de planningsweek komen uit `next`.
export function mergeLockedAllocations(existing, next, lockBefore = planningMondayIso()) {
  const kept = (Array.isArray(existing) ? existing : []).filter((a) => a && a.week_start < lockBefore);
  const fresh = (Array.isArray(next) ? next : []).filter((a) => a && a.week_start >= lockBefore);
  return [...kept, ...fresh];
}

// Zelfde voor 'Overig' per medewerker: { empId: { 'YYYY-MM-DD': { hours, note } } }
export function mergeLockedOverig(existing, next, lockBefore = planningMondayIso()) {
  const out = {};
  const add = (empId, week, val) => {
    if (!out[empId]) out[empId] = {};
    out[empId][week] = val;
  };
  for (const [empId, weeks] of Object.entries(existing || {})) {
    for (const [week, val] of Object.entries(weeks || {})) if (week < lockBefore) add(empId, week, val);
  }
  for (const [empId, weeks] of Object.entries(next || {})) {
    for (const [week, val] of Object.entries(weeks || {})) if (week >= lockBefore) add(empId, week, val);
  }
  return out;
}
