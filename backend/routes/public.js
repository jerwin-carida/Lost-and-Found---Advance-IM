import { Router } from 'express';
import { pools } from '../db.js';
import { encrypt } from '../crypto.js';
import { HttpError, camel, clean, int } from '../util.js';

const r = Router();

// GET /api/items?status=found&q=bottle  (no login; uses the app_public database role)
r.get('/items', async (req, res) => {
  const where = ["status <> 'claimed'", "description NOT LIKE '[seed]%'"];
  const params = [];
  if (req.query.status) {
    if (!['lost', 'found', 'forgotten'].includes(req.query.status)) throw new HttpError(400, 'Unknown status.');
    params.push(req.query.status);
    where.push(`status = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${clean(req.query.q, 100)}%`);
    where.push(`description ILIKE $${params.length}`);
  }
  const { rows } = await pools.public.query(
    `SELECT itemId, description, status, reportedAt FROM items
     WHERE ${where.join(' AND ')} ORDER BY reportedAt DESC LIMIT 200`, params);
  res.json(rows.map(camel));
});

// POST /api/claim-requests  (no login; the only table a student can write to)
r.post('/claim-requests', async (req, res) => {
  const b = req.body ?? {};
  const itemId = int(b.itemId);
  const name = clean(b.name, 100);
  const contact = clean(b.contact, 150);
  const when = new Date(b.proposedSchedule);
  if (!name || !contact) throw new HttpError(400, 'Enter your name and a way to reach you.');
  if (Number.isNaN(when.getTime()) || when < new Date()) throw new HttpError(400, 'Pick a pickup time in the future.');

  const item = (await pools.public.query('SELECT status FROM items WHERE itemId = $1', [itemId])).rows[0];
  if (!item || !['found', 'forgotten'].includes(item.status)) throw new HttpError(409, 'This item is not available to claim.');

  const n = encrypt(name);
  const c = encrypt(contact);
  await pools.public.query(
    `INSERT INTO claim_requests
       (itemId, claimantName_encrypted, claimantName_iv, claimantContact_encrypted, claimantContact_iv, proposedSchedule)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [itemId, n.encrypted, n.iv, c.encrypted, c.iv, when]);
  res.status(201).json({ message: 'Claim sent. Bring your school ID to the hub at the time you chose.' });
});

export default r;
