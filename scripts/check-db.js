// Quick Supabase connection test:  npm run db:check
const { pool, explainDbError } = await import('../backend/db.js');
const { config } = await import('../backend/config.js');

try {
  const { rows: [r] } = await pool.query('SELECT current_user AS u, current_database() AS d, version() AS v');
  console.log(`Connected to ${config.pg.host}:${config.pg.port} as ${r.u} (database: ${r.d})`);
  console.log(r.v);
  console.log(`SSL: ${config.pg.ssl ? (config.pg.ssl.rejectUnauthorized ? 'on, certificate verified' : 'on, certificate not verified') : 'off'}`);
  const t = await pool.query("SELECT to_regclass('public.items') AS items");
  console.log(t.rows[0].items ? 'Tables found.' : 'Tables not found yet. Run "npm run setup".');
} catch (e) {
  console.error('Connection failed:', explainDbError(e));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
