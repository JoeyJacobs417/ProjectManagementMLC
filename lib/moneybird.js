// Moneybird REST API client. Docs: https://developer.moneybird.com/api/
const API = 'https://moneybird.com/api/v2';

function headers() {
  const token = process.env.MONEYBIRD_API_TOKEN;
  if (!token) throw new Error('MONEYBIRD_API_TOKEN ontbreekt');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function adm() {
  const a = process.env.MONEYBIRD_ADMINISTRATION_ID;
  if (!a) throw new Error('MONEYBIRD_ADMINISTRATION_ID ontbreekt');
  return a;
}

async function getJSON(path, params = {}) {
  const url = new URL(`${API}/${adm()}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  // Moneybird rate-limit (429) en tijdelijke serverfouten: een paar keer opnieuw proberen
  // met oplopende wachttijd. Zonder retry faalde een volledige project-sync bij de eerste 429.
  const RETRY_STATUS = new Set([429, 502, 503, 504]);
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { headers: headers() });
    if (r.ok) return r.json();
    if (RETRY_STATUS.has(r.status) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(r.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30000)
        : Math.min(2000 * 2 ** (attempt - 1), 20000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    const text = await r.text();
    throw new Error(`Moneybird ${r.status}: ${text}`);
  }
}

export async function fetchProjects() {
  const out = [];
  let page = 1;
  while (true) {
    const data = await getJSON('/projects.json', { page, per_page: 100 });
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return out;
}

export async function fetchUsers() {
  return getJSON('/users.json');
}

export async function fetchTimeEntries(projectId, extraFilter) {
  const out = [];
  let page = 1;
  while (true) {
    const params = { page, per_page: 100 };
    const filters = [];
    if (projectId) filters.push(`project_id:${projectId}`);
    if (extraFilter) filters.push(extraFilter);
    if (filters.length) params.filter = filters.join(',');
    const data = await getJSON('/time_entries.json', params);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return out;
}

export async function fetchAllTimeEntriesWithFilter(filterStr) {
  const out = [];
  let page = 1;
  while (true) {
    const params = { page, per_page: 100 };
    if (filterStr) params.filter = filterStr;
    const data = await getJSON('/time_entries.json', params);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return out;
}

// Netto uren zoals Moneybird ze toont: einde − start − pauze (paused_duration, in seconden).
function hoursBetween(start, end, pausedSeconds = 0) {
  if (!start || !end) return 0;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms) || ms <= 0) return 0;
  const paused = Math.max(0, Number(pausedSeconds) || 0) * 1000;
  const net = Math.max(0, ms - paused);
  return Math.round((net / 3_600_000) * 100) / 100;
}

export function normalizeTimeEntry(e) {
  return {
    moneybird_id: String(e.id),
    user_name: e.user?.name || null,
    // Nested user.id — meestal de "globale" Moneybird User-id die in time entries voorkomt.
    user_moneybird_id: e.user?.id ? String(e.user.id) : null,
    // Top-level user_id van het time-entry-record. Kan in sommige administraties
    // verschillen van user.id (en is dan de id die Moneybird's user_id-filter accepteert).
    user_top_id: e.user_id ? String(e.user_id) : null,
    moneybird_project_id: e.project?.id ? String(e.project.id) : null,
    moneybird_project_name: e.project?.name || null,
    started_at: e.started_at || null,
    ended_at: e.ended_at || null,
    hours: hoursBetween(e.started_at, e.ended_at, e.paused_duration),
    paused_seconds: Number(e.paused_duration) || 0,
    description: e.description || '',
    billable: e.billable !== false,
  };
}
