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
  assert.deepEqual(result.action_items, [{ task: 'Send pricing', owner: 'me', due: null }]);
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
  assert.deepEqual(result.action_items, [{ task: 'Call back', owner: null, due: null }]);
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

test('agreements come back as an array, empty when the model omits them', () => {
  assert.deepEqual(parseSummary(JSON.stringify({ summary: 'Short call.' })).agreements, []);
  const raw = [{ kind: 'price', subject: 'unit price', value: '450 birr', said_by: 'Caller', source_lines: [3] }];
  assert.deepEqual(parseSummary(JSON.stringify({ summary: 'Priced.', agreements: raw })).agreements, raw);
});

test('the summary prompt asks for the user\'s language and keeps spoken values as spoken', async () => {
  const { summaryPrompt } = await import('./summarize.js');
  assert.match(summaryPrompt('am'), /in Amharic/);
  assert.match(summaryPrompt('en'), /in English/);
  assert.match(summaryPrompt('am'), /exactly as spoken/);
  assert.match(summaryPrompt('fr'), /in English/, 'unknown languages fall back to English');
});

test('due dates are kept only when they are real dates or date-times', async () => {
  const { cleanDue, parseSummary } = await import('./summarize.js');
  assert.equal(cleanDue('2026-10-08T12:00'), '2026-10-08T12:00');
  assert.equal(cleanDue('2026-10-09'), '2026-10-09');
  for (const bad of ['2026-02-30', '2026-10-08T25:00', 'tomorrow', '8/10/2026', '', null, 42]) assert.equal(cleanDue(bad), null, String(bad));
  const parsed = parseSummary(JSON.stringify({ summary: 'x', action_items: [
    { task: 'Send the quote', owner: 'User', due: '2026-10-08T12:00' }, { task: 'Call back', owner: 'Caller', due: 'soon' }] }));
  assert.deepEqual(parsed.action_items.map(i => i.due), ['2026-10-08T12:00', null]);
});

test('the model is told the call date in the owner time zone, so "tomorrow" resolves', async () => {
  const { callDateLine } = await import('./summarize.js');
  // 23:30 UTC on 7 Oct is already 8 Oct in Nairobi and still 7 Oct in New York.
  assert.match(callDateLine('2026-10-07T23:30:00Z', 'Africa/Nairobi'), /Thursday,? 8 October 2026 at 02:30/);
  assert.match(callDateLine('2026-10-07T23:30:00Z', 'America/New_York'), /Wednesday,? 7 October 2026 at 19:30/);
  assert.match(callDateLine('2026-10-07T23:30:00Z', null), /Wednesday,? 7 October 2026 at 23:30/);
});
