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
