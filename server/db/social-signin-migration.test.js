import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('social migration is repeatable and permits only the backend role to use identities and Apple credentials', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE users(id UUID PRIMARY KEY); CREATE ROLE dimts_caller_backend NOLOGIN NOBYPASSRLS; CREATE ROLE social_anon NOLOGIN NOBYPASSRLS;');
    const migration = await readFile(new URL('./migrations/20261012_social_signin.sql', import.meta.url), 'utf8');
    await db.exec(migration); await db.exec(migration);
    await db.exec('GRANT USAGE ON SCHEMA public TO dimts_caller_backend,social_anon; GRANT SELECT,INSERT ON user_identities,social_signin_requests,apple_signin_credentials,apple_signin_events TO social_anon;');
    const id = '11111111-1111-4111-8111-111111111111';
    await db.query('INSERT INTO users(id) VALUES($1)', [id]);
    await db.exec('SET ROLE dimts_caller_backend');
    await db.query("INSERT INTO user_identities(provider,subject_hash,user_id) VALUES('apple','hash',$1)", [id]);
    await db.exec("INSERT INTO apple_signin_credentials(subject_hash,encrypted_token,authorized_at) VALUES('hash','ciphertext',now()); INSERT INTO social_signin_requests(token_hash,phase,provider) VALUES('hash','begin','apple');");
    assert.equal((await db.query('SELECT * FROM apple_signin_credentials')).rows.length, 1);
    await db.exec('RESET ROLE; SET ROLE social_anon');
    for (const table of ['user_identities','social_signin_requests','apple_signin_credentials','apple_signin_events']) {
      assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length, 0);
    }
    await assert.rejects(db.query("INSERT INTO apple_signin_credentials(subject_hash,encrypted_token,authorized_at) VALUES('blocked','bad',now())"), { code: '42501' });
  } finally { await db.close(); }
});
