import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
let fail = false; const inserts = [];
mock.module('../db/pool.js', { namedExports: {
  query: async (sql, params) => { if (fail) throw new Error('database down'); inserts.push({ sql, params }); return { rows: [] }; },
} });
const { audit, ipHash } = await import('./audit.js');

test('audit never throws, even when the database is down', async () => {
  fail = true;
  await assert.doesNotReject(audit({ userId: 'u1', action: 'signed_in' }));
  fail = false;
});
test('audit writes user, action, target and a hashed IP', async () => {
  await audit({ userId: 'u1', action: 'call_deleted', targetType: 'call', targetId: 'c1', req: { ip: '203.0.113.9' } });
  const [row] = inserts.slice(-1);
  assert.match(row.sql, /INSERT INTO audit_events/);
  assert.deepEqual(row.params.slice(0, 4), ['u1', 'call_deleted', 'call', 'c1']);
  assert.match(row.params[4], /^[a-f0-9]{64}$/);
  assert.ok(!row.params.includes('203.0.113.9'));
});
test('ipHash is stable for the same address and null without one', () => {
  assert.equal(ipHash({ ip: '203.0.113.9' }), ipHash({ ip: '203.0.113.9' }));
  assert.notEqual(ipHash({ ip: '203.0.113.9' }), ipHash({ ip: '203.0.113.10' }));
  assert.equal(ipHash({}), null);
  assert.equal(ipHash(undefined), null);
});
