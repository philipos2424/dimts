import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// Vercel serves the web app shell only for paths listed in vercel.json. A screen
// missing there loads locally (Express serves it) but 404s in production.
test('every app screen is routed to the web shell on Vercel', async () => {
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const shell = config.routes.filter(route => route.dest === '/index.html').map(route => new RegExp(`^${route.src}$`));
  const appDir = new URL('../../app/', import.meta.url);
  const screens = [];
  for (const dir of ['', '(tabs)/']) {
    for (const entry of await readdir(new URL(dir, appDir), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.tsx') || entry.name.startsWith('_')) continue;
      const name = entry.name.replace(/\.tsx$/, '');
      if (name === 'index') continue; // "/" is served by the filesystem handler
      screens.push(`/${name}`);
    }
  }
  screens.push('/call/00000000-0000-4000-8000-000000000000', '/person/00000000-0000-4000-8000-000000000000');
  assert.ok(screens.includes('/plans'));
  for (const path of screens) assert.ok(shell.some(pattern => pattern.test(path)), `${path} is not routed to /index.html in vercel.json`);
});

// With legacy "routes", Vercel ignores a top-level "headers" block, so the web
// shell's security headers must ride on a route of their own.
test('the web app is served with the security headers, and server paths keep their own', async () => {
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const { WEB_SHELL_CSP } = await import('./security-headers.js');
  assert.equal(config.headers, undefined, 'top-level headers are ignored next to routes');
  const route = config.routes.find(r => r.headers?.['Content-Security-Policy']);
  assert.ok(route && route.continue === true, 'header route must continue to the real handler');
  assert.equal(config.routes.indexOf(route), 0, 'headers apply before any route answers');
  assert.equal(route.headers['Content-Security-Policy'], WEB_SHELL_CSP);
  assert.equal(route.headers['X-Frame-Options'], 'DENY');
  const pattern = new RegExp(`^${route.src}$`);
  for (const path of ['/', '/plans', '/terms-accept', '/call/00000000-0000-4000-8000-000000000000', '/_expo/static/js/web/entry.js', '/apiary'])
    assert.ok(pattern.test(path), `${path} should get the web headers`);
  for (const path of ['/api', '/api/me', '/admin/', '/admin', '/webhooks/polar', '/twiml/bridge', '/oauth/google/callback', '/health'])
    assert.ok(!pattern.test(path), `${path} sets its own headers in Express`);
});
