import test from 'node:test';
import assert from 'node:assert/strict';
import { notesReadyTimings } from './notes-timing.js';

const hangup = new Date('2026-10-18T12:00:00Z');

test('reports how long the owner waited after hanging up, and where the time went', () => {
  assert.deepEqual(notesReadyTimings({
    completedAt: hangup, startedAtMs: hangup.getTime() + 8_000,
    transcribeMs: 11_400.6, summaryMs: 19_000, nowMs: hangup.getTime() + 41_500,
  }), {
    seconds_after_hangup: 42, queue_seconds: 8, processing_seconds: 34,
    transcribe_seconds: 11, summary_seconds: 19,
  });
});

test('a reused transcript reports no transcription time', () => {
  const timings = notesReadyTimings({ completedAt: hangup, startedAtMs: hangup.getTime(),
    transcribeMs: null, summaryMs: 5_000, nowMs: hangup.getTime() + 6_000 });
  assert.equal('transcribe_seconds' in timings, false);
  assert.equal(timings.summary_seconds, 5);
});

test('an unknown hang-up time leaves out only the waits that depend on it', () => {
  assert.deepEqual(notesReadyTimings({ completedAt: null, startedAtMs: 1_000,
    transcribeMs: 2_000, summaryMs: 3_000, nowMs: 7_000 }), {
    processing_seconds: 6, transcribe_seconds: 2, summary_seconds: 3,
  });
});

test('clock skew never reports a negative wait', () => {
  const timings = notesReadyTimings({ completedAt: new Date(hangup.getTime() + 5_000),
    startedAtMs: hangup.getTime(), transcribeMs: 0, summaryMs: 0, nowMs: hangup.getTime() + 1_000 });
  assert.equal(timings.seconds_after_hangup, 0);
  assert.equal(timings.queue_seconds, 0);
});
