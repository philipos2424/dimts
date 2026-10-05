import * as database from '../db/pool.js';
import { resolveAgreements } from '../lib/agreements.js';

// A renovation contractor's last ten days: a quote, a price that changed
// between calls, a voicemail and the follow-ups they created. Numbers are in
// the 555-01xx range reserved for fiction.
const CONTACTS = {
  maria: { phone: '+15125550142', display_name: 'Maria Lopez', company: null },
  dave: { phone: '+15125550178', display_name: 'Dave Brennan', company: 'Northside Tile Supply' },
  priya: { phone: '+15125550193', display_name: 'Priya Shah', company: 'Shah Property Group' },
};

const CALLS = [
  {
    key: 'tile-quote', contact: 'dave', hoursAgo: 9 * 24 + 3, duration: 372,
    transcript: [
      "User: Hi Dave, it's Sam from Carter Kitchens. I need a price on the grey porcelain tile for the Lopez kitchen.",
      'Caller: Sure Sam. How much do you need?',
      "User: 240 square feet, plus whatever you'd add for cuts.",
      'Caller: Call it 240 even, the box count covers your cuts. I can do $6.50 a square foot on that one.',
      'User: Great. Can you deliver to the job site?',
      "Caller: Yes, I'll have it there Thursday morning.",
      'User: Perfect. Put it on the account and email me the invoice.',
      'Caller: Will do, the invoice goes out today.',
    ],
    summary: 'Dave quoted $6.50 a square foot for 240 square feet of grey porcelain tile for the Lopez kitchen. He will deliver it to the job site Thursday morning and email the invoice today.',
    next_moves: ['Check the tile arrives Thursday morning', 'Match the invoice to $6.50 a square foot'],
    action_items: [
      { task: 'Deliver the tile to the job site Thursday morning', owner: 'Caller' },
      { task: 'Email the invoice today', owner: 'Caller' },
    ],
    key_points: ['Grey porcelain tile for the Lopez kitchen', '240 square feet at $6.50 a square foot', 'Charged to the Carter Kitchens account'],
    agreements: [
      { kind: 'price', subject: 'Grey porcelain tile', value: '$6.50 a square foot', said_by: 'Caller', source_lines: [4] },
      { kind: 'quantity', subject: 'Tile order', value: '240 square feet', said_by: 'Caller', source_lines: [4] },
      { kind: 'date', subject: 'Tile delivery to the job site', value: 'Thursday morning', said_by: 'Caller', source_lines: [6] },
    ],
    done: [0, 1],
  },
  {
    key: 'kitchen-quote', contact: 'maria', hoursAgo: 7 * 24 + 5, duration: 684,
    transcript: [
      "User: Hi Maria, it's Sam. I've finished the numbers for your kitchen.",
      'Caller: Great, what are we looking at?',
      'User: The full remodel comes to $18,400. That covers cabinets, counters, tile and labour.',
      'Caller: Does that include the soft-close drawers we talked about?',
      'User: Yes, soft-close drawers on every cabinet are included.',
      'Caller: Okay, that works for us. What do you need to get started?',
      'User: A 30 percent deposit, so $5,520, and we can start on Monday the week after next.',
      'Caller: I can pay the deposit by Friday.',
      "User: Perfect. I'll email you the written quote today so you have everything in writing.",
      'Caller: Thanks Sam, talk soon.',
    ],
    summary: 'Maria accepted the $18,400 kitchen remodel, including soft-close drawers on every cabinet. She will pay the $5,520 deposit by Friday, and work starts on Monday the week after next. You promised to email her the written quote today.',
    next_moves: ['Email Maria the written quote', 'Confirm the deposit arrives by Friday', 'Book the crew for the start date'],
    action_items: [
      { task: 'Email Maria the written quote today', owner: 'User' },
      { task: 'Pay the $5,520 deposit by Friday', owner: 'Caller' },
    ],
    key_points: ['Quote covers cabinets, counters, tile and labour', 'Soft-close drawers on every cabinet are included', 'Deposit is 30 percent'],
    agreements: [
      { kind: 'price', subject: 'Kitchen remodel total', value: '$18,400', said_by: 'User', source_lines: [3] },
      { kind: 'deliverable', subject: 'Soft-close drawers', value: 'on every cabinet, included', said_by: 'User', source_lines: [5] },
      { kind: 'amount', subject: 'Deposit', value: '$5,520', said_by: 'User', source_lines: [7] },
      { kind: 'date', subject: 'Work starts', value: 'Monday the week after next', said_by: 'User', source_lines: [7] },
      { kind: 'date', subject: 'Deposit payment', value: 'by Friday', said_by: 'Caller', source_lines: [8] },
    ],
    done: [0, 1],
  },
  {
    key: 'priya-voicemail', contact: 'priya', hoursAgo: 5 * 24 + 2, duration: 41, direction: 'inbound', voicemail: true,
    transcript: [
      'Caller: Hi Sam, this is Priya Shah from Shah Property Group. I manage three rental units on Elm Street, and all three bathrooms need redoing before new tenants move in. My budget is around $9,000 per bathroom. Could you call me back to set up a walkthrough? Thanks.',
    ],
    summary: 'Priya Shah from Shah Property Group wants the bathrooms in three Elm Street rental units redone before new tenants move in. Her budget is around $9,000 per bathroom. She asked you to call back to set up a walkthrough.',
    next_moves: ['Call Priya back to book a walkthrough'],
    action_items: [],
    key_points: ['Three rental units on Elm Street', 'Budget around $9,000 per bathroom'],
    agreements: [
      { kind: 'amount', subject: 'Budget per bathroom', value: 'around $9,000', said_by: 'Caller', source_lines: [1] },
    ],
  },
  {
    key: 'priya-walkthrough', contact: 'priya', hoursAgo: 3 * 24 + 4, duration: 430,
    transcript: [
      "User: Hi Priya, it's Sam Carter returning your call about the Elm Street bathrooms.",
      'Caller: Thanks for calling back. When can you come and look?',
      'User: How about Wednesday at 10?',
      "Caller: Wednesday at 10 works. It's 418 Elm Street, I'll meet you there.",
      "User: Great. I'll send you a written estimate by Friday after I've seen them.",
      'Caller: Perfect. The tenants move in on the first, so timing matters.',
      "User: Understood, I'll plan the schedule around that.",
    ],
    summary: 'You agreed to walk through the three Elm Street bathrooms with Priya on Wednesday at 10, at 418 Elm Street. You will send her a written estimate by Friday. The tenants move in on the first, so the schedule has to fit around that.',
    next_moves: ['Add the Wednesday walkthrough to your calendar', 'Send Priya the written estimate by Friday'],
    action_items: [
      { task: 'Meet Sam at 418 Elm Street on Wednesday at 10', owner: 'Caller' },
      { task: 'Send Priya a written estimate by Friday', owner: 'User' },
    ],
    key_points: ['Walkthrough at 418 Elm Street', 'Tenants move in on the first'],
    agreements: [
      { kind: 'time', subject: 'Walkthrough', value: 'Wednesday at 10', said_by: 'Caller', source_lines: [4] },
      { kind: 'other', subject: 'Walkthrough address', value: '418 Elm Street', said_by: 'Caller', source_lines: [4] },
      { kind: 'date', subject: 'Written estimate', value: 'by Friday', said_by: 'User', source_lines: [5] },
      { kind: 'date', subject: 'Tenants move in', value: 'the first', said_by: 'Caller', source_lines: [6] },
    ],
  },
  {
    key: 'tile-invoice', contact: 'dave', hoursAgo: 26, duration: 296,
    transcript: [
      "User: Hi Dave, it's Sam. The tile arrived, thanks. But the invoice looks off.",
      "Caller: Let me look. Yeah, it's $7.10 a square foot. Prices went up at the start of the month.",
      'User: You quoted me $6.50 a square foot last week, and I priced the Lopez job on that.',
      'Caller: Fair enough. Let me talk to my manager and call you back by noon tomorrow.',
      "User: Thanks. On 240 square feet that's a $144 difference, so I need it fixed.",
      "Caller: Understood. I'll sort it out.",
    ],
    summary: "Dave's invoice charges $7.10 a square foot for the tile, not the $6.50 he quoted last week. That is $144 more on 240 square feet. He will check with his manager and call you back by noon tomorrow.",
    next_moves: ['Hold the tile invoice until it shows $6.50 a square foot', 'Call Dave if he has not called back by noon tomorrow'],
    action_items: [{ task: 'Check with his manager and call back by noon tomorrow', owner: 'Caller' }],
    key_points: ['Tile was delivered', 'Invoice says $7.10 a square foot', 'Difference is $144 on 240 square feet'],
    agreements: [
      { kind: 'price', subject: 'Grey porcelain tile', value: '$7.10 a square foot', said_by: 'Caller', source_lines: [2] },
      { kind: 'time', subject: 'Call back about the invoice', value: 'by noon tomorrow', said_by: 'Caller', source_lines: [4] },
    ],
    conflicts: [{ new_index: 0, previous: 'tile-quote', previous_index: 0,
      note: 'Dave quoted $6.50 a square foot on the earlier call; the invoice now says $7.10.' }],
  },
  {
    key: 'kitchen-change', contact: 'maria', hoursAgo: 2, duration: 251,
    transcript: [
      "User: Hi Maria, it's Sam. Got your deposit, thank you.",
      "Caller: Great. One thing, could we start a week later? We're away that Monday.",
      "User: No problem, we'll start the Monday after instead.",
      'Caller: Thanks. And could you add under-cabinet lighting?',
      'User: Sure, under-cabinet lighting is $650 extra, installed.',
      "Caller: Let's do it. Add it to the quote.",
      "User: Will do, I'll send you an updated quote tonight.",
    ],
    summary: "Maria's deposit has arrived. Work now starts one week later than planned because she is away that Monday. She added under-cabinet lighting for $650 extra, installed, and you will send her an updated quote tonight.",
    next_moves: ['Send Maria the updated quote with the $650 lighting', 'Move the crew booking one week later'],
    action_items: [{ task: 'Send Maria an updated quote tonight', owner: 'User' }],
    key_points: ['Deposit received', 'Start moved one week later', 'Under-cabinet lighting added for $650'],
    agreements: [
      { kind: 'date', subject: 'Work starts', value: 'the Monday after', said_by: 'User', source_lines: [3] },
      { kind: 'price', subject: 'Under-cabinet lighting', value: '$650 extra, installed', said_by: 'User', source_lines: [5] },
    ],
    conflicts: [{ new_index: 0, previous: 'kitchen-quote', previous_index: 3,
      note: 'The earlier call set the start for Monday the week after next; it is now one week later.' }],
  },
];

