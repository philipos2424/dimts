import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSummary } from './summarize.js';

test('parses a well-formed summary', () => {
  const result = parseSummary(
    JSON.stringify({
      language: 'amh',
      summary: 'ስለ ስብሰባው ተነጋገሩ።',
      action_items: [{ task: 'ሰነዱን ላክ', owner: 'Abebe' }],
      key_points: ['ስብሰባ ሰኞ'],
    })
  );

  assert.equal(result.language, 'amh');
  assert.deepEqual(result.action_items, [{ task: 'ሰነዱን ላክ', owner: 'Abebe' }]);
  assert.deepEqual(result.key_points, ['ስብሰባ ሰኞ']);
});

test('throws on non-JSON output rather than writing garbage', () => {
  assert.throws(() => parseSummary('I could not process that.'), /not valid JSON/);
});

test('throws when the JSON is not an object', () => {
  assert.throws(() => parseSummary('["a"]'), /not an object/);
});

test('throws when summary is missing', () => {
  assert.throws(
    () => parseSummary(JSON.stringify({ language: 'eng', key_points: [] })),
    /missing a non-empty "summary"/
  );
});

test('throws when summary is blank', () => {
  assert.throws(() => parseSummary(JSON.stringify({ summary: '   ' })), /non-empty/);
});

test('tolerates missing optional fields', () => {
  const result = parseSummary(JSON.stringify({ summary: 'Short call.' }));
  assert.equal(result.language, null);
  assert.deepEqual(result.action_items, []);
  assert.deepEqual(result.key_points, []);
});

test('coerces bare-string action items into {task, owner}', () => {
  const result = parseSummary(
    JSON.stringify({ summary: 'x', action_items: ['Call back'] })
  );
  assert.deepEqual(result.action_items, [{ task: 'Call back', owner: null }]);
});

test('drops action items with no task', () => {
  const result = parseSummary(
    JSON.stringify({ summary: 'x', action_items: [{ owner: 'Sara' }] })
  );
  assert.deepEqual(result.action_items, []);
});

test('ignores a non-array action_items', () => {
  const result = parseSummary(
    JSON.stringify({ summary: 'x', action_items: 'send email' })
  );
  assert.deepEqual(result.action_items, []);
});
