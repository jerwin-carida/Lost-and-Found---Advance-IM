import pg from 'pg';
import { config } from './config.js';

// Supabase is managed PostgreSQL. Use one application connection pool;
// application permissions are enforced by the Express authentication layer.
export const pool = new pg.Pool(config.pg);

pool.on('error', (e) => console.error('Idle database client error:', e.message));

// Keep the existing names so the route files need minimal changes.
// These aliases all use the same database connection and do NOT provide
// database-level role isolation.
export const pools = {
  public: pool,
  moderator: pool,
  admin: pool,
};

export const poolFor = () => pool;

// Turns a raw connection error into something you can act on.
export function explainDbError(e) {
  const msg = e?.message || String(e);
  const hints = [];
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') hints.push('Host not found. Check the host in DATABASE_URL. The "direct connection" host is IPv6-only; use the Session pooler string from Dashboard > Connect.');
  if (e?.code === 'ECONNREFUSED' || e?.code === 'ETIMEDOUT') hints.push('Could not reach the database. Check host/port and your network (the direct connection needs IPv6; the pooler works over IPv4).');
  if (/Tenant or user not found/i.test(msg)) hints.push('With the pooler the username must be postgres.PROJECT_REF (not just "postgres"), and the host must be the pooler host for your project region.');
  if (e?.code === '28P01' || /password authentication failed/i.test(msg)) hints.push('Wrong database password. Reset it in Dashboard > Database > Settings, and URL-encode special characters.');
  if (/self[- ]signed|certificate|SSL/i.test(msg)) hints.push('SSL problem. Remove DATABASE_CA if it points to the wrong file, or leave it unset to use the default encrypted connection.');
  if (e?.code === '42P01') hints.push('Tables are missing. Run "npm run setup".');
  return hints.length ? `${msg}\n  -> ${hints.join('\n  -> ')}` : msg;
}

// Runs fn(client) inside BEGIN ... COMMIT; any thrown error triggers ROLLBACK.
export async function withTx(databasePool, fn) {
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
