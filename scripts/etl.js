// Incremental ETL: loads only rows that are new or changed since the last successful run.
//   npm run etl        (run "npm run dw:setup" once first)
// Everything in one transaction: either the whole batch loads and the watermark moves,
// or nothing changes and the next run retries the same window.
import crypto from 'node:crypto';
import pg from 'pg';
import { config } from '../backend/config.js';
import { tryDecrypt } from '../backend/crypto.js';
import { explainDbError } from '../backend/db.js';

// Rows written in the last 2 minutes may not be committed yet, so they wait for the next run.
const LAG = '2 minutes';

// Same contact always gives the same hash, so repeat claimants can be counted.
// The key is derived from ENCRYPTION_KEY, so no extra secret is needed.
const HASH_KEY = crypto.createHash('sha256').update(`dw-person:${config.encryptionKey}`).digest();
function personHash(contact) {
  const normalised = String(contact).trim().toLowerCase().replace(/[\s-]/g, '');
  return crypto.createHmac('sha256', HASH_KEY).update(normalised).digest('hex');
}

// Simple keyword categories. The first match wins; anything else is "Other".
const CATEGORIES = [
  ['ID card', /\b(id|card)\b/i],
  ['Bottle', /\b(bottle|tumbler|flask)\b/i],
  ['Umbrella', /\bumbrella\b/i],
  ['Phone', /\b(phone|iphone|smartphone)\b/i],
  ['Keys', /\bkeys?\b/i],
  ['Bag', /\b(bag|backpack|tote|pouch)\b/i],
  ['Wallet', /\b(wallet|purse)\b/i],
  ['Clothing', /\b(jacket|hoodie|shirt|sweater|cap|jersey)\b/i],
  ['Electronics', /\b(earbuds?|charger|laptop|calculator|usb)\b/i],
  ['Books and notes', /\b(book|notebook|notes|binder)\b/i],
];
const categorize = (desc) => (CATEGORIES.find(([, re]) => re.test(desc)) || ['Other'])[0];

const db = new pg.Client(config.pg);

