// Gedeeld frontend-script: auth-check, helpers, topbar render, toasts.

export async function apiGet(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('not authenticated'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

export async function apiSend(url, method, body, isMultipart = false) {
  const init = { method, credentials: 'same-origin' };
  if (isMultipart) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('not authenticated'); }
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function percentageBadgeClass(pct) {
  if (pct >= 100) return 'badge-red';
  if (pct >= 80) return 'badge-orange';
  return 'badge-green';
}
export function progressBarClass(pct) {
  if (pct >= 100) return 'red';
  if (pct >= 80) return 'orange';
  return 'green';
}

export const STATUS_OPTIONS = [
  { value: 'in_progress', label: 'In progress' },
  { value: 'on_hold',     label: 'On hold' },
  { value: 'done',        label: 'Done' },
  { value: 'future',      label: 'Future' },
];

export function statusLabel(value) {
  const opt = STATUS_OPTIONS.find((o) => o.value === value);
  return opt ? opt.label : value;
}

export const MODULE_OPTIONS = ['PowerImprove', 'PowerClass', 'PowerText', 'PowerImage', 'PowerRelate', 'Project'];

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${d}-${m}-${y}`;
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });
}

export function daysFromNow(iso) {
  if (!iso) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

export function deadlineBadge(iso) {
  const d = daysFromNow(iso);
  if (d === null) return '';
  if (d < 0) return `<span class="badge badge-red" title="Deadline verlopen">⚠ ${fmtDate(iso)} (${-d}d over)</span>`;
  if (d <= 7) return `<span class="badge badge-red">⏰ ${fmtDate(iso)} (${d}d)</span>`;
  if (d <= 21) return `<span class="badge badge-orange">⏰ ${fmtDate(iso)} (${d}d)</span>`;
  return `<span class="badge badge-blue">${fmtDate(iso)} (${d}d)</span>`;
}

// Europese euro-notatie zonder decimalen: € 14.500
export function fmtEuro(amount) {
  const rounded = Math.round(Number(amount) || 0);
  return '€' + rounded.toLocaleString('nl-NL', { maximumFractionDigits: 0 });
}

const ACTION_LABELS = {
  created: 'Project aangemaakt',
  name_changed: 'Naam gewijzigd',
  status_changed: 'Status gewijzigd',
  available_hours_changed: 'Beschikbare uren aangepast',
  hourly_rate_changed: 'Uurtarief aangepast',
  module_changed: 'Module gewijzigd',
  modules_changed: 'Modules gewijzigd',
  manager_changed: 'Projectmanager gewijzigd',
  deadline_changed: 'Deadline gewijzigd',
  start_date_changed: 'Startdatum gewijzigd',
  client_changed: 'Klant gewijzigd',
  poc_changed: 'POC-status gewijzigd',
  feature_requests_changed: 'Feature requests bijgewerkt',
  team_added: 'Teamlid toegevoegd',
  team_removed: 'Teamlid verwijderd',
  note_added: 'Notitie toegevoegd',
  note_deleted: 'Notitie verwijderd',
  pdf_deleted: 'Offerte-PDF verwijderd',
  pdf_uploaded: 'Offerte-PDF geüpload',
};

export function activityDescription(entry) {
  const label = ACTION_LABELS[entry.action] || entry.action;
  const d = entry.details || {};
  if (entry.action === 'status_changed') return `${label}: ${statusLabel(d.from)} → ${statusLabel(d.to)}`;
  if (entry.action === 'available_hours_changed' || entry.action === 'hourly_rate_changed') return `${label}: ${d.from} → ${d.to}`;
  if (entry.action === 'name_changed') return `${label}: "${d.from || '—'}" → "${d.to || '—'}"`;
  if (entry.action === 'module_changed') return `${label}: "${d.from || '—'}" → "${d.to || '—'}"`;
  if (entry.action === 'modules_changed') {
    const f = Array.isArray(d.from) ? d.from.join(', ') : '—';
    const t = Array.isArray(d.to) ? d.to.join(', ') : '—';
    return `${label}: ${f || '—'} → ${t || '—'}`;
  }
  if (entry.action === 'deadline_changed' || entry.action === 'start_date_changed') {
    return `${label}: ${d.from ? fmtDate(d.from) : '—'} → ${d.to ? fmtDate(d.to) : '—'}`;
  }
  if (entry.action === 'team_added' || entry.action === 'team_removed') return `${label}: ${d.name || ''}`;
  if (entry.action === 'poc_changed') return `${label}: ${d.to ? 'Ja' : 'Nee'}`;
  if (entry.action === 'pdf_uploaded') return `${label}: ${d.filename || ''}`;
  return label;
}

export async function renderTopbar(activePath) {
  const me = await apiGet('/api/auth/me').catch(() => null);
  if (!me) return null;
  const isAdmin = me.user.role === 'admin';
  const links = [
    { href: '/dashboard.html', label: 'Dashboard' },
    { href: '/projects.html', label: 'Projecten' },
    { href: '/planning.html', label: 'Planning' },
    { href: '/clients.html', label: 'Klanten' },
  ];
  if (isAdmin) links.push({ href: '/admin-settings.html', label: 'Instellingen' });
  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.innerHTML = `
      <div class="brand">
        <a href="/dashboard.html">
          <span class="brand-mark"></span>
          <span>Projectmanager</span>
        </a>
      </div>
      <nav class="nav">
        ${links.map((l) => `<a href="${l.href}" class="${activePath === l.href ? 'active' : ''}">${l.label}</a>`).join('')}
      </nav>
      <div class="user-info">
        <span>${escapeHtml(me.user.name)} (${me.user.role})</span>
        <button class="btn btn-ghost" id="logoutBtn">Uitloggen</button>
      </div>`;
    document.getElementById('logoutBtn').onclick = async () => {
      await apiSend('/api/auth/logout', 'POST');
      location.href = '/login.html';
    };
  }
  return me.user;
}
