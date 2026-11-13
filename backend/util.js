export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Postgres returns lowercase column names; map the ones the API exposes back to camelCase.
const NAMES = ['userId', 'roleId', 'userRole', 'itemId', 'requestId', 'transactionId',
  'reportedAt', 'changedAt', 'proposedSchedule', 'submittedAt', 'handledBy'];
const MAP = Object.fromEntries(NAMES.map((n) => [n.toLowerCase(), n]));
export const camel = (row) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [MAP[k] ?? k, v]));

export const clean = (v, max) => String(v ?? '').trim().slice(0, max);

export function int(v) {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Invalid number.');
  return n;
}
