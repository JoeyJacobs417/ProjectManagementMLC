// Gedeeld frontend-script: auth-check, helpers, topbar render, toasts.

export async function apiGet(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (r.status === 401) {
    location.href = '/login.html';
    throw new Error('not authenticated');
  }
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
  if (r.status === 401) {
    location.href = '/login.html';
    throw new Error('not authenticated');
  }
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

export async function renderTopbar(activePath) {
  const me = await apiGet('/api/auth/me').catch(() => null);
  if (!me) return null;
  const isAdmin = me.user.role === 'admin';
  const links = [
    { href: '/dashboard.html', label: 'Dashboard' },
    { href: '/projects.html', label: 'Projecten' },
    { href: '/new-project.html', label: 'Nieuw project' },
  ];
  if (isAdmin) {
    links.push({ href: '/admin-settings.html', label: 'Instellingen' });
  }
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
