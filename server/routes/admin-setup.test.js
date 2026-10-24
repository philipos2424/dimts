import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
mock.module('../db/pool.js', { namedExports: {
  query: (sql, p) => db.query(sql, p), queryOne: async (sql, p) => (await db.query(sql, p)).rows[0],
  withTransaction: work => db.transaction(work), getPool: () => ({}),
} });
process.env.ADMIN_PHONES = '+15555550100';
process.env.PUBLIC_BASE_URL = 'https://dimts.example';
// The WebAuthn cryptography is the library's job; these tests cover what Dimts does around it.
const webauthn = { verified: true, challenge: 'challenge-1', holders: 0 };
// With `holders` set, verification waits until that many requests have reached it, so a test can
// make every holder of a link pass the "unused" check before any of them consumes it.
const waiting = [];
mock.module('@simplewebauthn/server', { namedExports: {
  generateRegistrationOptions: async () => ({ challenge: webauthn.challenge, user: { id: 'dXNlcg' } }),
  generateAuthenticationOptions: async () => ({ challenge: webauthn.challenge }),
  verifyRegistrationResponse: async () => {
    if (webauthn.holders) await new Promise(resolve => {
      waiting.push(resolve);
      if (waiting.length >= webauthn.holders) waiting.splice(0).forEach(release => release());
    });
    return { verified: webauthn.verified,
      registrationInfo: { credential: { id: 'credential-abc', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } } };
  },
  verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 1 } }),
} });
const clientData = challenge => Buffer.from(JSON.stringify({ challenge })).toString('base64url');
const { createApp } = await import('../create-app.js');
const server = createApp().listen(0), origin = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await new Promise(r => server.close(r)); await db.close(); });

const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));
const PHONE = '+15555550100', SECRET = 'a'.repeat(64);
const inSeconds = seconds => Math.floor(Date.now() / 1000) + seconds;
const useToken = (expires, secret = SECRET) => { process.env.ADMIN_SETUP_TOKEN = expires === undefined ? `${PHONE}:${secret}` : `${PHONE}:${secret}:${expires}`; };
const options = (secret = SECRET) => post('/api/admin/setup/options', { setup: secret });
async function finish(challenge, secret = SECRET) {
  webauthn.challenge = challenge;
  assert.equal((await options(secret)).status, 200, 'options issued');
  return () => post('/api/admin/setup', { setup: secret, credential: { id: 'credential-abc', response: { clientDataJSON: clientData(challenge) } } });
}
const reset = async () => {
  delete process.env.ADMIN_SETUP_TOKEN; webauthn.verified = true; webauthn.holders = 0;
  await db.exec('DELETE FROM admin_passkeys; DELETE FROM admin_challenges; DELETE FROM audit_events');
  await db.query('DELETE FROM admin_setup_links').catch(() => {});
};
test.beforeEach(reset);

test('a setup link needs an expiry, and not one further than a week away', async () => {
  useToken(undefined);
  assert.equal((await options()).status, 404, 'no expiry: looks like nothing is there');
  useToken(inSeconds(30 * 86_400));
  assert.equal((await options()).status, 404, 'a month away is not a short-lived link');
  useToken('soon');
  assert.equal((await options()).status, 404, 'a malformed expiry is refused');
  useToken(inSeconds(3600));
  assert.equal((await options()).status, 200);
});

test('an expired setup link is refused, and says it expired', async () => {
  useToken(inSeconds(-60));
  const { status, body } = await options();
  assert.deepEqual([status, body.error], [410, 'link_expired']);
  const done = await post('/api/admin/setup', { setup: SECRET, credential: { id: 'credential-abc', response: { clientDataJSON: clientData('x') } } });
  assert.deepEqual([done.status, done.body.error], [410, 'link_expired']);
});

test('a used link stays used after the audit log is emptied (retention, or a failed audit write)', async () => {
  useToken(inSeconds(3600));
  const submit = await finish('first');
  assert.equal((await submit()).status, 200);
  await db.exec('DELETE FROM audit_events');
  const again = await options();
  assert.deepEqual([again.status, again.body.error], [410, 'link_used']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM admin_setup_links')).rows[0].n, 1, 'a durable record of the use');
});

test('two holders of the same link cannot both enrol: exactly one succeeds and one passkey is stored', async () => {
  useToken(inSeconds(3600));
  const first = await finish('challenge-one'), second = await finish('challenge-two');
  webauthn.holders = 2;
  const results = await Promise.all([first(), second()]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 410]);
  assert.equal(results.find(r => r.status === 410).body.error, 'link_used');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM admin_passkeys')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM admin_setup_links')).rows[0].n, 1);
});

test('a passkey that fails verification does not use up the link', async () => {
  useToken(inSeconds(3600));
  webauthn.verified = false;
  assert.equal((await (await finish('bad-one'))()).status, 400);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM admin_setup_links')).rows[0].n, 0);
  webauthn.verified = true;
  assert.equal((await (await finish('good-one'))()).status, 200, 'the same link still works for a real attempt');
});

test('a link used before this change (recorded only in the audit log) is still refused', async () => {
  useToken(inSeconds(3600));
  const linkId = createHash('sha256').update(SECRET).digest('hex').slice(0, 16);
  await db.query(`INSERT INTO audit_events(action,target_type,target_id) VALUES('admin_setup_link_used','setup_link',$1)`, [linkId]);
  const { status, body } = await options();
  assert.deepEqual([status, body.error], [410, 'link_used']);
});

test('the generator makes a value the server accepts, with an expiry, and refuses an absurd one', async () => {
  const { newSetupToken, parseSetupToken } = await import('../lib/admin-setup.js');
  const made = newSetupToken(PHONE, { hours: 2 });
  assert.match(made.secret, /^[a-f0-9]{64}$/);
  assert.ok(Math.abs(made.expiresAt.getTime() - (Date.now() + 2 * 3_600_000)) < 5000);
  assert.equal(made.env, `${PHONE}:${made.secret}:${Math.floor(made.expiresAt.getTime() / 1000)}`);
  assert.deepEqual(parseSetupToken(made.env)?.phone, PHONE);
  process.env.ADMIN_SETUP_TOKEN = made.env;
  assert.equal((await options(made.secret)).status, 200, 'what the generator prints is what the server accepts');
  assert.throws(() => newSetupToken(PHONE, { hours: 24 * 30 }), /hours/i);
  assert.throws(() => newSetupToken('0911', { hours: 1 }), /phone/i);
  assert.equal(parseSetupToken(`${PHONE}:${SECRET}`), null);
});
