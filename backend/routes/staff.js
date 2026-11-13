import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pools, poolFor, withTx } from '../db.js';
import { encrypt, tryDecrypt } from '../crypto.js';
import { authenticate, requireRole } from '../auth.js';
import { approveClaim, rejectClaim } from '../services/claims.js';
import { HttpError, camel, clean, int } from '../util.js';
import demo from './demo.js';

const r = Router();
r.use(authenticate, requireRole('admin', 'moderator'));   // everything below needs a staff session

const pool = (req) => poolFor(req.user.role);             // moderators -> app_user, admins -> app_admin
const NOT_SEED = "description NOT LIKE '[seed]%'";

// ---------- Overview ----------
r.get('/stats', async (req, res) => {
  const p = pool(req);
  const items = await p.query(`SELECT status, count(*)::int AS n FROM items WHERE ${NOT_SEED} GROUP BY status`);
  const pending = await p.query(
    `SELECT count(*)::int AS n FROM claim_requests cr JOIN items i ON i.itemId = cr.itemId
     WHERE cr.status = 'pending' AND i.${NOT_SEED}`);
  res.json({ items: Object.fromEntries(items.rows.map((x) => [x.status, x.n])), pendingClaims: pending.rows[0].n });
});

// ---------- Claims ----------
r.get('/claims', async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await pool(req).query(
    `SELECT cr.requestId, cr.itemId, i.description, cr.claimantName_encrypted, cr.claimantName_iv,
            cr.claimantContact_encrypted, cr.claimantContact_iv, cr.proposedSchedule, cr.status, cr.submittedAt
     FROM claim_requests cr JOIN items i ON i.itemId = cr.itemId
     WHERE cr.status = $1 AND i.${NOT_SEED}
     ORDER BY cr.submittedAt LIMIT 100`, [status]);
  res.json(rows.map((x) => ({
    requestId: x.requestid, itemId: x.itemid, description: x.description, status: x.status,
    claimantName: tryDecrypt(x.claimantname_encrypted, x.claimantname_iv),
    claimantContact: tryDecrypt(x.claimantcontact_encrypted, x.claimantcontact_iv),
    proposedSchedule: x.proposedschedule, submittedAt: x.submittedat,
  })));
});

r.patch('/claims/:id/verify', async (req, res) => {
  const out = await approveClaim(pool(req), int(req.params.id), req.user.userId);
  res.json({ message: 'Claim approved and recorded.', ...out });
});

r.patch('/claims/:id/reject', async (req, res) => {
  await rejectClaim(pool(req), int(req.params.id));
  res.json({ message: 'Claim rejected.' });
});

// ---------- Items ----------
r.get('/items', async (req, res) => {
  const where = [NOT_SEED];
  const params = [];
  if (['lost', 'found', 'forgotten', 'claimed'].includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`status = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${clean(req.query.q, 100)}%`);
    where.push(`description ILIKE $${params.length}`);
  }
  const { rows } = await pool(req).query(
    `SELECT itemId, description, status, reportedAt FROM items
     WHERE ${where.join(' AND ')} ORDER BY reportedAt DESC LIMIT 100`, params);
  res.json(rows.map(camel));
});

// Log a lost item (someone reported it missing at the desk).
r.post('/items', async (req, res) => {
  const description = clean(req.body?.description, 255);
  if (!description) throw new HttpError(400, 'Describe the item.');
  const id = await withTx(pool(req), async (c) => {
    const { rows } = await c.query(`INSERT INTO items (description, status) VALUES ($1, 'lost') RETURNING itemId`, [description]);
    await c.query(`INSERT INTO log (itemId, code) VALUES ($1, 'lost')`, [rows[0].itemid]);
    return rows[0].itemid;
  });
  res.status(201).json({ itemId: id });
});

r.post('/items/sweep', async (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(req.body?.days, 10) || 0, 0), 3650);
  const moved = await withTx(pool(req), async (c) => {
    const { rowCount } = await c.query(
      `WITH moved AS (
         UPDATE items SET status = 'forgotten'
         WHERE status = 'found' AND reportedAt < now() - make_interval(days => $1)
         RETURNING itemId)
       INSERT INTO log (itemId, code) SELECT itemId, 'forgotten' FROM moved`, [days]);
    return rowCount;
  });
  res.json({ moved });
});

