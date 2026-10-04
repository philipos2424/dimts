import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
process.env.CARRIER = 'telnyx';
process.env.TELNYX_API_KEY = 'KEYtest';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
const telnyx = [];
let verifyStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.telnyx.com/')) {
    telnyx.push({ url: String(url), body: JSON.parse(init.body) });
    const status = String(url).endsWith('/actions/verify') ? verifyStatus : 200;
    return new Response(JSON.stringify(status === 200 ? { data: {} } : { errors: [{ detail: 'bad code' }] }), { status });
  }
  return realFetch(url, init);
};
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { globalThis.fetch = realFetch; await new Promise(r => server.close(r)); await db.close(); delete process.env.CARRIER; });

async function signedIn(phone) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [phone])).rows[0];
  const token = randomBytes(32).toString('hex');
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [createHash('sha256').update(token).digest('hex'), user.id]);
  return { id: user.id, token };
}
const api = (path, token, method = 'GET', body) => realFetch(origin + path, { method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));

test('the owner verifies their own mobile by a call code, then outgoing calls may show it; turning it off stops that', async () => {
  const owner = await signedIn('+251953405253');
  assert.equal((await api('/api/me', owner.token)).body.caller_id, false);
  const started = await api('/api/me/caller-id/start', owner.token, 'POST', { method: 'call' });
  assert.equal(started.status, 202);
  assert.deepEqual(telnyx[0], { url: 'https://api.telnyx.com/v2/verified_numbers', body: { phone_number: '+251953405253', verification_method: 'call' } });
  verifyStatus = 400;
  assert.equal((await api('/api/me/caller-id/verify', owner.token, 'POST', { code: '000000' })).status, 401);
  assert.equal((await api('/api/me', owner.token)).body.caller_id, false, 'a wrong code changes nothing');
  verifyStatus = 200;
  const verified = await api('/api/me/caller-id/verify', owner.token, 'POST', { code: '123456' });
  assert.equal(verified.status, 200);
  assert.match(telnyx.at(-1).url, /\/verified_numbers\/%2B251953405253\/actions\/verify$/);
  assert.deepEqual(telnyx.at(-1).body, { verification_code: '123456' });
  assert.equal((await api('/api/me', owner.token)).body.caller_id, true);
  assert.equal((await api('/api/me/caller-id', owner.token, 'DELETE')).status, 200);
  assert.equal((await api('/api/me', owner.token)).body.caller_id, false);
});
