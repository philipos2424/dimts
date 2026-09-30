import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
process.env.PUBLIC_BASE_URL = 'https://caller.example.com';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, params) => db.query(sql, params),
  queryOne: async (sql, params) => (await db.query(sql, params)).rows[0],
  withTransaction: work => db.transaction(work),
} });
const { createApp } = await import('../create-app.js');
const app = createApp();
const tokens = ['a'.repeat(64), 'b'.repeat(64)];
for (const [index, token] of tokens.entries()) {
  const user = (await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id', [`+1555555010${index + 1}`])).rows[0];
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [createHash('sha256').update(token).digest('hex'), user.id]);
}
await db.query("INSERT INTO agent_number_pool(phone,provider_sid,voice_url) VALUES('+15555550105','PN_TEST','https://caller.example.com/twiml/incoming')");
test.after(() => db.close());
async function request(token, path = '/api/me/number', method = 'POST') {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {},
      ...(method === 'POST' ? { body: JSON.stringify({ agent_number: '+15555550999', user_id: 'forged' }) } : {}),
    });
    return { status: res.status, data: await res.json() };
  } finally { server.close(); }
}
test('only a real authenticated owner can claim; forged fields and retries cannot change ownership', async () => {
  assert.equal((await request(null)).status, 401);
  const first = await request(tokens[0]);
  assert.equal(first.status, 200);
  assert.equal(first.data.agent_number, '+15555550105');
  assert.deepEqual((await request(tokens[0])).data, first.data);
  assert.equal((await request(tokens[1])).status, 409);
  assert.equal((await request(tokens[1], '/api/me', 'GET')).data.agent_number, null);
  assert.equal((await request(tokens[0], '/api/me', 'GET')).data.agent_number, '+15555550105');
});
