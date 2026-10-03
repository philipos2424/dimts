// Demo data for looking at the app locally. Local database only, no providers.
// Usage: DATABASE_MODE=local LOCAL_DATABASE_PATH=<dir> node scripts/dev-seed.js
import { createHash, randomBytes } from 'node:crypto';
import { query, queryOne } from '../db/pool.js';
import { TERMS_VERSION } from '../lib/terms.js';

if (process.env.DATABASE_MODE !== 'local') throw new Error('dev-seed only runs with DATABASE_MODE=local');
const language = process.argv.includes('--am') ? 'am' : 'en';
const user = await queryOne(`INSERT INTO users(phone,terms_version,terms_accepted_at,language,agent_number)
  VALUES('+15555550123',$1,now(),$2,'+15555550999')
  ON CONFLICT(phone) DO UPDATE SET terms_version=EXCLUDED.terms_version,language=EXCLUDED.language RETURNING id`, [TERMS_VERSION, language]);
const token = randomBytes(32).toString('hex');
await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
  [createHash('sha256').update(token).digest('hex'), user.id]);
await query('DELETE FROM calls WHERE user_id=$1', [user.id]);
await query('DELETE FROM contacts WHERE user_id=$1', [user.id]);

const contact = (phone, name, company) => queryOne(`INSERT INTO contacts(user_id,phone,display_name,company,name_source)
  VALUES($1,$2,$3,$4,'extracted') RETURNING id`, [user.id, phone, name, company]).then(r => r.id);
const abebe = await contact('+251911234567', 'Abebe', 'Amax Trading');
const sara = await contact('+447700900123', 'Sara', 'Northwind');
const agreement = (subject, value, said_by, quote, line, start) => ({ kind: 'price', subject, value, said_by, quote, line, start });

const call = (fields) => {
  const columns = Object.keys(fields);
  const values = Object.values(fields).map(v => (v && typeof v === 'object' ? JSON.stringify(v) : v));
  return queryOne(`INSERT INTO calls(${columns.join(',')}) VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, values).then(r => r.id);
};
const base = { user_id: user.id, user_phone: '+15555550123', status: 'ready', recording_url: 'https://api.twilio.com/demo', consent_mode: 'notice' };

const earlier = await call({ ...base, destination: '+251911234567', contact_id: abebe, direction: 'outbound', duration_sec: 420,
  created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
  transcript: 'User: Can you do 200 units?\nCaller: Fine, 500 birr per unit, 200 units.',
  summary: 'Abebe quoted 500 birr per unit for 200 units.',
  agreements: [agreement('Unit price', '500 birr', 'Caller', 'Caller: Fine, 500 birr per unit, 200 units.', 2, 271)] });
await call({ ...base, destination: '+251911234567', contact_id: abebe, direction: 'inbound', duration_sec: 734,
  transcript: 'Caller: Hello, this is Abebe from Amax.\nUser: Hi Abebe.\nCaller: We agreed 450 birr per unit, 200 units.\nUser: Delivery on Tuesday then.\nCaller: Yes, Tuesday 7 October.',
  summary: 'Abebe confirmed 200 units at 450 birr per unit with delivery on Tuesday 7 October.',
  next_moves: ['Send the invoice today'],
  action_items: [{ task: 'Send the invoice today', owner: 'User' }, { task: 'Deliver 200 units on Tuesday', owner: 'Caller' }],
  agreements: [agreement('Unit price', '450 birr', 'Caller', 'Caller: We agreed 450 birr per unit, 200 units.', 3, 192),
    { kind: 'quantity', subject: 'Units', value: '200', said_by: 'Caller', quote: 'Caller: We agreed 450 birr per unit, 200 units.', line: 3, start: 192 },
    { kind: 'date', subject: 'Delivery', value: 'Tuesday 7 October', said_by: 'Caller', quote: 'Caller: Yes, Tuesday 7 October.', line: 5, start: 468 }],
  conflicts: [{ new_index: 0, previous_call_id: earlier, previous_index: 0, note: 'The unit price is 450 birr today; on the earlier call it was 500 birr.' }],
  followups: { email: null, meeting: { title: 'Delivery - Amax', notes: '200 units', time_text: 'Tuesday 7 October', start: '', end: '', status: 'pending',
    evidence: { quotes: ['Caller: Yes, Tuesday 7 October.'], confidence: 0.9, reason: 'Both agreed the delivery day.' } } } });
await call({ ...base, destination: '+447700900123', contact_id: sara, direction: 'outbound', duration_sec: 240,
  transcript: 'User: Hi Sara.\nCaller: Could you send a proposal by Friday?',
  summary: 'Sara asked for a proposal by Friday.', action_items: [{ task: 'Send Sara the proposal by Friday', owner: 'User' }],
  agreements: [{ kind: 'deliverable', subject: 'Proposal due', value: 'Friday', said_by: 'Caller', quote: 'Caller: Could you send a proposal by Friday?', line: 2, start: 31 }],
  followups: { meeting: null, email: { subject: 'Proposal for Northwind', body: 'Hi Sara...', recipient: '', status: 'pending' } } });
await call({ ...base, destination: '+15555550177', direction: 'outbound', duration_sec: 95, status: 'failed', summary: null,
  error: 'Only one recording channel contains detectable audio. A participant may have been quiet or their audio may be missing. Play or export the saved audio; AI notes were not generated.' });
console.log(token);
process.exit(0);
