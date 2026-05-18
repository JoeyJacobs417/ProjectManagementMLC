// GET  /api/admin/users    - lijst gebruikers
// POST /api/admin/users    - nieuwe gebruiker
import { requireAdmin, hashPassword, newId, ROLE_ADMIN, ROLE_PM } from '../../lib/auth.js';
import { listUsers, saveUser, getUserByEmail } from '../../lib/db.js';

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const users = await listUsers();
    res.status(200).json({
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        active: u.active,
      })),
    });
    return;
  }

  if (req.method === 'POST') {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) {
      res.status(400).json({ error: 'name, email en password verplicht' });
      return;
    }
    if (await getUserByEmail(email)) {
      res.status(409).json({ error: 'E-mail bestaat al' });
      return;
    }
    const user = {
      id: newId('u_'),
      email: String(email).toLowerCase(),
      name: String(name),
      role: role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_PM,
      active: true,
      password_hash: await hashPassword(password),
      created_at: new Date().toISOString(),
    };
    await saveUser(user);
    res.status(201).json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, active: true },
    });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
