const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const privacy = require('../server/lib/sentry-privacy.cjs');

function load(dsn, platform = 'ios') {
  const initialized = [], wrapped = [];
  const Sentry = {
    init: options => initialized.push(options),
    wrap: component => { wrapped.push(component); return 'wrapped'; },
    reactNativeErrorHandlersIntegration: () => ({ name: 'native-js-errors' }),
    browserGlobalHandlersIntegration: () => ({ name: 'browser-js-errors' }),
  };
  const code = ts.transpileModule(readFileSync(require.resolve('../src/sentry.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, process: { env: { EXPO_PUBLIC_SENTRY_DSN: dsn } },
    require: name => {
      if (name === '@sentry/react-native') return Sentry;
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === '../server/lib/sentry-privacy.cjs') return privacy;
      throw new Error('Unexpected import');
    },
  });
  return { ...exports, initialized, wrapped };
}

test('app monitoring and wrapping are inert without an EU DSN', () => {
  for (const dsn of [undefined, '', 'https://abcdef@o123.ingest.us.sentry.io/456']) {
    const app = load(dsn), component = () => null;
    app.initSentry();
    assert.equal(app.initialized.length, 0);
    assert.equal(app.wrapWithSentry(component), component);
    assert.equal(app.wrapped.length, 0);
  }
});

test('native and web JS errors share the tested scrubber; native/replay/log side channels are off', () => {
  for (const platform of ['ios', 'android', 'web']) {
    const app = load('https://abcdef@o123.ingest.de.sentry.io/456', platform);
    app.initSentry();
    assert.equal(app.initialized.length, 1);
    const options = app.initialized[0];
    assert.equal(options.beforeSend, privacy.beforeSend);
    for (const key of ['sendDefaultPii', 'defaultIntegrations', 'enableNative', 'enableAutoSessionTracking', 'enableLogs', 'sendClientReports']) assert.equal(options[key], false, key);
    for (const key of ['maxBreadcrumbs', 'tracesSampleRate', 'replaysSessionSampleRate', 'replaysOnErrorSampleRate']) assert.equal(options[key], 0, key);
    assert.equal(options.beforeBreadcrumb({ message: 'private' }), null);
    assert.equal(options.integrations[0].name, platform === 'web' ? 'browser-js-errors' : 'native-js-errors');
    assert.equal(app.wrapWithSentry(() => null), 'wrapped');
  }
});

test('Expo source-map steps are opt-in and never put the auth token in app config', () => {
  const source = readFileSync(require.resolve('../app.config.js'), 'utf8');
  for (const token of [undefined, 'private-token']) {
    const sandbox = { module: { exports: {} }, process: { env: { SENTRY_AUTH_TOKEN: token, SENTRY_ORG: 'org', SENTRY_PROJECT: 'app' } } };
    vm.runInNewContext(source, sandbox);
    const config = sandbox.module.exports({ config: { plugins: ['expo-router'] } });
    assert.equal(config.plugins[0], 'expo-router');
    assert.equal(config.plugins.length, token ? 2 : 1);
    assert.doesNotMatch(JSON.stringify(config), /private-token/);
  }
});

test('app hook preserves clean bounded frames and matching bundle Debug IDs on every platform', () => {
  const debug_id = '11111111-1111-4111-8111-111111111111';
  for (const platform of ['ios', 'android', 'web']) {
    const app = load('https://abcdef@o123.ingest.de.sentry.io/456', platform);
    app.initSentry();
    const filename = platform === 'ios' ? 'app:///main.jsbundle'
      : platform === 'android' ? 'app:///index.android.bundle' : 'app:///_expo/static/js/web/entry-abcdef.js';
    const frames = Array.from({ length: 55 }, () => ({ filename, function: 'App.render', lineno: 1,
      colno: 1024, in_app: true, vars: { token: 'SECRET' }, context_line: 'SECRET',
      pre_context: ['SECRET'], post_context: ['SECRET'], module_metadata: { token: 'SECRET' } }));
    frames.push({ filename: 'C:\\Users\\Private\\dimts\\src\\sentry.ts?token=SECRET', function: 'initSentry' });
    frames.push({ filename: 'https://private.test/transcript?token=SECRET', function: 'anonymous.SECRET' });
    const clean = app.initialized[0].beforeSend({ message: 'SECRET', stacktrace: { frames },
      debug_meta: { images: [{ type: 'sourcemap', code_file: `${filename}?token=SECRET`, debug_id, debug_file: 'SECRET' }] } });
    assert.equal(clean.message, '[redacted]');
    assert.equal(clean.stacktrace.frames.length, 50);
    assert.deepEqual(clean.stacktrace.frames[0], { filename, function: 'App.render', lineno: 1, colno: 1024, in_app: true });
    assert.deepEqual(clean.stacktrace.frames[48], { filename: 'src/sentry.ts', function: 'initSentry' });
    assert.deepEqual(clean.stacktrace.frames[49], { filename: '[redacted]' });
    assert.deepEqual(clean.debug_meta, { images: [{ type: 'sourcemap', code_file: filename, debug_id }] });
    assert.doesNotMatch(JSON.stringify(clean), /SECRET|Private|private\.test|Users/);
  }
});