// What tapping Call produces in the review account: notes, but no phone rings.
const SAMPLE_CALL = {
  duration: 64,
  transcript: [
    "User: Hi, it's Sam from Carter Kitchens. Just confirming we're still on for Thursday.",
    "Caller: Yes, Thursday works. I'll be there from 8.",
    'User: Great, see you then.',
  ],
  summary: 'Sample call from the app review account: no phone rang, and these notes show what Dimts writes after a real call. The other person confirmed Thursday and will be there from 8.',
  next_moves: ['Add Thursday at 8 to your calendar'],
  action_items: [{ task: 'Be there Thursday from 8', owner: 'Caller' }],
  key_points: ['Thursday confirmed'],
  agreements: [{ kind: 'time', subject: 'Thursday visit', value: 'from 8', said_by: 'Caller', source_lines: [2] }],
};

async function insertCall(db, user, call, { contactId, destination, at }) {
  const transcript = call.transcript.join('\n');
  const inbound = call.direction === 'inbound';
  const { rows: [row] } = await db.query(
    `INSERT INTO calls (user_id, user_phone, destination, status, direction, voicemail, contact_id,
        duration_sec, transcript, summary, next_moves, action_items, key_points, agreements, conflicts,
        language, language_probability, record_enabled, consent_mode, other_party_notice_issued_at,
        parent_consent_at, child_consent_at, recording_start_status, created_at, completed_at)
     VALUES ($1,$2,$3,'ready',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'en',1,true,'notice',$15,
        $16,$17,'started',$15,$18) RETURNING id`,
    [user.id, user.phone, destination, inbound ? 'inbound' : 'outbound', !!call.voicemail, contactId,
      call.duration, transcript, call.summary, JSON.stringify(call.next_moves), JSON.stringify(call.action_items),
      JSON.stringify(call.key_points), JSON.stringify(resolveAgreements(call.agreements, transcript, [])),
      JSON.stringify(call.conflicts ?? []), at, inbound ? null : at, inbound ? at : null,
      new Date(at.getTime() + call.duration * 1000)]
  );
  return row.id;
}

