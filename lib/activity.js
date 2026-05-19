// Activity log helpers — vergelijkt oude en nieuwe projectstate en bouwt log-entries.
import crypto from 'node:crypto';

export function newActivityId() {
  return 'a_' + crypto.randomBytes(6).toString('hex');
}

function entry(user, action, details = {}) {
  return {
    id: newActivityId(),
    timestamp: new Date().toISOString(),
    user_id: user?.id || null,
    user_name: user?.name || 'Onbekend',
    action,
    details,
  };
}

function teamIdSet(team) {
  return new Set((team || []).map((t) => t.moneybird_user_id));
}

export function diffProjectActivity(oldP, newP, user) {
  const out = [];
  if ((oldP.name || '') !== (newP.name || '')) {
    out.push(entry(user, 'name_changed', { from: oldP.name, to: newP.name }));
  }
  if ((oldP.status || '') !== (newP.status || '')) {
    out.push(entry(user, 'status_changed', { from: oldP.status, to: newP.status }));
  }
  if (Number(oldP.available_hours || 0) !== Number(newP.available_hours || 0)) {
    out.push(entry(user, 'available_hours_changed', {
      from: Number(oldP.available_hours || 0),
      to: Number(newP.available_hours || 0),
    }));
  }
  if (Number(oldP.hourly_rate || 0) !== Number(newP.hourly_rate || 0)) {
    out.push(entry(user, 'hourly_rate_changed', {
      from: Number(oldP.hourly_rate || 0),
      to: Number(newP.hourly_rate || 0),
    }));
  }
  if ((oldP.module || '') !== (newP.module || '')) {
    out.push(entry(user, 'module_changed', { from: oldP.module || '', to: newP.module || '' }));
  }
  if ((oldP.manager_id || '') !== (newP.manager_id || '')) {
    out.push(entry(user, 'manager_changed', { from: oldP.manager_id || '', to: newP.manager_id || '' }));
  }
  if ((oldP.deadline || '') !== (newP.deadline || '')) {
    out.push(entry(user, 'deadline_changed', { from: oldP.deadline || '', to: newP.deadline || '' }));
  }
  if ((oldP.client_id || '') !== (newP.client_id || '')) {
    out.push(entry(user, 'client_changed', { from: oldP.client_id || '', to: newP.client_id || '' }));
  }

  // Team diffs
  const oldTeam = teamIdSet(oldP.team);
  const newTeam = teamIdSet(newP.team);
  const added = (newP.team || []).filter((t) => !oldTeam.has(t.moneybird_user_id));
  const removed = (oldP.team || []).filter((t) => !newTeam.has(t.moneybird_user_id));
  for (const t of added) {
    out.push(entry(user, 'team_added', { name: t.name, moneybird_user_id: t.moneybird_user_id }));
  }
  for (const t of removed) {
    out.push(entry(user, 'team_removed', { name: t.name, moneybird_user_id: t.moneybird_user_id }));
  }

  return out;
}

export function appendActivity(project, entries) {
  if (!Array.isArray(project.activity_log)) project.activity_log = [];
  if (!entries || entries.length === 0) return;
  project.activity_log.push(...entries);
  // Houd lijst beheersbaar — max 200 entries per project
  if (project.activity_log.length > 200) {
    project.activity_log = project.activity_log.slice(-200);
  }
}

export function logActivity(project, user, action, details) {
  appendActivity(project, [entry(user, action, details)]);
}
