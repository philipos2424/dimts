import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecordIncoming } from './incoming-recording.js';

test('by default every incoming call is recorded', () => {
  assert.equal(shouldRecordIncoming({}, null), true);
  assert.equal(shouldRecordIncoming({ incoming_recording: 'all' }, { recording_pref: 'default' }), true);
});

test('in "chosen" mode only callers marked Record are recorded', () => {
  const owner = { incoming_recording: 'chosen' };
  assert.equal(shouldRecordIncoming(owner, { recording_pref: 'default' }), false);
  assert.equal(shouldRecordIncoming(owner, null), false);
  assert.equal(shouldRecordIncoming(owner, { recording_pref: 'record' }), true);
});

test('a caller marked Skip is never recorded, whatever the default', () => {
  assert.equal(shouldRecordIncoming({ incoming_recording: 'all' }, { recording_pref: 'skip' }), false);
});
