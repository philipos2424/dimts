import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSummary } from './summarize.js';

test('parses a well-formed business summary', () => {
  const result = parseSummary(
    JSON.stringify({
      summary: 'Phili from Amax wants pricing for 200 units.',
      next_moves: ['Send the volume price list', 'Confirm the Tuesday call'],
      action_items: [{ task: 'Send pricing', owner: 'me' }],
      key_points: ['200 units', 'Budget approved'],
    })
  );

  assert.deepEqual(result.next_moves, [
    'Send the volume price list',
    'Confirm the Tuesday call',
  ]);
  assert.deepEqual(result.action_items, [{ task: 'Send pricing', owner: 'me' }]);
  assert.deepEqual(result.key_points, ['200 units', 'Budget approved']);
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

test('defaults next_moves to an empty list when absent', () => {
  const result = parseSummary(JSON.stringify({ summary: 'Short call.' }));
  assert.deepEqual(result.next_moves, []);
});

test('ignores a non-array next_moves', () => {
  const result = parseSummary(
    JSON.stringify({ summary: 'x', next_moves: 'call them back' })
  );
  assert.deepEqual(result.next_moves, []);
});

test('drops blank next_moves entries', () => {
  const result = parseSummary(
    JSON.stringify({ summary: 'x', next_moves: ['Send pricing', '', null] })
  );
  assert.deepEqual(result.next_moves, ['Send pricing']);
});