/**
 * Put the review account back to the same sample data. Every demo sign-in
 * runs this, so one reviewer deleting calls or contacts cannot break the next.
 */
export async function resetReviewDemo(user, now = new Date()) {
  await database.withTransaction(async tx => {
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    await tx.query('DELETE FROM calls WHERE user_id=$1', [user.id]);
    await tx.query('DELETE FROM contacts WHERE user_id=$1', [user.id]);
    await tx.query('DELETE FROM usage_minutes WHERE user_id=$1', [user.id]);
    await tx.query(`UPDATE users SET tier='pro', language='en', retention_months=NULL, caller_id_verified_at=NULL
      WHERE id=$1`, [user.id]);

    const contacts = {};
    for (const [key, contact] of Object.entries(CONTACTS)) {
      const last = Math.min(...CALLS.filter(call => call.contact === key).map(call => call.hoursAgo));
      const first = Math.max(...CALLS.filter(call => call.contact === key).map(call => call.hoursAgo));
      const { rows: [row] } = await tx.query(
        `INSERT INTO contacts (user_id, phone, display_name, company, name_source, name_confidence, first_seen_at, last_call_at)
         VALUES ($1,$2,$3,$4,'user',1,$5,$6) RETURNING id`,
        [user.id, contact.phone, contact.display_name, contact.company,
          new Date(now - first * 3600_000), new Date(now - last * 3600_000)]
      );
      contacts[key] = row.id;
    }

    const ids = {};
    for (const call of CALLS) {
      const conflicts = call.conflicts?.map(({ previous, ...item }) => ({ ...item, previous_call_id: ids[previous] }));
      ids[call.key] = await insertCall(tx, user, { ...call, conflicts }, {
        contactId: contacts[call.contact], destination: CONTACTS[call.contact].phone,
        at: new Date(now - call.hoursAgo * 3600_000),
      });
      for (const index of call.done ?? []) {
        await tx.query(`INSERT INTO promise_states (call_id, item_index, status) VALUES ($1,$2,'done')`, [ids[call.key], index]);
      }
    }
  });
}

/** Tapping Call in the review account files sample notes instead of dialing. */
export async function createReviewDemoCall(user, destination) {
  const contact = await database.queryOne(
    'SELECT id FROM contacts WHERE user_id=$1 AND phone=$2', [user.id, destination]);
  const id = await insertCall(database, user, SAMPLE_CALL, { contactId: contact?.id ?? null, destination, at: new Date() });
  if (contact) await database.query('UPDATE contacts SET last_call_at=now() WHERE id=$1', [contact.id]);
  return { id, status: 'ready' };
}
