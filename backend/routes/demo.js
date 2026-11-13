import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pools, withTx } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { approveClaim } from '../services/claims.js';
import { HttpError } from '../util.js';

// Admin-only teaching tools for the four topics: transactions, encryption,
// authorization, query optimization. Mounted at /api/staff/demo.
const r = Router();
const q = (sql, params) => pools.admin.query(sql, params);

// ======================= 1. TRANSACTIONS =======================
async function cleanupDemo() {
  await withTx(pools.admin, async (c) => {
    const demo = `(SELECT itemId FROM items WHERE description LIKE '[demo]%')`;
    await c.query(`DELETE FROM item_transactions WHERE itemId IN ${demo}`);
    await c.query(`DELETE FROM claim_requests WHERE itemId IN ${demo}`);
    await c.query(`DELETE FROM log WHERE itemId IN ${demo}`);
    await c.query(`DELETE FROM items WHERE description LIKE '[demo]%'`);
  });
}

async function makeFixture() {
  await cleanupDemo();
  const { rows: [item] } = await q(
    `INSERT INTO items (description, status) VALUES ('[demo] Black umbrella', 'found') RETURNING itemId`);
  const claimIds = [];
  for (const who of ['Demo Student A', 'Demo Student B']) {
    const n = encrypt(who);
    const c = encrypt(`${who.split(' ')[2].toLowerCase()}@campus.local`);
    const { rows: [cr] } = await q(
      `INSERT INTO claim_requests
         (itemId, claimantName_encrypted, claimantName_iv, claimantContact_encrypted, claimantContact_iv, proposedSchedule)
       VALUES ($1, $2, $3, $4, $5, now() + interval '1 day') RETURNING requestId`,
      [item.itemid, n.encrypted, n.iv, c.encrypted, c.iv]);
    claimIds.push(cr.requestid);
  }
  return { itemId: item.itemid, claimIds };
}

async function snapshot({ itemId }) {
  const [item, claims, tx, log] = await Promise.all([
    q('SELECT status FROM items WHERE itemId = $1', [itemId]),
    q('SELECT requestId, status FROM claim_requests WHERE itemId = $1 ORDER BY requestId', [itemId]),
    q('SELECT count(*)::int AS n FROM item_transactions WHERE itemId = $1', [itemId]),
    q('SELECT count(*)::int AS n FROM log WHERE itemId = $1', [itemId]),
  ]);
  return {
    itemStatus: item.rows[0].status,
    claims: claims.rows.map((c) => `#${c.requestid} ${c.status}`),
    transactionRows: tx.rows[0].n,
    logRows: log.rows[0].n,
  };
}

r.post('/transaction', async (req, res) => {
  const mode = req.body?.mode;
  if (!['rollback', 'commit', 'race'].includes(mode)) throw new HttpError(400, 'Unknown mode.');
  const fx = await makeFixture();
  const before = await snapshot(fx);
  const staffId = req.user.userId;
  let outcome;

  if (mode === 'rollback') {
    try {
      await approveClaim(pools.admin, fx.claimIds[0], staffId, { simulateFailure: true });
      outcome = 'Unexpected: no crash happened.';
    } catch (e) {
      outcome = `${e.message}. The database ran ROLLBACK, so the transaction row it had already inserted was undone.`;
    }
  } else if (mode === 'commit') {
    await approveClaim(pools.admin, fx.claimIds[0], staffId);
    outcome = 'COMMIT: the transaction row, claim status, item status, log entry and rival rejection were saved together.';
  } else {
    const results = await Promise.allSettled(fx.claimIds.map((id) => approveClaim(pools.admin, id, staffId)));
    outcome = results.map((s, i) => s.status === 'fulfilled'
      ? `Claim #${fx.claimIds[i]}: approved`
      : `Claim #${fx.claimIds[i]}: refused (${s.reason.message})`).join('   |   ');
  }
  res.json({ before, outcome, after: await snapshot(fx) });
});

// ======================= 2. ENCRYPTION =======================
r.get('/encryption', async (req, res) => {
  const { rows } = await q(
    `SELECT transactionId, type, personName_encrypted, personName_iv, personContact_encrypted, personContact_iv
     FROM item_transactions ORDER BY transactionId DESC LIMIT 5`);
  res.json(rows.map((x) => ({
    transactionId: x.transactionid, type: x.type,
    nameCipher: x.personname_encrypted.toString('hex'), nameIv: x.personname_iv.toString('hex'),
    contactCipher: x.personcontact_encrypted.toString('hex'), contactIv: x.personcontact_iv.toString('hex'),
    name: decrypt(x.personname_encrypted, x.personname_iv),
    contact: decrypt(x.personcontact_encrypted, x.personcontact_iv),
  })));
});

r.post('/encryption/try', async (req, res) => {
  const text = String(req.body?.text ?? '').slice(0, 100) || 'Maria Santos';
  const a = encrypt(text);
  const b = encrypt(text);
  const attempt = (fn) => { try { return JSON.stringify(fn()); } catch (e) { return `Error: ${e.message}`; } };
  res.json({
    text,
    first: { iv: a.iv.toString('hex'), cipher: a.encrypted.toString('hex') },
    second: { iv: b.iv.toString('hex'), cipher: b.encrypted.toString('hex') },
    roundTrip: decrypt(a.encrypted, a.iv),
    wrongKey: attempt(() => decrypt(a.encrypted, a.iv, crypto.randomBytes(32))),
    wrongIv: attempt(() => decrypt(a.encrypted, b.iv)),
    bcrypt: [await bcrypt.hash(text, 10), await bcrypt.hash(text, 10)],
  });
});

