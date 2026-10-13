const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');

function harness(os = 'web', result = { type: 'cancel' }) {
  const calls = [], storage = new Map(), history = [];
  const window = {
    location: { origin: 'https://dimts.example', pathname: '/onboarding', search: '' },
    history: { replaceState: (...args) => history.push(args) },
    sessionStorage: { getItem: k => storage.get(k) ?? null, removeItem: k => storage.delete(k), setItem: (k,v) => storage.set(k,v) },
  };
  const modules = {
    'react-native': { Platform: { OS: os } },
    'expo-crypto': {
      getRandomBytes: n => crypto.randomBytes(n), CryptoDigestAlgorithm: { SHA256: 'sha256' }, CryptoEncoding: { BASE64: 'base64' },
      digestStringAsync: async (algorithm, text) => crypto.createHash(algorithm).update(text).digest('base64'),
    },
    'expo-linking': { createURL: path => `dimts://${path}`, getInitialURL: async () => result.url ?? null,
      parse: text => ({ queryParams: Object.fromEntries(new URL(text).searchParams) }) },
    'expo-secure-store': { getItemAsync: async k => storage.get(k) ?? null,
      setItemAsync: async (k,v) => storage.set(k,v), deleteItemAsync: async k => storage.delete(k) },
    'expo-web-browser': { openAuthSessionAsync: async (...args) => { calls.push(['browser', ...args]); return result; } },
    './api': {
      startSocialSignIn: async (...args) => { calls.push(['start', ...args]); return { url: 'https://dimts.example/oauth/signin/begin?ticket=test' }; },
      finishSocialSignIn: async (...args) => { calls.push(['finish', ...args]); return { token: 'test-session', phone: '+14155550100' }; },
    },
  };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, window, URLSearchParams,
    require: id => { assert.ok(modules[id], id); return modules[id]; } });
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../src/socialSignIn.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new vm.Script(source).runInContext(context);
  return { api: module.exports, calls, window, storage, history };
}

test('web callback redeems only with the saved verifier and clears URL/storage', async () => {
  const h = harness(); h.window.location.search = '?social=test-ticket'; h.storage.set('dimts_social_verifier', 'saved-verifier');
  assert.equal((await h.api.resumeSocialSignIn()).token, 'test-session');
  assert.deepEqual(h.calls, [['finish', 'test-ticket', 'saved-verifier']]);
  assert.equal(h.storage.size, 0); assert.equal(h.history[0][2], '/onboarding');
});

test('web callback without local verifier does not redeem an intercepted ticket', async () => {
  const h = harness(); h.window.location.search = '?social=test-ticket';
  await assert.rejects(h.api.resumeSocialSignIn(), /expired/);
  assert.equal(h.calls.length, 0);
});

test('native cancellation never redeems a ticket', async () => {
  const h = harness('ios'); assert.equal(await h.api.socialSignIn('apple'), null);
  assert.equal(h.calls.some(c => c[0] === 'finish'), false);
});

test('native callback uses the verifier corresponding to the starting challenge', async () => {
  const h = harness('android', { type: 'success', url: 'dimts://onboarding?social=test-ticket' });
  assert.equal((await h.api.socialSignIn('google')).token, 'test-session');
  const start = h.calls.find(c => c[0] === 'start'), finish = h.calls.find(c => c[0] === 'finish');
  assert.equal(start[3], 'dimts://onboarding');
  assert.equal(crypto.createHash('sha256').update(finish[2]).digest('base64url'), start[2]);
});

test('a native cold-start callback recovers the pending verifier from secure storage', async () => {
  const h = harness('android', { url: 'dimts://onboarding?social=test-ticket' });
  h.storage.set('dimts.social.verifier', JSON.stringify({ verifier: 'saved-native-verifier', createdAt: Date.now() }));
  assert.equal((await h.api.resumeSocialSignIn()).token, 'test-session');
  assert.deepEqual(h.calls, [['finish', 'test-ticket', 'saved-native-verifier']]);
  assert.equal(h.storage.size, 0);
});

test('expired native pending state never redeems a callback', async () => {
  const h = harness('ios', { url: 'dimts://onboarding?social=test-ticket' });
  h.storage.set('dimts.social.verifier', JSON.stringify({ verifier: 'old', createdAt: Date.now() - 3600_000 }));
  await assert.rejects(h.api.resumeSocialSignIn(), /expired/);
  assert.equal(h.calls.length, 0); assert.equal(h.storage.size, 0);
});
