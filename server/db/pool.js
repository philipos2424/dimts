import pg from 'pg';
import { config } from '../config.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { safeError } from '../lib/log-safe.js';

let pool;
let localDatabase;

/**
 * Lazily-created connection pool.
 *
 * Under Fluid compute a single instance serves many invocations, so the pool
 * must be reused across them; `attachDatabasePool` lets Vercel release idle
 * clients before the instance suspends, which otherwise leaks connections
 * until Supabase's pooler refuses new ones.
 */
export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[pg] idle client error', safeError(err)));

    // Best-effort: absent outside Vercel, and irrelevant to `node dev.js`.
    import('@vercel/functions')
      .then(({ attachDatabasePool }) => attachDatabasePool?.(pool))
      .catch(() => {});
  }
  return pool;
}

async function getLocalDatabase() {
  if (process.env.VERCEL) throw new Error('Local database cannot run on Vercel; configure DATABASE_URL.');
  if (!localDatabase) localDatabase = (async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const path = process.env.LOCAL_DATABASE_PATH || fileURLToPath(new URL('../../.data/postgres', import.meta.url));
    const db = new PGlite(path);
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    await db.exec(schema);
    return db;
  })();
  return localDatabase;
}

export async function query(text, params) {
  if (process.env.DATABASE_MODE === 'local') {
    return (await getLocalDatabase()).query(text, params);
  }
  return getPool().query(text, params);
}

export async function withTransaction(work) {
  if (process.env.DATABASE_MODE === 'local') return (await getLocalDatabase()).transaction(work);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

/** First row, or undefined. Most of our reads want exactly this. */
export async function queryOne(text, params) {
  const { rows } = await query(text, params);
  return rows[0];
}

export async function closeDatabase() {
  if (localDatabase) { await (await localDatabase).close(); localDatabase = undefined; }
  if (pool) { await pool.end(); pool = undefined; }
}