async function runEtl() {
  await db.connect();
  await db.query('BEGIN');
  let batch;
  try {
    // Lock the watermark so two runs can't overlap.
    const { rows: [w] } = await db.query(
      `SELECT loaded_until AS from_ts, now() - interval '${LAG}' AS to_ts
       FROM dw.etl_watermark WHERE id = 1 FOR UPDATE`);
    const from = w.from_ts, to = w.to_ts;

    const { rows: [b] } = await db.query(
      'INSERT INTO dw.etl_batch (window_start, window_end) VALUES ($1, $2) RETURNING batch_id', [from, to]);
    batch = b.batch_id;
    let rows = 0;

    // 1. Staff: small table, so refresh all of it.
    const staff = await db.query(`
      INSERT INTO dw.dim_staff (user_id, name, role)
      SELECT u.userid, u.name, r.userrole FROM users u JOIN roles r ON r.roleid = u.roleid
      ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role`);
    rows += staff.rowCount;

    // 2. Items touched in this window: a new log entry, a new claim, or a new handover.
    const { rows: items } = await db.query(`
      SELECT i.itemid, i.description FROM items i
      WHERE i.description NOT LIKE '[seed]%' AND i.itemid IN (
        SELECT itemid FROM log WHERE changedat > $1 AND changedat <= $2
        UNION SELECT itemid FROM claim_requests WHERE submittedat > $1 AND submittedat <= $2
        UNION SELECT itemid FROM item_transactions WHERE "timestamp" > $1 AND "timestamp" <= $2)`,
      [from, to]);
    for (const it of items) {
      await db.query(`
        INSERT INTO dw.dim_item (item_id, description, category) VALUES ($1, $2, $3)
        ON CONFLICT (item_id) DO UPDATE SET description = EXCLUDED.description, category = EXCLUDED.category`,
        [it.itemid, it.description, categorize(it.description)]);
    }
    rows += items.length;

    // 3. New handovers: one fact row each. Contacts are decrypted here only to hash them.
    const { rows: txs } = await db.query(`
      SELECT t.transactionid, t.personcontact_encrypted, t.personcontact_iv
      FROM item_transactions t JOIN items i ON i.itemid = t.itemid
      WHERE t."timestamp" > $1 AND t."timestamp" <= $2 AND i.description NOT LIKE '[seed]%'
      ORDER BY t.transactionid`, [from, to]);
    for (const t of txs) {
      const contact = tryDecrypt(t.personcontact_encrypted, t.personcontact_iv);
      const hash = contact === '(unreadable)' ? null : personHash(contact);
      if (hash) {
        await db.query(
          'INSERT INTO dw.dim_person (person_hash) VALUES ($1) ON CONFLICT (person_hash) DO NOTHING', [hash]);
      }
      const r = await db.query(`
        INSERT INTO dw.fact_item_transaction (
          source_transaction_id, date_key, time_key, item_key, staff_key, person_key, type_key,
          claim_submit_date_key, proposed_pickup_date_key, claim_requested,
          days_to_handover, pickup_delay_hours, etl_batch_id)
        SELECT t.transactionid, dw.date_key(t."timestamp"), dw.time_key(t."timestamp"),
          di.item_key, ds.staff_key,
          (SELECT person_key FROM dw.dim_person WHERE person_hash = $2::char(64)),
          dtt.type_key,
          dw.date_key(cr.submittedat), dw.date_key(cr.proposedschedule),
          (t.requestid IS NOT NULL)::int,
          ((t."timestamp" AT TIME ZONE 'Asia/Manila')::date - (cr.submittedat AT TIME ZONE 'Asia/Manila')::date),
          ROUND((EXTRACT(EPOCH FROM (t."timestamp" - cr.proposedschedule)) / 3600)::numeric, 2),
          $3::int
        FROM item_transactions t
        JOIN dw.dim_item di ON di.item_id = t.itemid
        JOIN dw.dim_staff ds ON ds.user_id = t.handledby
        JOIN dw.dim_transaction_type dtt ON dtt.type_code = t.type
        LEFT JOIN claim_requests cr ON cr.requestid = t.requestid
        WHERE t.transactionid = $1::int
        ON CONFLICT (source_transaction_id) DO NOTHING`,
        [t.transactionid, hash, batch]);
      rows += r.rowCount;
    }

    if (items.length) {
      const ids = items.map((x) => x.itemid);

      // 4. Lifecycle: one row per affected item, recalculated from the source so it's always correct.
      const lc = await db.query(`
        WITH claimed AS (
          SELECT itemid, MIN(changedat) AS at FROM log WHERE code = 'claimed' GROUP BY itemid),
        claims AS (
          SELECT itemid, COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'rejected') AS rej
          FROM claim_requests WHERE itemid = ANY($1::int[]) GROUP BY itemid)
        INSERT INTO dw.fact_item_lifecycle (
          item_key, reported_date_key, resolved_date_key, current_status_key,
          claim_requests_cnt, rejected_claims_cnt, days_to_resolve, days_unclaimed, is_returned, etl_batch_id)
        SELECT di.item_key, dw.date_key(i.reportedat), dw.date_key(c.at), ds.status_key,
          COALESCE(cl.n, 0), COALESCE(cl.rej, 0),
          FLOOR(EXTRACT(EPOCH FROM (c.at - i.reportedat)) / 86400)::int,
          CASE WHEN i.status <> 'claimed' THEN FLOOR(EXTRACT(EPOCH FROM (now() - i.reportedat)) / 86400)::int END,
          i.status = 'claimed', $2::int
        FROM items i
        JOIN dw.dim_item di ON di.item_id = i.itemid
        JOIN dw.dim_status ds ON ds.status_code = i.status
        LEFT JOIN claimed c ON c.itemid = i.itemid
        LEFT JOIN claims cl ON cl.itemid = i.itemid
        WHERE i.itemid = ANY($1::int[])
        ON CONFLICT (item_key) DO UPDATE SET
          reported_date_key = EXCLUDED.reported_date_key, resolved_date_key = EXCLUDED.resolved_date_key,
          current_status_key = EXCLUDED.current_status_key, claim_requests_cnt = EXCLUDED.claim_requests_cnt,
          rejected_claims_cnt = EXCLUDED.rejected_claims_cnt, days_to_resolve = EXCLUDED.days_to_resolve,
          days_unclaimed = EXCLUDED.days_unclaimed, is_returned = EXCLUDED.is_returned,
          etl_batch_id = EXCLUDED.etl_batch_id`, [ids, batch]);
      rows += lc.rowCount;

      // 5. Status history: each log entry starts a period that ends when the next entry for the item starts.
      const hist = await db.query(`
        INSERT INTO dw.fact_status_history (
          source_log_id, item_key, status_key, entered_date_key, entered_time_key,
          exited_date_key, exited_time_key, hours_in_status, etl_batch_id)
        SELECT x.id, di.item_key, ds.status_key,
          dw.date_key(x.changedat), dw.time_key(x.changedat),
          dw.date_key(x.nxt), dw.time_key(x.nxt),
          ROUND((EXTRACT(EPOCH FROM (x.nxt - x.changedat)) / 3600)::numeric, 2), $2::int
        FROM (
          SELECT id, itemid, code, changedat,
                 LEAD(changedat) OVER (PARTITION BY itemid ORDER BY changedat, id) AS nxt
          FROM log WHERE itemid = ANY($1::int[])) x
        JOIN dw.dim_item di ON di.item_id = x.itemid
        JOIN dw.dim_status ds ON ds.status_code = x.code
        ON CONFLICT (source_log_id) DO UPDATE SET
          exited_date_key = EXCLUDED.exited_date_key, exited_time_key = EXCLUDED.exited_time_key,
          hours_in_status = EXCLUDED.hours_in_status, etl_batch_id = EXCLUDED.etl_batch_id`, [ids, batch]);
      rows += hist.rowCount;
    }

    // Move the watermark and record success, in the same transaction as the data.
    await db.query('UPDATE dw.etl_watermark SET loaded_until = $1 WHERE id = 1', [to]);
    await db.query(
      `UPDATE dw.etl_batch SET status = 'success', finished_at = now(), rows_loaded = $2 WHERE batch_id = $1`,
      [batch, rows]);
    await db.query('COMMIT');
    console.log(`Batch ${batch} loaded: ${rows} rows, window ${from.toISOString()} to ${to.toISOString()}.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    // The batch row was rolled back too, so record the failure separately.
    await db.query(`INSERT INTO dw.etl_batch (status, finished_at, error) VALUES ('failed', now(), $1)`,
      [e.message]).catch(() => {});
    console.error('ETL failed. Nothing was loaded and the watermark did not move.\n', explainDbError(e));
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
}

await runEtl();
