// Vervangt login.js, logout.js, me.js (3 -> 1 serverless function).
// Vercel mapt /api/auth/login, /api/auth/logout, /api/auth/me automatisch
// naar dit bestand met req.query.action ∈ {login, logout, me}.
import { getUserByEmail } from '../../lib/db.js';
import {
  verifyPassword,
  login,
  logout,
  currentUser,
  ensureInitialAdmin,
} from '../../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action;

  if (action === 'login') {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    await ensureInitialAdmin();
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
      return;
    }
    const user = await getUserByEmail(email);
    if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
      res.status(401).json({ error: 'Onjuiste inloggegevens' });
      return;
    }
    await login(res, user);
    res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
    return;
  }

  if (action === 'logout') {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    await logout(req, res);
    res.status(200).json({ ok: true });
    return;
  }

  if (action === 'me') {
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'Niet ingelogd' });
      return;
    }
    res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
    return;
  }

  res.status(404).json({ error: 'Unknown action' });
}
