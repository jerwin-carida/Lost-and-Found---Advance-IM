import jwt from 'jsonwebtoken';
import { config } from './config.js';

export const signToken = (u) =>
  jwt.sign({ userId: u.userId, name: u.name, role: u.role }, config.jwtSecret, { expiresIn: '8h' });

export function readUser(req) {
  const token = req.cookies?.token;
  if (!token) return null;
  try { return jwt.verify(token, config.jwtSecret); } catch { return null; }
}

// API: 401 if not logged in.
export function authenticate(req, res, next) {
  const user = readUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  req.user = user;
  next();
}

// API: 403 if the role is not allowed (app-level authorization).
export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role)
    ? next()
    : res.status(403).json({ error: 'Your role is not allowed to do this.' });

// Pages: redirect to /login instead of serving the HTML.
export const pageGate = (...roles) => (req, res, next) => {
  const user = readUser(req);
  if (!user || !roles.includes(user.role)) return res.redirect('/login');
  req.user = user;
  next();
};
