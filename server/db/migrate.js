import { readFile } from 'node:fs/promises';
import * as database from './pool.js';

export async function migrateSchema(db = database) {
  const schema = await readFile(new URL('./schema.sql',import.meta.url),'utf8');
  await db.withTransaction(async tx => {
    // Serialize migrations across replicas, including first initialization.
    await tx.query('SELECT pg_advisory_xact_lock($1)',[20261001]);
    await tx.query(schema);
  });
}
