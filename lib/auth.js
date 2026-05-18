// Auth helpers: sessie-cookie, password hashing, ensure admin, role-guards.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  getUserByEmail,
  getUserById,
  saveUser,
  listUsers,
  createSession,
  getSession,
  deleteSession,
} from './db.js';

const COOKIE_NAME = 'pm_session';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 dagen

export const ROLE_ADMIN = 'admin';
export const ROLE_PM = 'projectmanager';

// ── password hashing ────────────────────────────────────────────────
export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

// ── cookie helpers ──────────────────────────────────────────────────
function buildCookie(token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${TTL_SECONDS}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function clearCookie() {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

// ── public API ─────────────────────────────────────────────────────
export async function login(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  await createSession(token, user.id, TTL_SECONDS);
  res.setHeader('Set-Cookie', buildCookie(token));
}

export async function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  await deleteSession(token);
  res.setHeader('Set-Cookie', clearCookie());
}

export async function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const session = await getSession(token);
  if (!session) return null;
  return getUserById(session.user_id);
}

export async function requireUser(req, res) {
  const user = await currentUser(req);
  if (!user || !user.active) {
    res.status(401).json({ error: 'Niet ingelogd' });
    return null;
  }
  return user;
}

export async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (user.role !== ROLE_ADMIN) {
    res.status(403).json({ error: 'Admin-rechten vereist' });
    return null;
  }
  return user;
}

export function newId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

// ── initiële admin ─────────────────────────────────────────────────
export async function ensureInitialAdmin() {
  const users = await listUsers();
  if (users.some((u) => u.role === ROLE_ADMIN)) return;
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const existing = await getUserByEmail(email);
  if (existing) return;
  await saveUser({
    id: newId('u_'),
    email,
    name: 'Admin',
    role: ROLE_ADMIN,
    active: true,
    password_hash: await hashPassword(password),
    created_at: new Date().toISOString(),
  });
}
