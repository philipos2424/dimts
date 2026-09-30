import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveTimeAmbiguity } from './summarize.js';
const result = { summary: 'Meet tomorrow at 2 PM.', next_moves: ['Attend at 2 PM'],
  key_points: ['2 PM meeting'], action_items: [{ task: 'Meet at 2 PM', owner: 'User' }] };
test('cannot turn an unspecified time into a definite afternoon meeting', () => {
  const cleaned = preserveTimeAmbiguity(result, 'Caller: Meet tomorrow at two?\nUser: Yes.');
  assert.match(cleaned.summary, /2 \(AM\/PM not specified\)/);
  assert.match(cleaned.action_items[0].task, /not specified/);
  assert.match(cleaned.key_points[0], /not specified/);
});
test('keeps time-of-day information that was actually stated', () => {
  assert.deepEqual(preserveTimeAmbiguity(result, 'Meet tomorrow at 2 PM.'), result);
});
