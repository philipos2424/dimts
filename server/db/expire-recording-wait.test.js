import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { EXPIRE_RECORDING_WAIT_SQL } from './expire-recording-wait.js';

test('missing audio expires from completion only, without touching other owners, active calls or available audio', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    const owners = (await db.query("INSERT INTO users(phone) VALUES('+15555550101'),('+15555550102') RETURNING id")).rows;
    async function seed(owner, status, completed, audio, duration = 60) {
      return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,completed_at,recording_url,duration_sec,created_at)
        VALUES($1,'+15555550101','+15555550103',$2,$3,$4,$5,now()-interval '1 day') RETURNING id`,
        [owner, status, completed, audio, duration])).rows[0].id;
    }
    const old = new Date(Date.now() - 11 * 60_000), recent = new Date();
    const missing = await seed(owners[0].id, 'processing', old, null);
    const untouched = [await seed(owners[1].id, 'processing', old, null),
      await seed(owners[0].id, 'processing', recent, null),
      await seed(owners[0].id, 'processing', old, 'available'),
      await seed(owners[0].id, 'in-progress', null, null, null),
      await seed(owners[0].id, 'ready', old, 'available'),
      await seed(owners[0].id, 'completed', old, null)];
    await db.query(EXPIRE_RECORDING_WAIT_SQL, [owners[0].id]);
    const failed = (await db.query('SELECT * FROM calls WHERE id=$1', [missing])).rows[0];
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /recording has not arrived/);
    assert.equal(failed.duration_sec, 60); assert.equal(failed.record_enabled, true);
    assert.deepEqual((await db.query('SELECT status FROM calls WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id)', [untouched])).rows.map(r => r.status),
      ['processing', 'processing', 'processing', 'in-progress', 'ready', 'completed']);
    assert.equal((await db.query(EXPIRE_RECORDING_WAIT_SQL, [owners[0].id])).affectedRows, 0);
  } finally { await db.close(); }
});
