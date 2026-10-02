import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
test('Supabase privacy migration shields every application table from non-owner Data API roles',async()=>{
  const db=new PGlite();
  try {
    await db.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('./supabase-privacy.sql',import.meta.url),'utf8'));
    const metadata=await db.query(`SELECT count(*)::int AS total,bool_and(relrowsecurity) AS protected
      FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace
      WHERE nspname='public' AND relkind='r'`);
    assert.equal(metadata.rows[0].protected,true);assert.equal(metadata.rows[0].total,17);
    await db.query("INSERT INTO users(phone) VALUES('+15555550199')");
    await db.exec('CREATE ROLE dimts_data_api_test NOLOGIN; GRANT USAGE ON SCHEMA public TO dimts_data_api_test; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA public TO dimts_data_api_test; SET ROLE dimts_data_api_test');
    assert.equal((await db.query('SELECT phone FROM users')).rows.length,0);
    await assert.rejects(db.query("INSERT INTO users(phone) VALUES('+15555550198')"),error=>error.code==='42501');
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT phone FROM users')).rows.length,1);
    await db.exec('CREATE ROLE dimts_caller_backend NOLOGIN NOBYPASSRLS NOCREATEROLE');
    await db.exec(await readFile(new URL('./supabase-backend-access.sql',import.meta.url),'utf8'));
    await db.exec('SET ROLE dimts_caller_backend');
    assert.equal((await db.query('SELECT phone FROM users')).rows.length,1);
    await db.query("INSERT INTO users(phone) VALUES('+15555550197')");
    await db.query("INSERT INTO audit_events(action) VALUES('backend_write_check')");
    await db.exec('RESET ROLE; SET ROLE dimts_data_api_test');
    assert.equal((await db.query('SELECT phone FROM users')).rows.length,0);
    await assert.rejects(db.query("INSERT INTO users(phone) VALUES('+15555550196')"),error=>error.code==='42501');
    await db.exec('RESET ROLE');
  } finally {await db.close();}
});
