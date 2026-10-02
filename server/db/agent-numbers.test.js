import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const statements = [];
let nextRows = [];

mock.module('./pool.js', {
  namedExports: {
    query: async (text, params) => {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      return { rows: nextRows };
    },
    queryOne: async (text, params) => {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      return nextRows[0];
    },
    getPool: () => ({}),
  },
});

const { assignAgentNumber, findUserByAgentNumber } = await import('./agent-numbers.js');

test.beforeEach(() => {
  statements.length = 0;
  nextRows = [];
});

test('findUserByAgentNumber normalises before lookup', async () => {
  nextRows = [{ id: 'u1', phone: '+14155550000', agent_number: '+14155551111' }];

  const user = await findUserByAgentNumber('+1 (415) 555-1111');

  assert.equal(user.id, 'u1');
  assert.deepEqual(statements[0].params, ['+14155551111']);
  // Reservation needs the owner's terms version; deleted accounts never answer.
  assert.match(statements[0].text, /terms_version/);
  assert.match(statements[0].text, /deleted_at IS NULL/);
});

test('findUserByAgentNumber returns undefined for an unusable number', async () => {
  assert.equal(await findUserByAgentNumber('not-a-number'), undefined);
  assert.equal(statements.length, 0, 'must not hit the database');
});

test('findUserByAgentNumber returns undefined when no user owns the number', async () => {
  nextRows = [];
  assert.equal(await findUserByAgentNumber('+14155559999'), undefined);
});

test('assignAgentNumber upserts the user and stores the number', async () => {
  nextRows = [{ id: 'u1', phone: '+14155550000', agent_number: '+14155551111' }];

  const user = await assignAgentNumber('+14155550000', '+14155551111');

  assert.equal(user.agent_number, '+14155551111');
  assert.deepEqual(statements[0].params, ['+14155550000', '+14155551111']);
});

test('assignAgentNumber rejects a malformed agent number', async () => {
  await assert.rejects(
    () => assignAgentNumber('+14155550000', '415-555-1111x'),
    /E\.164/
  );
});

test('assignAgentNumber rejects a malformed user number', async () => {
  await assert.rejects(() => assignAgentNumber('nope', '+14155551111'), /E\.164/);
});