r.patch('/items/:id', async (req, res) => {
  const status = req.body?.status;
  if (!['lost', 'found', 'forgotten'].includes(status)) throw new HttpError(400, 'Pick lost, found or forgotten.');
  const id = int(req.params.id);
  await withTx(pool(req), async (c) => {
    const { rowCount } = await c.query(
      `UPDATE items SET status = $1 WHERE itemId = $2 AND status <> 'claimed'`, [status, id]);
    if (!rowCount) throw new HttpError(409, 'Item not found, or already claimed.');
    await c.query('INSERT INTO log (itemId, code) VALUES ($1, $2)', [id, status]);
  });
  res.json({ message: 'Status updated.' });
});

// Admin only (checked here AND by the database: app_user has no DELETE grant).
r.delete('/items/:id', requireRole('admin'), async (req, res) => {
  const id = int(req.params.id);
  await withTx(pools.admin, async (c) => {
    await c.query('DELETE FROM log WHERE itemId = $1', [id]);
    const { rowCount } = await c.query('DELETE FROM items WHERE itemId = $1', [id]);
    if (!rowCount) throw new HttpError(404, 'Item not found.');
  });
  res.json({ message: 'Item deleted.' });
});

// ---------- Deposits & transaction history ----------
r.post('/transactions', async (req, res) => {
  const b = req.body ?? {};
  const description = clean(b.description, 255);
  const name = clean(b.personName, 100);
  const contact = clean(b.personContact, 150);
  if (!description || !name || !contact) throw new HttpError(400, 'Describe the item and record who handed it in.');
  const n = encrypt(name);
  const c2 = encrypt(contact);
  const id = await withTx(pool(req), async (c) => {
    const { rows } = await c.query(`INSERT INTO items (description, status) VALUES ($1, 'found') RETURNING itemId`, [description]);
    const itemId = rows[0].itemid;
    await c.query(`INSERT INTO log (itemId, code) VALUES ($1, 'found')`, [itemId]);
    await c.query(
      `INSERT INTO item_transactions
         (itemId, type, personName_encrypted, personName_iv, personContact_encrypted, personContact_iv, handledBy)
       VALUES ($1, 'deposit', $2, $3, $4, $5, $6)`,
      [itemId, n.encrypted, n.iv, c2.encrypted, c2.iv, req.user.userId]);
    return itemId;
  });
  res.status(201).json({ itemId: id });
});

r.get('/transactions', async (req, res) => {
  const { rows } = await pool(req).query(
    `SELECT t.transactionId, t.type, t.itemId, i.description, t.personName_encrypted, t.personName_iv,
            t.personContact_encrypted, t.personContact_iv, u.name AS staff, t.timestamp
     FROM item_transactions t
     JOIN items i ON i.itemId = t.itemId
     JOIN users u ON u.userId = t.handledBy
     WHERE i.${NOT_SEED}
     ORDER BY t.timestamp DESC LIMIT 100`);
  res.json(rows.map((x) => ({
    transactionId: x.transactionid, type: x.type, itemId: x.itemid, description: x.description,
    person: tryDecrypt(x.personname_encrypted, x.personname_iv),
    contact: tryDecrypt(x.personcontact_encrypted, x.personcontact_iv),
    staff: x.staff, timestamp: x.timestamp,
  })));
});

// ---------- Staff accounts (admin only) ----------
r.get('/users', requireRole('admin'), async (req, res) => {
  const { rows } = await pools.admin.query(
    `SELECT u.userId, u.name, r.userRole, u.contact_encrypted, u.contact_iv
     FROM users u JOIN roles r ON r.roleId = u.roleId ORDER BY u.userId`);
  res.json(rows.map((x) => ({
    userId: x.userid, name: x.name, role: x.userrole, contact: tryDecrypt(x.contact_encrypted, x.contact_iv),
  })));
});

r.post('/users', requireRole('admin'), async (req, res) => {
  const b = req.body ?? {};
  const name = clean(b.name, 50);
  const password = String(b.password ?? '');
  const contact = clean(b.contact, 150);
  if (!name || password.length < 6 || !contact || !['admin', 'moderator'].includes(b.role)) {
    throw new HttpError(400, 'Enter a name, a password of 6+ characters, a contact and a role.');
  }
  const { encrypted, iv } = encrypt(contact);
  await pools.admin.query(
    `INSERT INTO users (name, roleId, password_hash, contact_encrypted, contact_iv)
     SELECT $1, roleId, $2, $3, $4 FROM roles WHERE userRole = $5`,
    [name, await bcrypt.hash(password, 10), encrypted, iv, b.role]);
  res.status(201).json({ message: 'Account created.' });
});

r.use('/demo', requireRole('admin'), demo);

export default r;
