import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config, ROOT } from './config.js';
import { pools, explainDbError } from './db.js';
import { pageGate } from './auth.js';
import { HttpError } from './util.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import staffRoutes from './routes/staff.js';

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// ---------- API ----------
app.use('/api/auth', authRoutes);
app.use('/api/staff', staffRoutes);   // staff-only (checked inside the router)
app.use('/api', publicRoutes);        // no login: GET /items, POST /claim-requests
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------- Pages ----------
const frontend = path.join(ROOT, 'frontend');
app.get('/staff', pageGate('admin', 'moderator'), (req, res) =>
  res.sendFile(path.join(frontend, 'pages', 'staff.html')));   // never in the static folder
app.get('/login', (req, res) => res.sendFile(path.join(frontend, 'public', 'login.html')));
app.use(express.static(path.join(frontend, 'public')));

// ---------- Errors ----------
app.use((err, req, res, next) => {
  const dbMessages = {
    '42501': [403, 'The database role behind this account is not allowed to do that.'],
    '23503': [409, 'Other records still point to this one.'],
    '23505': [409, 'That value is already taken.'],
  };
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: 'Bad request.' });
  if (dbMessages[err.code]) return res.status(dbMessages[err.code][0]).json({ error: dbMessages[err.code][1] });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

try {
  await pools.public.query('SELECT 1 FROM items LIMIT 1');
  await pools.admin.query('SELECT 1 FROM users LIMIT 1');
} catch (e) {
  console.error(`Database is not ready: ${explainDbError(e)}`);
  process.exit(1);
}

// 127.0.0.1 = this computer only; nothing else on your network can reach it.
app.listen(config.port, '0.0.0.0', () =>
  console.log(`Lost and Found running at http://localhost:${config.port}`));
