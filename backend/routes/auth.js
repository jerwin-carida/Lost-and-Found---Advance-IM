import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pools } from '../db.js';
import { HttpError } from '../util.js';
import { signToken, readUser } from '../auth.js';

const r = Router();
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // keeps timing similar for unknown names

r.post('/login', async (req, res) => {
  const { name, password } = req.body ?? {};
  if (!name || !password) throw new HttpError(400, 'Enter your name and password.');

  // Login has to read users before the role is known, so this one query uses the admin pool.
  const { rows } = await pools.admin.query(
    `SELECT u.userId, u.name, u.password_hash, r.userRole
     FROM users u JOIN roles r ON r.roleId = u.roleId WHERE u.name = $1`, [String(name)]);
  const u = rows[0];
  const ok = await bcrypt.compare(String(password), u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok) throw new HttpError(401, 'Wrong name or password.');

  const user = { userId: u.userid, name: u.name, role: u.userrole };
  res.cookie('token', signToken(user), { httpOnly: true, sameSite: 'strict', maxAge: 8 * 3600 * 1000 });
  res.json({ role: user.role });
});

r.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out.' });
});

r.get('/me', (req, res) => {
  const u = readUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in.' });
  res.json({ userId: u.userId, name: u.name, role: u.role });
});

export default r;
