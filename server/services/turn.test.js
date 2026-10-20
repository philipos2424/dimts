import test from 'node:test';
import assert from 'node:assert/strict';
import { getIceServers } from './turn.js';

const env = { CLOUDFLARE_TURN_KEY_ID: 'key123', CLOUDFLARE_TURN_API_TOKEN: 'secret-token-value' };
const servers = [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }];
const ok = body => async () => ({ ok: true, status: 200, json: async () => body });

test('asks Cloudflare for one-hour credentials with the bearer token and returns the ice servers', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ iceServers: servers }) }; };
  assert.deepEqual(await getIceServers({ env, fetchImpl }), servers);
  assert.equal(seen.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer secret-token-value');
  assert.deepEqual(JSON.parse(seen.init.body), { ttl: 3600 });
  assert.ok(seen.init.signal, 'has a timeout signal');
});

test('a single ice server object is wrapped into an array', async () => {
  assert.deepEqual(await getIceServers({ env, fetchImpl: ok({ iceServers: servers[1] }) }), [servers[1]]);
});

test('missing configuration is turn_unavailable and never calls Cloudflare', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  for (const bad of [{}, { CLOUDFLARE_TURN_KEY_ID: 'k' }, { CLOUDFLARE_TURN_API_TOKEN: 't' }]) {
    await assert.rejects(getIceServers({ env: bad, fetchImpl }), { status: 503, code: 'turn_unavailable' });
  }
  assert.equal(called, false);
});

test('provider failures and malformed answers are turn_unavailable and never expose the token', async () => {
  const cases = [
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => { throw new Error('network down for Bearer secret-token-value'); },
    ok({}), ok({ iceServers: [] }), ok({ iceServers: [{ username: 'x' }] }), ok({ iceServers: [{ urls: 5 }] }), ok({ iceServers: 'x' }),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
  ];
  for (const fetchImpl of cases) {
    const err = await getIceServers({ env, fetchImpl }).then(() => null, e => e);
    assert.equal(err?.status, 503);
    assert.equal(err.code, 'turn_unavailable');
    assert.ok(!String(err.message).includes('secret-token-value'));
  }
});

test('a hung provider is abandoned after the timeout', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const started = Date.now();
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout timers are unref'd; a real socket keeps the loop alive
  await assert.rejects(getIceServers({ env, fetchImpl, timeoutMs: 30 }), { code: 'turn_unavailable' });
  clearTimeout(keepAlive);
  assert.ok(Date.now() - started < 2000);
});