// ======================= 3. AUTHORIZATION =======================
// Every statement ends in WHERE false, so nothing changes. Postgres still checks privileges,
// and SQLSTATE 42501 means "permission denied".
const AUTHZ_TESTS = [
  ['Read items', 'SELECT itemId FROM items WHERE false'],
  ['Read claim requests', 'SELECT requestId FROM claim_requests WHERE false'],
  ['Read password hashes', 'SELECT password_hash FROM users WHERE false'],
  ['Insert claim request', `INSERT INTO claim_requests (itemId, claimantName_encrypted, claimantName_iv,
      claimantContact_encrypted, claimantContact_iv, proposedSchedule)
      SELECT 1, ''::bytea, ''::bytea, ''::bytea, ''::bytea, now() WHERE false`],
  ['Update items', 'UPDATE items SET status = status WHERE false'],
  ['Delete items', 'DELETE FROM items WHERE false'],
];

r.get('/authz', async (req, res) => {
  res.json({
    mode: 'application-level',
    message: 'This Supabase configuration uses one database connection role. Staff authorization is enforced by Express middleware and route-level role checks, not by separate PostgreSQL roles.',
    roles: ['Student (public routes)', 'Moderator (authenticated staff)', 'Admin (authenticated staff)'],
    tests: [],
  });
});

// ======================= 4. QUERY OPTIMIZATION =======================
const INDEXES = {
  idx_items_status_reported: 'CREATE INDEX idx_items_status_reported ON items (status, reportedAt DESC)',
  idx_log_item_changed: 'CREATE INDEX idx_log_item_changed ON log (itemId, changedAt)',
  idx_claims_pending: `CREATE INDEX idx_claims_pending ON claim_requests (submittedAt) WHERE status = 'pending'`,
};
const QUERIES = {
  dashboard: `SELECT itemId, description FROM items WHERE status = 'lost' ORDER BY reportedAt DESC LIMIT 20`,
  history: `SELECT id, code, changedAt FROM log
            WHERE itemId = (SELECT (min(itemId) + max(itemId)) / 2 FROM items) ORDER BY changedAt`,
  pending: `SELECT requestId, itemId, submittedAt FROM claim_requests WHERE status = 'pending' ORDER BY submittedAt LIMIT 20`,
};

async function state() {
  const idx = await q(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`, [Object.keys(INDEXES)]);
  const counts = await q(`SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM log) AS log,
                                 (SELECT count(*)::int FROM claim_requests) AS claims`);
  return { indexes: idx.rows.map((x) => x.indexname), counts: counts.rows[0] };
}

r.get('/optimization', async (req, res) => res.json(await state()));

r.post('/seed', async (req, res) => {
  const n = Math.min(Math.max(Number.parseInt(req.body?.count, 10) || 200000, 1000), 500000);
  await withTx(pools.admin, async (c) => {
    await c.query(
      `INSERT INTO items (description, status, reportedAt)
       SELECT '[seed] Item #' || g, (ARRAY['lost','found','forgotten','claimed'])[1 + floor(random() * 4)::int],
              now() - random() * interval '730 days'
       FROM generate_series(1, $1::int) g`, [n]);
    await c.query(
      `INSERT INTO log (itemId, code, changedAt)
       SELECT itemId, status, reportedAt FROM items WHERE description LIKE '[seed]%'`);
    await c.query(
      `INSERT INTO claim_requests (itemId, claimantName_encrypted, claimantName_iv, claimantContact_encrypted,
                                   claimantContact_iv, proposedSchedule, status, submittedAt)
       SELECT itemId, decode(md5(itemId::text), 'hex'), decode(md5('n' || itemId), 'hex'),
              decode(md5('c' || itemId), 'hex'), decode(md5('i' || itemId), 'hex'), now(),
              CASE WHEN itemId % 100 = 0 THEN 'pending' ELSE 'approved' END, reportedAt + interval '1 day'
       FROM items WHERE description LIKE '[seed]%' AND itemId % 4 = 0`);
  });
  for (const t of ['items', 'log', 'claim_requests']) await q(`ANALYZE ${t}`);
  res.json(await state());
});

r.delete('/seed', async (req, res) => {
  await withTx(pools.admin, async (c) => {
    const seeds = `(SELECT itemId FROM items WHERE description LIKE '[seed]%')`;
    await c.query(`DELETE FROM claim_requests WHERE itemId IN ${seeds}`);
    await c.query(`DELETE FROM log WHERE itemId IN ${seeds}`);
    await c.query(`DELETE FROM items WHERE description LIKE '[seed]%'`);
  });
  for (const t of ['items', 'log', 'claim_requests']) await q(`ANALYZE ${t}`);
  res.json(await state());
});

r.post('/indexes', async (req, res) => {
  const action = req.body?.action;
  if (!['create', 'drop'].includes(action)) throw new HttpError(400, 'Unknown action.');
  for (const [name, ddl] of Object.entries(INDEXES)) {
    await q(action === 'create' ? ddl.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS') : `DROP INDEX IF EXISTS ${name}`);
  }
  for (const t of ['items', 'log', 'claim_requests']) await q(`ANALYZE ${t}`);
  res.json(await state());
});

r.post('/explain', async (req, res) => {
  const sql = QUERIES[req.body?.query];   // whitelist: the browser never sends SQL
  if (!sql) throw new HttpError(400, 'Unknown query.');
  const { rows } = await q(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
  const lines = rows.map((x) => x['QUERY PLAN']);
  const ms = lines.join('\n').match(/Execution Time: ([\d.]+) ms/);
  res.json({ sql: sql.replace(/\s+/g, ' '), plan: lines, executionMs: ms ? Number(ms[1]) : null });
});

export default r;
