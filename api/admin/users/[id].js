// PATCH /api/admin/users/:id
//   body: { action: "toggle" }              - activeer/deactiveer
//   body: { action: "reset", password }     - reset wachtwoord
//   body: { action: "rename", name }        - hernoem
import { requireAdmin, hashPassword } from '../../../lib/auth.js';
import { getUserById, saveUser } from '../../../lib/db.js';

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (req.method !== 'PATCH') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const user = await getUserById(req.query.id);
  if (!user) {
    res.status(404).json({ error: 'Niet gevonden' });
    return;
  }
  const { action, password, name } = req.body || {};

  if (action === 'toggle') {
    if (user.id === admin.id) {
      res.status(400).json({ error: 'Je kunt je eigen account niet uitschakelen' });
      return;
    }
    user.active = !user.active;
    await saveUser(user);
    res.status(200).json({ ok: true, active: user.active });
    return;
  }

  if (action === 'reset') {
    if (!password) {
      res.status(400).json({ error: 'password ontbreekt' });
      return;
    }
    user.password_hash = await hashPassword(password);
    await saveUser(user);
    res.status(200).json({ ok: true });
    return;
  }

  if (action === 'rename') {
    const newName = String(name || '').trim();
    if (!newName) {
      res.status(400).json({ error: 'name ontbreekt' });
      return;
    }
    user.name = newName;
    await saveUser(user);
    res.status(200).json({ ok: true, name: user.name });
    return;
  }

  res.status(400).json({ error: 'Onbekende actie' });
}
