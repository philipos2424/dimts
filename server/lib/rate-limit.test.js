import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
process.env.SKIP_TWILIO_SIGNATURE_CHECK = 'true';
const webRoot = await mkdtemp(join(tmpdir(), 'dimts-web-'));
await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Dimts</title>');
const { createApp } = await import('../create-app.js');
const { hit } = await import('./rate-limit.js');
const server = createApp({ webRoot }).listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
const get = (path, headers = {}) => fetch(origin + path, { headers });

test('hit allows the maximum and refuses the next request with a retry hint', async () => {
  for (let i = 0; i < 3; i++) await hit('unit:key', 3, 60);
  await assert.rejects(hit('unit:key', 3, 60), err => err.status === 429 && err.code === 'too_many_requests'
    && Number.isInteger(err.retryAfter) && err.retryAfter >= 1 && err.retryAfter <= 60);
  await assert.doesNotReject(hit('unit:other', 3, 60));
});

test('each session gets 120 API requests a minute; another session is unaffected', async () => {
  const a = { Authorization: 'Bearer ' + 'a'.repeat(64) }, b = { Authorization: 'Bearer ' + 'b'.repeat(64) };
  for (let i = 0; i < 120; i++) assert.notEqual((await get('/api/me', a)).status, 429, `request ${i + 1}`);
  const limited = await get('/api/me', a);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
  assert.notEqual((await get('/api/me', b)).status, 429);
});

test('unauthenticated API callers get 30 requests a minute per IP; Twilio routes are never limited', async () => {
  for (let i = 0; i < 30; i++) assert.notEqual((await get('/api/usage')).status, 429, `request ${i + 1}`);
  assert.equal((await get('/api/usage')).status, 429);
  for (let i = 0; i < 40; i++) {
    const response = await fetch(origin + '/webhooks/no-such-hook', { method: 'POST' });
    assert.notEqual(response.status, 429);
  }
});

test('every response carries security headers; the web shell also gets a strict CSP', async () => {
  for (const path of ['/health', '/api/unknown-route']) {
    const response = await get(path);
    assert.match(response.headers.get('strict-transport-security') ?? '', /max-age=\d+/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  }
  const shell = await get('/', { Accept: 'text/html' });
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(shell.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
});
