// PATCH /api/admin/users/:id
//   { action: "toggle" }                  - activeer/deactiveer
//   { action: "reset", password }         - wachtwoord resetten
//   { action: "rename", name }             - naam wijzigen
//   { action: "change_role", role }        - rol wijzigen (admin <-> projectmanager)
import { requireAdmin, hashPassword, ROLE_ADMIN, ROLE_PM } from '../../../lib/auth.js';
import { getUserById, saveUser, listUsers } from '../../../lib/db.js';

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
  const { action, password, name, role } = req.body || {};

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

  if (action === 'change_role') {
    const newRole = String(role || '').trim();
    if (newRole !== ROLE_ADMIN && newRole !== ROLE_PM) {
      res.status(400).json({ error: 'Ongeldige rol' });
      return;
    }
    if (user.role === newRole) {
      res.status(200).json({ ok: true, role: user.role, unchanged: true });
      return;
    }
    // Veiligheidscheck: minstens één actieve admin moeten blijven
    if (user.role === ROLE_ADMIN && newRole === ROLE_PM) {
      const all = await listUsers();
      const otherActiveAdmins = all.filter(
        (u) => u.id !== user.id && u.role === ROLE_ADMIN && u.active
      );
      if (otherActiveAdmins.length === 0) {
        res.status(400).json({
          error: 'Deze gebruiker is de enige actieve admin — maak eerst iemand anders admin.',
        });
        return;
      }
      if (user.id === admin.id) {
        res.status(400).json({ error: 'Je kunt jezelf niet downgraden naar projectmanager' });
        return;
      }
    }
    user.role = newRole;
    await saveUser(user);
    res.status(200).json({ ok: true, role: user.role });
    return;
  }

  res.status(400).json({ error: 'Onbekende actie' });
}
