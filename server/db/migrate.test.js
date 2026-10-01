import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrateSchema } from './migrate.js';

test('transactional schema initialization is repeatable and preserves existing owners and call deletion references',async()=>{
  const database=new PGlite();let locks=0;
  const db={withTransaction:work=>database.transaction(tx=>work({query:async(sql,params)=>{
    // PGlite has no PostgreSQL advisory-lock function; exercise all migration
    // statements against real SQL and check the lock request separately.
    if(sql==='SELECT pg_advisory_xact_lock($1)'){assert.deepEqual(params,[20261001]);locks++;return{rows:[]};}
    return tx.exec(sql);
  }}))};
  try {
    await migrateSchema(db);
    const owner=(await database.query("INSERT INTO users(phone) VALUES('+15555550101') RETURNING id")).rows[0];
    const call=(await database.query(`INSERT INTO calls(user_id,user_phone,destination,status,deleted_at,
      twilio_account_sid,provider_deletion_status) VALUES($1,'','','deleted',now(),$2,'unknown') RETURNING id`,
      [owner.id,'AC'+'a'.repeat(32)])).rows[0];
    await migrateSchema(db);
    assert.equal(locks,2);
    assert.equal((await database.query('SELECT phone FROM users WHERE id=$1',[owner.id])).rows[0].phone,'+15555550101');
    const saved=(await database.query('SELECT * FROM calls WHERE id=$1',[call.id])).rows[0];
    assert.ok(saved.deleted_at);assert.equal(saved.provider_deletion_status,'unknown');assert.equal(saved.twilio_account_sid,'AC'+'a'.repeat(32));
  } finally {await database.close();}
});
test('a failed migration propagates its error instead of allowing startup to continue',async()=>{
  let locked=false;
  await assert.rejects(migrateSchema({withTransaction:async work=>work({query:async sql=>{
    if(sql.startsWith('SELECT pg_advisory')){locked=true;return{rows:[]};}
    throw new Error('Migration failed');
  }})}),/Migration failed/);
  assert.equal(locked,true);
});
