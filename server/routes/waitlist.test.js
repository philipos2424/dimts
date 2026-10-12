import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
test.beforeEach(async () => { await db.query('DELETE FROM waitlist'); await db.query('DELETE FROM rate_limits'); });

const post = (body, headers = {}) => fetch(origin + '/api/waitlist', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const rows = async () => (await db.query('SELECT * FROM waitlist ORDER BY email')).rows;

test('a valid email joins the list once, lower-cased, with its details', async () => {
  const response = await post({ email: ' Sam@Example.COM ', platform: 'iphone', work: 'Real estate', country: 'gb', source: 'home' });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: 'listed' });
  const [row] = await rows();
  assert.equal(row.email, 'sam@example.com');
  assert.equal(row.platform, 'iphone');
  assert.equal(row.work, 'Real estate');
  assert.equal(row.country, 'GB');
});

test('joining again answers the same and keeps one row, filling in new details', async () => {
  await post({ email: 'sam@example.com' });
  const again = await post({ email: 'sam@example.com', platform: 'android' });
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), { status: 'listed' });
  const list = await rows();
  assert.equal(list.length, 1);
  assert.equal(list[0].platform, 'android');
});

test('an address that is not an email is refused with a fix', async () => {
  for (const email of ['', 'sam', 'sam@example', 'a b@example.com', 42]) {
    const response = await post({ email });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_email');
  }
  assert.equal((await rows()).length, 0);
});

test('an unknown platform is stored as empty rather than refused', async () => {
  await post({ email: 'sam@example.com', platform: 'blackberry' });
  assert.equal((await rows())[0].platform, null);
});

test('a filled hidden field looks accepted but stores nothing', async () => {
  const response = await post({ email: 'bot@example.com', company: 'Spam Inc' });
  assert.equal(response.status, 202);
  assert.equal((await rows()).length, 0);
});

test('one address can only add ten emails an hour', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await post({ email: `p${i}@example.com` })).status, 202);
  assert.equal((await post({ email: 'p10@example.com' })).status, 429);
});

test('the marketing site origin gets CORS headers; other origins do not', async () => {
  const allowed = await fetch(origin + '/api/waitlist', { method: 'OPTIONS', headers: { Origin: 'https://dimts.app' } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://dimts.app');
  const other = await post({ email: 'sam@example.com' }, { Origin: 'https://evil.example' });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});
