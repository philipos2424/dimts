import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeneratedFollowups } from './followups.js';

const transcript = 'Caller: Can we meet tomorrow at two?\nUser: Yes, tomorrow at two works.\nUser: I will email the recap tonight.';
function fixture() {
  return { email: { subject: 'Recap', body: 'Here is our recap.', evidence: { quotes: ['User: I will email the recap tonight.'], confidence: 0.9, reason: 'User promised a recap.' } },
    meeting: { title: 'Meeting', notes: 'Confirm AM/PM', time_text: 'tomorrow at two', evidence: {
      quotes: ['Caller: Can we meet tomorrow at two?', 'User: Yes, tomorrow at two works.'], confidence: 0.8, reason: 'Both speakers agreed.' } } };
}
test('generation preserves verified quotes and starts proposals pending', () => {
  const draft = parseGeneratedFollowups(JSON.stringify(fixture()), transcript);
  assert.equal(draft.email.status, 'pending');
  assert.equal(draft.meeting.status, 'pending');
  assert.equal(draft.meeting.start, '');
  assert.equal(draft.meeting.evidence.quotes[1], 'User: Yes, tomorrow at two works.');
});
test('invented quotes, malformed confidence and unsupported meeting evidence are rejected', () => {
  let data = fixture(); data.email.evidence.quotes = ['User: Send the contract now.'];
  assert.throws(() => parseGeneratedFollowups(JSON.stringify(data), transcript));
  data = fixture(); data.meeting.evidence.quotes = ['Caller: Can we meet tomorrow at two?'];
  assert.throws(() => parseGeneratedFollowups(JSON.stringify(data), transcript), /both speakers/);
  data = fixture(); data.email.evidence.confidence = 2;
  assert.throws(() => parseGeneratedFollowups(JSON.stringify(data), transcript));
  data = fixture(); delete data.email.evidence;
  assert.throws(() => parseGeneratedFollowups(JSON.stringify(data), transcript));
});
test('line references resolve to exact original speaker turns and invalid references are rejected', () => {
  const data = fixture();
  data.email.evidence = { source_lines: [3], confidence: 0.9, reason: 'Promised email.' };
  data.meeting.evidence = { source_lines: [1, 2], confidence: 0.9, reason: 'Agreed meeting.' };
  const result = parseGeneratedFollowups(JSON.stringify(data), transcript);
  assert.equal(result.email.evidence.quotes[0], 'User: I will email the recap tonight.');
  assert.equal(result.meeting.evidence.quotes[1], 'User: Yes, tomorrow at two works.');
  data.meeting.evidence.source_lines = [100];
  assert.throws(() => parseGeneratedFollowups(JSON.stringify(data), transcript), /line reference/);
});
