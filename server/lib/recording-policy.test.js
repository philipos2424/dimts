import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { recordingPolicy, hasRecordingAuthorization, recordingAuthorizationSql } from './recording-policy.js';
import { validateDeployment } from './deployment-config.js';

test('every new call uses the single notice policy regardless of legacy environment settings', () => {
  assert.deepEqual(recordingPolicy({}), { mode: 'notice', scope: null });
  assert.deepEqual(recordingPolicy({ RECORDING_CONSENT_MODE:'owner_only' }), { mode: 'notice', scope: null });
  // Consent settings no longer block deployment; the next check reached is the database mode.
  assert.throws(() => validateDeployment({ RECORDING_CONSENT_MODE:'owner_only' }), /DATABASE_MODE/);
});

test('a Gulf number on either side needs every person to press 1', () => {
  assert.deepEqual(recordingPolicy({}, ['+14155550000', '+971501234567']), { mode: 'all_parties', scope: null });
  assert.deepEqual(recordingPolicy({}, ['+966501234567', '+447911123456']), { mode: 'all_parties', scope: null });
  assert.deepEqual(recordingPolicy({}, ['+14155550000', '+251911234567']), { mode: 'notice', scope: null });
});

test('German and Austrian numbers need every person to press 1; the rest of the EU gets the notice', () => {
  assert.deepEqual(recordingPolicy({}, ['+14155550000', '+4915112345678']), { mode: 'all_parties', scope: null });
  assert.deepEqual(recordingPolicy({}, ['+436641234567', '+447911123456']), { mode: 'all_parties', scope: null });
  assert.deepEqual(recordingPolicy({}, ['+33612345678', '+447911123456']), { mode: 'notice', scope: null });
});

test('atomic SQL and UI authorization agree for every combination of direction, policy, choices, notice and scope', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    const owner = (await db.query("INSERT INTO users(phone) VALUES('+15555550101') RETURNING id")).rows[0];
    for (const mode of ['all_parties','owner_only','notice']) for (const direction of ['outbound','inbound'])
      for (const parent of [null,new Date()]) for (const child of [null,new Date()])
        for (const notice of [null,new Date()]) for (const scope of [null,'   ','Reviewed pilot']) for (const enabled of [true,false]) {
          const call = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,consent_mode,direction,
            parent_consent_at,child_consent_at,other_party_notice_issued_at,consent_scope,record_enabled)
            VALUES($1,'+15555550101','+15555550102',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [owner.id,mode,direction,parent,child,notice,scope,enabled])).rows[0];
          const allowed = (await db.query(`SELECT COALESCE(${recordingAuthorizationSql},false) AS allowed FROM calls WHERE id=$1`, [call.id])).rows[0].allowed;
          assert.equal(hasRecordingAuthorization(call), allowed, JSON.stringify({mode,direction,parent,child,notice,scope,enabled}));
        }
  } finally { await db.close(); }
});
