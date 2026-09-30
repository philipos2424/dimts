import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

const db = new PGlite();
await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const { rows: [alice] } = await db.query("INSERT INTO users (phone) VALUES ('+15555550101') RETURNING id");
const { rows: [bob] } = await db.query("INSERT INTO users (phone) VALUES ('+15555550102') RETURNING id");
const { rows: [contact] } = await db.query(`INSERT INTO contacts (user_id, phone, display_name)
  VALUES ($1, '+15555550103', 'Philip') RETURNING id`, [alice.id]);
mock.module('../db/pool.js', { namedExports: {
  query: (sql, params) => db.query(sql, params),
  queryOne: async (sql, params) => (await db.query(sql, params)).rows[0],
} });
// Authentication is tested separately; here both owners use the same real SQL.
mock.module('../lib/users.js', { namedExports: {
  resolveUser: async req => req.get('x-test-owner') === 'bob' ? bob : alice,
  HttpError: class extends Error { constructor(status, code) { super(code); this.status = status; } },
} });
const { contactsRouter, contactVCard } = await import('./contacts.js');
const app = express(); app.use(express.json()); app.use('/contacts', contactsRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
test.after(async () => db.close());
async function request(path, owner = 'alice', body) {
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/contacts${path}`, {
      method: body ? 'PATCH' : 'GET', headers: { 'x-test-owner': owner, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, text: await response.text() };
  } finally { server.close(); }
}
test('other owners cannot list, change or export the contact', async () => {
  assert.deepEqual(JSON.parse((await request('/', 'bob')).text).contacts, []);
  assert.equal((await request(`/${contact.id}`, 'bob', { display_name: 'Stolen' })).status, 404);
  assert.equal((await request(`/${contact.id}/vcard`, 'bob')).status, 404);
  assert.equal((await db.query('SELECT display_name FROM contacts WHERE id=$1', [contact.id])).rows[0].display_name, 'Philip');
});
test('owner edits become user-set names and export as a vCard', async () => {
  const result = await request(`/${contact.id}`, 'alice', { display_name: 'Philip from Amax', company: 'Amax', notes: 'Pricing contact' });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.text).name_source, 'user');
  const card = await request(`/${contact.id}/vcard`);
  assert.match(card.text, /FN:Philip from Amax/);
  assert.match(card.text, /TEL;TYPE=CELL:\+15555550103/);
});
test('vCard values cannot inject extra records through newline characters', () => {
  const card = contactVCard({ phone: '+15555550103', display_name: 'Philip\nEND:VCARD\nBEGIN:VCARD' });
  assert.equal(card.split('\r\n').filter(line => line === 'BEGIN:VCARD').length, 1);
  assert.match(card, /Philip\\nEND:VCARD\\nBEGIN:VCARD/);
});
