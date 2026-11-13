// Run once against your Supabase PostgreSQL database:
//   npm run setup
// This creates the tables and inserts starter accounts/items.
// It does not create a database; Supabase already created it for your project.
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { config } = await import('../backend/config.js');
const { encrypt } = await import('../backend/crypto.js');
const { explainDbError } = await import('../backend/db.js');

const db = new pg.Client(config.pg);

try {
  await db.connect();

  await db.query(fs.readFileSync(path.join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  console.log('Supabase schema is ready.');

  await db.query("INSERT INTO roles (userRole) VALUES ('admin'), ('moderator') ON CONFLICT (userRole) DO NOTHING");

  const accounts = [
    ['admin', 'admin123', 'admin', 'admin@campus.local'],
    ['moderator', 'mod123', 'moderator', 'mod@campus.local'],
  ];

  for (const [name, password, role, contact] of accounts) {
    const { encrypted, iv } = encrypt(contact);
    await db.query(
      `INSERT INTO users (name, roleId, password_hash, contact_encrypted, contact_iv)
       SELECT $1, roleId, $2, $3, $4 FROM roles WHERE userRole = $5
       ON CONFLICT (name) DO NOTHING`,
      [name, await bcrypt.hash(password, 10), encrypted, iv, role]
    );
  }

  const existing = await db.query('SELECT 1 FROM items LIMIT 1');
  if (!existing.rowCount) {
    const samples = [
      ['Blue Hydro Flask water bottle with a dented lid', 'found'],
      ['Black umbrella, wooden handle', 'found'],
      ['Silver laptop charger (65W USB-C)', 'found'],
      ['Student ID holder with a green lanyard', 'found'],
      ['Gray hoodie, size M, left in the library', 'forgotten'],
      ['Prescription glasses in a red case', 'lost'],
      ['Scientific calculator (Casio fx-991)', 'lost'],
      ['Set of keys with a panda keychain', 'lost'],
    ];

    for (const [description, status] of samples) {
      const { rows } = await db.query(
        'INSERT INTO items (description, status) VALUES ($1, $2) RETURNING itemId',
        [description, status]
      );
      await db.query('INSERT INTO log (itemId, code) VALUES ($1, $2)', [rows[0].itemid, status]);
    }
    console.log('Starter items inserted.');
  }

  console.log('Setup complete. Change the starter staff passwords before public deployment.');
} catch (error) {
  console.error('Supabase setup failed:', explainDbError(error));
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
