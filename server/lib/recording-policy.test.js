import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { recordingPolicy, hasRecordingAuthorization, recordingAuthorizationSql } from './recording-policy.js';
import { validateDeployment } from './deployment-config.js';

test('owner-only requires an explicit operator scope; default and invalid policies fail safely', () => {
  assert.deepEqual(recordingPolicy({}), { mode: 'all_parties', scope: null });
  for (const scope of [undefined, '', '   ']) assert.throws(() => recordingPolicy({ RECORDING_CONSENT_MODE:'owner_only', RECORDING_OWNER_ONLY_APPROVED_SCOPE:scope }), /APPROVED_SCOPE/);
  assert.throws(() => validateDeployment({ RECORDING_CONSENT_MODE:'owner_only' }), /APPROVED_SCOPE/);
  assert.throws(() => recordingPolicy({ RECORDING_CONSENT_MODE:'unknown' }), /CONSENT_MODE/);
  assert.deepEqual(recordingPolicy({ RECORDING_CONSENT_MODE:'owner_only', RECORDING_OWNER_ONLY_APPROVED_SCOPE:' Reviewed pilot ' }), { mode:'owner_only', scope:'Reviewed pilot' });
});

test('atomic SQL and UI authorization agree for every combination of direction, policy, choices, notice and scope', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    const owner = (await db.query("INSERT INTO users(phone) VALUES('+15555550101') RETURNING id")).rows[0];
    for (const mode of ['all_parties','owner_only']) for (const direction of ['outbound','inbound'])
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
