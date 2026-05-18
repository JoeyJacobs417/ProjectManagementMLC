import { currentUser } from '../../lib/auth.js';

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Niet ingelogd' });
    return;
  }
  res.status(200).json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
}
