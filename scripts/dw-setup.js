// One-time setup of the data warehouse schema (dw). Safe to re-run.
//   npm run dw:setup
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { config } = await import('../backend/config.js');
const { explainDbError } = await import('../backend/db.js');

const db = new pg.Client(config.pg);
try {
  await db.connect();
  await db.query(fs.readFileSync(path.join(ROOT, 'sql', 'warehouse.sql'), 'utf8'));
  console.log('Data warehouse schema (dw) is ready. Next: npm run etl');
} catch (e) {
  console.error('Warehouse setup failed:', explainDbError(e));
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
