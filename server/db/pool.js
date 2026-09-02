import pg from 'pg';
import { config } from '../config.js';

let pool;

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
    pool.on('error', (err) => console.error('[pg] idle client error', err));

    // Best-effort: absent outside Vercel, and irrelevant to `node dev.js`.
    import('@vercel/functions')
      .then(({ attachDatabasePool }) => attachDatabasePool?.(pool))
      .catch(() => {});
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

/** First row, or undefined. Most of our reads want exactly this. */
export async function queryOne(text, params) {
  const { rows } = await query(text, params);
  return rows[0];
}
