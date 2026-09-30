import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { claimNumberInTransaction } from './claim-number.js';

test('number claims are repeatable and exclusive, ignore wrong routing and never take the handset', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    const owner = (await db.query("INSERT INTO users(phone) VALUES('+15555550101') RETURNING id")).rows[0];
    const other = (await db.query("INSERT INTO users(phone) VALUES('+15555550102') RETURNING id")).rows[0];
    const url = 'https://caller.example.com/twiml/incoming';
    const claim = id => db.transaction(tx => claimNumberInTransaction(tx, id, url));
    await assert.rejects(claim(owner.id), { code: 'number_pool_empty' });
    await db.query(`INSERT INTO agent_number_pool(phone,provider_sid,voice_url) VALUES
      ('+15555550101','PN_HANDSET',$1), ('+15555550103','PN_WRONG','https://wrong.example.com'),
      ('+15555550104','PN_READY',$1)`, [url]);
    const pair = await Promise.all([claim(owner.id), claim(owner.id)]);
    assert.deepEqual(pair, [{ agent_number: '+15555550104' }, { agent_number: '+15555550104' }]);
    // Exclude the first user's handset as a configured operator mistake before
    // checking that the only real available number cannot be stolen.
    await db.query("UPDATE agent_number_pool SET enabled=false WHERE provider_sid='PN_HANDSET'");
    await assert.rejects(claim(other.id), { code: 'number_pool_empty' });
    assert.equal((await db.query('SELECT agent_number FROM users WHERE id=$1', [other.id])).rows[0].agent_number, null);
    await db.query("INSERT INTO agent_number_pool(phone,provider_sid,voice_url) VALUES('+15555550105','PN_SECOND',$1)", [url]);
    assert.equal((await claim(other.id)).agent_number, '+15555550105');
    assert.equal((await claim(owner.id)).agent_number, '+15555550104');
  } finally { await db.close(); }
});
