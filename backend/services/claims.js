import { withTx } from '../db.js';
import { HttpError } from '../util.js';

// Approving a claim touches five tables, so it is one transaction: all or nothing.
// Lock order is item first, then request. Two staff approving rival claims for the
// same item therefore queue on the item row (no deadlock) and the second is refused.
export async function approveClaim(pool, requestId, staffId, { simulateFailure = false } = {}) {
  return withTx(pool, async (c) => {
    const first = (await c.query('SELECT itemId FROM claim_requests WHERE requestId = $1', [requestId])).rows[0];
    if (!first) throw new HttpError(404, 'Claim request not found.');

    const item = (await c.query('SELECT status FROM items WHERE itemId = $1 FOR UPDATE', [first.itemid])).rows[0];
    const req = (await c.query('SELECT * FROM claim_requests WHERE requestId = $1 FOR UPDATE', [requestId])).rows[0];
    if (req.status !== 'pending') throw new HttpError(409, `This claim is already ${req.status}.`);
    if (!['found', 'forgotten'].includes(item.status)) throw new HttpError(409, 'This item has already been claimed.');

    // 1. The confirmed, staff-owned record (ciphertext + IVs are copied as they are).
    await c.query(
      `INSERT INTO item_transactions
         (itemId, requestId, type, personName_encrypted, personName_iv,
          personContact_encrypted, personContact_iv, handledBy)
       VALUES ($1, $2, 'claim', $3, $4, $5, $6, $7)`,
      [req.itemid, requestId, req.claimantname_encrypted, req.claimantname_iv,
       req.claimantcontact_encrypted, req.claimantcontact_iv, staffId]);

    if (simulateFailure) throw new Error('Simulated crash after inserting the transaction row');

    // 2-5. Close out the request, the item, the history, and any rival claims.
    await c.query(`UPDATE claim_requests SET status = 'approved' WHERE requestId = $1`, [requestId]);
    await c.query(`UPDATE items SET status = 'claimed' WHERE itemId = $1`, [req.itemid]);
    await c.query(`INSERT INTO log (itemId, code) VALUES ($1, 'claimed')`, [req.itemid]);
    await c.query(`UPDATE claim_requests SET status = 'rejected' WHERE itemId = $1 AND status = 'pending'`, [req.itemid]);
    return { itemId: req.itemid };
  });
}

export async function rejectClaim(pool, requestId) {
  const { rowCount } = await pool.query(
    `UPDATE claim_requests SET status = 'rejected' WHERE requestId = $1 AND status = 'pending'`, [requestId]);
  if (!rowCount) throw new HttpError(409, 'That claim is not pending anymore.');
}
