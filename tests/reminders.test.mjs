// Run with: node --experimental-strip-types --test tests/reminders.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { dueLabel, reminderTime } from '../src/reminderTime.ts';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('a promise due on a later day is reminded at 6 pm the evening before', () => {
  assert.deepEqual(reminderTime('2026-10-09T12:00', at(2026, 10, 7, 10)), at(2026, 10, 8, 18));
  assert.deepEqual(reminderTime('2026-10-09', at(2026, 10, 7, 10)), at(2026, 10, 8, 18));
});

test('a promise made after 6 pm the evening before is reminded 2 hours before its time', () => {
  assert.deepEqual(reminderTime('2026-10-08T12:00', at(2026, 10, 7, 20)), at(2026, 10, 8, 10));
  // "by 5 today", promised at 1 pm
  assert.deepEqual(reminderTime('2026-10-07T17:00', at(2026, 10, 7, 13)), at(2026, 10, 7, 15));
});

test('a bare date promised too late for the evening before is reminded at 9 am on the day', () => {
  assert.deepEqual(reminderTime('2026-10-08', at(2026, 10, 7, 21)), at(2026, 10, 8, 9));
});

test('no reminder for a passed deadline, a passed fallback, or nonsense', () => {
  assert.equal(reminderTime('2026-10-07T12:00', at(2026, 10, 7, 13)), null);
  assert.equal(reminderTime('2026-10-07T14:00', at(2026, 10, 7, 13)), null);
  assert.equal(reminderTime('tomorrow', at(2026, 10, 7, 13)), null);
});

test('due labels read like a person would say them', () => {
  const now = at(2026, 10, 7, 9);
  assert.equal(dueLabel('2026-10-07T17:00', now), 'Today 17:00');
  assert.equal(dueLabel('2026-10-08', now), 'Tomorrow');
  assert.equal(dueLabel('2026-10-06', now), 'Yesterday');
  assert.match(dueLabel('2026-10-09T15:00', now), /^Fri,? 9 Oct 15:00$/);
});
