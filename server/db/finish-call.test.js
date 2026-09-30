import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { FINISH_CALL_SQL } from './finish-call.js';

test('usage failure rolls back duration; retries count connected minutes exactly once', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    const user = (await db.query("INSERT INTO users(phone) VALUES('+15555550101') RETURNING id")).rows[0];
    const call = (await db.query("INSERT INTO calls(user_id,user_phone,destination) VALUES($1,'+15555550101','+15555550102') RETURNING id", [user.id])).rows[0];
    const params = [call.id, 120, true, 'Dial completed', 'failed', '2026-10'];
    await db.exec('ALTER TABLE usage_minutes ADD CONSTRAINT simulated_failure CHECK (minutes_used < 1)');
    await assert.rejects(db.query(FINISH_CALL_SQL, params));
    assert.equal((await db.query('SELECT duration_sec FROM calls WHERE id=$1', [call.id])).rows[0].duration_sec, null);
    await db.exec('ALTER TABLE usage_minutes DROP CONSTRAINT simulated_failure');
    assert.equal((await db.query(FINISH_CALL_SQL, params)).rows.length, 1);
    assert.equal((await db.query(FINISH_CALL_SQL, params)).rows.length, 0);
    assert.equal(Number((await db.query('SELECT minutes_used FROM usage_minutes WHERE user_id=$1', [user.id])).rows[0].minutes_used), 2);
  } finally { await db.close(); }
});
