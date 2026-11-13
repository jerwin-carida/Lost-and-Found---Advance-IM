import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Always read the .env at the project root, whatever folder you start the server from.
dotenv.config({ path: path.join(ROOT, '.env') });

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function need(key) {
  if (!process.env[key]) fail(`Missing ${key} in .env (project root). See .env.example.`);
  return process.env[key];
}

const PLACEHOLDERS = ['YOUR_PASSWORD', 'YOUR-PASSWORD', 'PROJECT_REF', 'PROJECT-REF', 'YOUR_POOLER_HOST', '[YOUR'];

// Turns DATABASE_URL (or the separate DB_* variables) into a node-postgres config.
// The URL is parsed here, instead of passed through as-is, so that:
//   - special characters in the password are handled (URL-decoded),
//   - SSL is set explicitly. Supabase's certificate is signed by its own CA, which Node
//     does not trust by default, so a bare "?sslmode=require" can fail with
//     "self-signed certificate in certificate chain".
function buildPgConfig() {
  const env = process.env;
  let conn;

  if (env.DATABASE_URL) {
    if (PLACEHOLDERS.some((p) => env.DATABASE_URL.includes(p))) {
      fail('DATABASE_URL still contains a placeholder. Paste your real Supabase connection string and password into .env.');
    }
    let u;
    try {
      u = new URL(env.DATABASE_URL);
    } catch {
      fail('DATABASE_URL is not a valid URL. If your password contains @ : / ? # or %, URL-encode it (e.g. @ -> %40), or use the separate DB_HOST / DB_USER / DB_PASSWORD variables instead.');
    }
    conn = {
      host: u.hostname,
      port: Number(u.port) || 5432,
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      sslmode: u.searchParams.get('sslmode'),
    };
  } else if (env.DB_HOST) {
    conn = {
      host: env.DB_HOST,
      port: Number(env.DB_PORT) || 5432,
      database: env.DB_NAME || 'postgres',
      user: need('DB_USER'),
      password: need('DB_PASSWORD'),
      sslmode: null,
    };
  } else {
    fail('Missing DATABASE_URL in .env (project root). Copy it from Supabase Dashboard > Connect. See .env.example.');
  }

  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(conn.host);
  const sslOff = env.DB_SSL === 'disable' || conn.sslmode === 'disable' || (isLocal && env.DB_SSL !== 'require');

  let ssl = false;
  if (!sslOff) {
    if (env.DATABASE_CA) {
      // Strict mode: verify the server using Supabase's CA certificate (download it from
      // Dashboard > Database > Settings > SSL Configuration).
      const caPath = path.resolve(ROOT, env.DATABASE_CA);
      if (!fs.existsSync(caPath)) fail(`DATABASE_CA file not found: ${caPath}`);
      ssl = { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
    } else {
      // Encrypted connection, certificate not verified. Works out of the box with Supabase.
      ssl = { rejectUnauthorized: false };
    }
  }

  return {
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    ssl,
    max: Number(env.DB_POOL_MAX) || 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  };
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  pg: buildPgConfig(),
  jwtSecret: need('JWT_SECRET'),
  encryptionKey: need('ENCRYPTION_KEY'),
};
