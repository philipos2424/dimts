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

const { adoptExtractedName, findOrCreateContact, touchLastCall } =
  await import('./contacts.js');

test.beforeEach(() => {
  statements.length = 0;
  nextRows = [];
});

test('findOrCreateContact upserts on (user_id, phone)', async () => {
  nextRows = [{ id: 'c1', phone: '+14155552671', display_name: null }];

  const contact = await findOrCreateContact('u1', '+1 (415) 555-2671');

  assert.equal(contact.id, 'c1');
  assert.match(statements[0].text, /ON CONFLICT \(user_id, phone\) DO UPDATE/);
  // The number is normalised before it reaches the database.
  assert.deepEqual(statements[0].params, ['u1', '+14155552671']);
});

test('findOrCreateContact rejects an unusable phone number', async () => {
  await assert.rejects(() => findOrCreateContact('u1', 'anonymous'), /phone/i);
  assert.equal(statements.length, 0);
});

test('adoptExtractedName only writes when the name is not user-set', async () => {
  await adoptExtractedName('c1', { name: 'Phili', company: 'Amax', confidence: 0.9 });

  assert.match(statements[0].text, /UPDATE contacts/);
  assert.match(statements[0].text, /name_source <> 'user'/);
  assert.deepEqual(statements[0].params, ['c1', 'Phili', 'Amax', 0.9]);
});

test('touchLastCall stamps the contact', async () => {
  await touchLastCall('c1');
  assert.match(statements[0].text, /UPDATE contacts SET last_call_at = now\(\)/);
  assert.deepEqual(statements[0].params, ['c1']);
});
