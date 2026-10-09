import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const initialized = [], captured = [], deferred = [];
mock.module('@sentry/node', { namedExports: {
  init: options => initialized.push(options),
  captureException: (error, context) => captured.push({ error, context }),
  flush: async () => true,
  onUncaughtExceptionIntegration: () => ({ name: 'uncaught' }),
  onUnhandledRejectionIntegration: () => ({ name: 'rejection' }),
}});
mock.module('./defer.js', { namedExports: { defer: promise => deferred.push(promise) } });

test('unset DSN is inert; EU DSN initializes privacy controls and flushes failures', async t => {
  const previous = process.env.SENTRY_DSN, carrier = process.env.CARRIER;
  t.after(() => {
    if (previous === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = previous;
    if (carrier === undefined) delete process.env.CARRIER; else process.env.CARRIER = carrier;
  });
  delete process.env.SENTRY_DSN;
  const disabled = await import('./sentry.js?disabled');
  disabled.captureCallFailure(new Error('private'));
  assert.equal(initialized.length, 0);
  assert.equal(captured.length, 0);
  assert.equal(deferred.length, 0);

  process.env.SENTRY_DSN = 'https://abcdef@o123.ingest.us.sentry.io/456';
  const invalid = await import('./sentry.js?invalid');
  invalid.captureCallFailure(new Error('private'));
  assert.equal(initialized.length, 0);
  assert.equal(captured.length, 0);

  process.env.SENTRY_DSN = 'https://abcdef@o123.ingest.de.sentry.io/456';
  process.env.CARRIER = 'telnyx';
  const enabled = await import('./sentry.js?enabled');
  assert.equal(initialized.length, 1);
  const options = initialized[0];
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.defaultIntegrations, false);
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(options.enableLogs, false);
  assert.equal(options.beforeBreadcrumb({ message: 'private' }), null);
  const raw = Object.assign(new TypeError('summary: PRIVATE +251911234567'), { detail: 'PRIVATE' });
  enabled.captureCallFailure(raw, { callId: '11111111-1111-4111-8111-111111111111', stage: 'summary' });
  assert.equal(captured.length, 1);
  assert.notEqual(captured[0].error, raw);
  assert.equal(captured[0].error.message, '[redacted]');
  assert.equal(captured[0].error.detail, undefined);
  assert.deepEqual(captured[0].context.tags, { stage: 'summary', carrier: 'telnyx', call_id: '11111111-1111-4111-8111-111111111111' });
  assert.equal(deferred.length, 1);
  await Promise.all(deferred);
});
