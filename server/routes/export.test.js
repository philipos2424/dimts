import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
async function signedIn(phone) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [createHash('sha256').update(token).digest('hex'), user.id]);
  return { id: user.id, token };
}
const exportFor = token => fetch(origin + '/api/me/export', { headers: { Authorization: `Bearer ${token}` } });

test('an export holds the user\'s own data and no secrets or other people\'s records', async () => {
  const a = await signedIn('+15555550401'), b = await signedIn('+15555550402');
  const shared = '+15555550499';
  const contactA = (await db.query(`INSERT INTO contacts(user_id,phone,display_name) VALUES($1,$2,'Abebe') RETURNING id`, [a.id, shared])).rows[0];
  await db.query(`INSERT INTO contacts(user_id,phone,display_name) VALUES($1,$2,'B private name')`, [b.id, shared]);
  const kept = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,status,transcript,summary,recording_url,
      transcript_data) VALUES($1,'+15555550401',$2,$3,'ready','Caller: 500 per unit','Agreed 500','https://api.twilio.com/secret-path','{"words":[]}')
    RETURNING id`, [a.id, shared, contactA.id])).rows[0];
  const gone = (await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,deleted_at,provider_deletion_status)
    VALUES($1,'','','deleted',now(),'confirmed') RETURNING id`, [a.id])).rows[0];
  await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,summary) VALUES($1,'+1',$2,'ready','B secret summary')`, [b.id, shared]);
  await db.query(`INSERT INTO google_connections(user_id,kind,encrypted_tokens) VALUES($1,'calendar','SECRET-TOKENS')`, [a.id]);
  await db.query(`INSERT INTO audit_events(user_id,action) VALUES($1,'signed_in')`, [a.id]);

  const response = await exportFor(a.token);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="dimts-export-\d{4}-\d{2}-\d{2}\.json"$/);
  const text = await response.text(), data = JSON.parse(text);
  assert.equal(data.format, 'dimts-export-v1');
  assert.equal(data.profile.phone, '+15555550401');
  assert.deepEqual(data.calls.map(c => c.id), [kept.id]);
  assert.equal(data.calls[0].audio_path, `/api/calls/${kept.id}/audio`);
  assert.equal(data.calls[0].summary, 'Agreed 500');
  assert.deepEqual(data.deletions.map(d => d.id), [gone.id]);
  assert.deepEqual(data.contacts.map(c => c.display_name), ['Abebe']);
  assert.deepEqual(data.google_connections, [{ kind: 'calendar', connected_at: data.google_connections[0].connected_at }]);
  assert.ok(data.audit_events.some(e => e.action === 'signed_in'));
  assert.match(data.README, /audio_path/);
  for (const secret of ['SECRET-TOKENS', 'B private name', 'B secret summary', b.id, 'token_hash', 'secret-path', 'ip_hash'])
    assert.ok(!text.includes(secret), `export leaked ${secret}`);
  const audited = (await db.query("SELECT count(*)::int n FROM audit_events WHERE user_id=$1 AND action='data_exported'", [a.id])).rows[0].n;
  assert.equal(audited, 1);
});

test('exports are limited to five an hour', async () => {
  const c = await signedIn('+15555550403');
  for (let i = 0; i < 5; i++) assert.equal((await exportFor(c.token)).status, 200);
  assert.equal((await exportFor(c.token)).status, 429);
});

test('an export needs a signed-in user', async () => {
  assert.equal((await fetch(origin + '/api/me/export')).status, 401);
});
