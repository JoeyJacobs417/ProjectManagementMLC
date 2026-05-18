import { getUserByEmail } from '../../lib/db.js';
import { verifyPassword, login, ensureInitialAdmin } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // Eerste keer: maak admin uit env aan als er nog geen is
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
}
