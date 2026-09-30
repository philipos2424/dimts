import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

test('schema supports persistent sessions and atomic processing claims', async () => {
  const db = new PGlite();
  try {
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    await db.exec(schema);
    await db.exec(schema); // Upgrades may be applied to existing installations.
    const { rows: [owner] } = await db.query('INSERT INTO users (phone) VALUES ($1) RETURNING id', ['+14754053943']);
    await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, ['hash', owner.id]);
    const { rows: [call] } = await db.query(`INSERT INTO calls (user_id, user_phone, destination, recording_url)
      VALUES ($1, $2, $3, $4) RETURNING id`, [owner.id, '+14754053943', '+15551234567', 'test-recording']);
    const claim = `UPDATE calls SET processing_until = now() + interval '10 minutes'
      WHERE id = $1 AND (processing_until IS NULL OR processing_until < now()) RETURNING id`;
    assert.equal((await db.query(claim, [call.id])).rows.length, 1);
    assert.equal((await db.query(claim, [call.id])).rows.length, 0);
    await db.query(`UPDATE calls SET processing_until = now() - interval '1 second' WHERE id = $1`, [call.id]);
    assert.equal((await db.query(claim, [call.id])).rows.length, 1);
  } finally { await db.close(); }
});
