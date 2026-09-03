# Call Agent — Capture & Understand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record inbound and outbound business calls through a forwarding bridge, then transcribe, summarize with suggested next moves, and auto-name the contact from what the caller says about themselves.

**Architecture:** Calls route through a Twilio number owned by the user ("agent number"). An inbound TwiML route looks up the owner, plays a recording-consent announcement, then `<Dial>`s the user's real handset with dual-channel recording. The existing recording webhook, transcription and summarization pipeline is reused unchanged; two new analysis steps add next-move suggestions and caller identification. Outbound dial-through already works and is unified onto the same recording path.

**Tech Stack:** Node 22 ESM, Express 5, Twilio, PostgreSQL (Supabase) via `pg`, ElevenLabs Scribe v2, OpenAI `gpt-4o-mini`, `node:test` with `--experimental-test-module-mocks`. Mobile: Expo SDK 57, expo-router.

**Spec:** `docs/superpowers/specs/2026-09-03-call-agent-design.md`

## Global Constraints

- **The AI layer must never break a phone call.** Briefing lookup, database access and contact resolution are best-effort inside call-path routes: on failure, log and still `<Dial>` the handset. (Spec §10)
- **A human-set contact name always wins.** Auto-naming may only write when `name_source <> 'user'`. (Spec §7.4)
- **Recording consent announcement is on by default for inbound calls.** (Spec §8)
- **No test touches a live API or places a real call.** Twilio, ElevenLabs and OpenAI are mocked. (Spec §11)
- **Agent actions must be idempotent.** Reprocessing a call must never duplicate a side effect. (Spec §6)
- Server code is ESM (`"type": "module"`) and lives in `server/`, which is its own npm package with Vercel Root Directory set to it.
- Run server tests with `npm test --prefix server` (which runs `node --experimental-test-module-mocks --test`).
- Transcription failure marks the call `failed` and fires **no** downstream analysis. (Spec §10)

## Out of scope for this plan

Phase 3 (precomputed briefings, FCM full-screen push), Phase 4 (commitment extraction, date resolution, Google Calendar, earned autonomy) and Phase 5 (Gmail drafts). Each gets its own plan. Self-serve number purchasing is also deferred — numbers are assigned by an operator script (Task 2), which is sufficient for the validation cohort.

## File Structure

**Create**
- `server/lib/phone.js` — phone normalisation and E.164 validation. Single source of truth, replacing `isE164` in `originate.js`.
- `server/lib/contact-policy.js` — pure decision: may an extracted name overwrite what we already have?
- `server/db/contacts.js` — contact reads/writes. Thin SQL only; all judgement lives in `contact-policy.js`.
- `server/routes/inbound.js` — the inbound TwiML route. Owns the call-path fail-open behaviour.
- `server/services/identify.js` — LLM pass extracting caller identity from a transcript opening.
- `server/scripts/assign-number.js` — operator script assigning an agent number to a user.

**Modify**
- `server/db/schema.sql` — contacts table; `calls.direction`, `calls.contact_id`, `calls.next_moves`; `users.agent_number`.
- `server/services/originate.js` — re-export `isE164` from `lib/phone.js`; no behaviour change.
- `server/services/summarize.js` — add `next_moves` to the schema and prompt; retarget the prompt from Amharic consumer calls to English business calls.
- `server/services/process-recording.js` — run identification after summarization and adopt the contact name.
- `server/routes/webhooks.js` — make `dial-done` direction-aware.
- `server/app.js` — mount `inboundRouter`.
- `server/routes/calls.js` — return contact name and direction in list/detail.
- `app/(tabs)/index.tsx`, `app/call/[id].tsx`, `src/api.ts`, `src/i18n.ts` — surface contact names, direction and next moves.

---

### Task 1: Contacts — phone normalisation, naming policy, and store

**Files:**
- Create: `server/lib/phone.js`
- Create: `server/lib/phone.test.js`
- Create: `server/lib/contact-policy.js`
- Create: `server/lib/contact-policy.test.js`
- Create: `server/db/contacts.js`
- Create: `server/db/contacts.test.js`
- Modify: `server/db/schema.sql`
- Modify: `server/services/originate.js:13-15`

**Interfaces:**
- Consumes: `query`, `queryOne` from `server/db/pool.js`.
- Produces:
  - `normalizePhone(value: string): string | null`
  - `isE164(value: unknown): boolean`
  - `shouldAdoptName(existing: {display_name, name_source, name_confidence} | null, candidate: {name, company, confidence}): boolean`
  - `findOrCreateContact(userId: string, phone: string): Promise<Contact>`
  - `adoptExtractedName(contactId: string, {name, company, confidence}): Promise<void>`
  - `touchLastCall(contactId: string): Promise<void>`
  - `Contact = { id, user_id, phone, display_name, company, name_source, name_confidence }`

- [ ] **Step 1: Write the failing tests for phone normalisation**

Create `server/lib/phone.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { isE164, normalizePhone } from './phone.js';

test('accepts a well-formed E.164 number', () => {
  assert.equal(isE164('+14155552671'), true);
});

test('rejects numbers without a country code', () => {
  assert.equal(isE164('4155552671'), false);
});

test('rejects a leading zero after the plus', () => {
  assert.equal(isE164('+04155552671'), false);
});

test('rejects non-strings', () => {
  assert.equal(isE164(undefined), false);
  assert.equal(isE164(null), false);
  assert.equal(isE164(14155552671), false);
});

test('strips spaces, dashes and parentheses', () => {
  assert.equal(normalizePhone('+1 (415) 555-2671'), '+14155552671');
});

test('returns null for anything that is not dialable', () => {
  assert.equal(normalizePhone('unknown'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

test('preserves an already-normalised number', () => {
  assert.equal(normalizePhone('+251911234567'), '+251911234567');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/phone.test.js` from `server/`
Expected: FAIL, `Cannot find module './phone.js'`

- [ ] **Step 3: Implement phone.js**

Create `server/lib/phone.js`:

```js
/**
 * Phone handling. Twilio always delivers E.164 in `From` and `To`, so this
 * deliberately does not pull in libphonenumber - normalisation only has to
 * survive human-entered numbers from onboarding.
 */

export function isE164(value) {
  return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
}

/** Returns a dialable E.164 string, or null when the input is not one. */
export function normalizePhone(value) {
  if (typeof value !== 'string') return null;

  const stripped = value.replace(/[\s()\-.]/g, '');
  return isE164(stripped) ? stripped : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/phone.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Point originate.js at the shared helper**

In `server/services/originate.js`, delete the local `isE164` definition (the `/** Twilio's E.164 requirement... */` comment and the function beneath it) and add this near the other imports:

```js
export { isE164 } from '../lib/phone.js';
```

The re-export keeps existing importers (`routes/calls.js`) working unchanged.

- [ ] **Step 6: Verify nothing regressed**

Run: `npm test` from `server/`
Expected: PASS, all existing tests still green

- [ ] **Step 7: Write the failing tests for the naming policy**

Create `server/lib/contact-policy.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_NAME_CONFIDENCE, shouldAdoptName } from './contact-policy.js';

const candidate = { name: 'Phili', company: 'Amax', confidence: 0.9 };

test('adopts a confident name for a contact we have never named', () => {
  assert.equal(shouldAdoptName(null, candidate), true);
});

test('adopts over a previously extracted name', () => {
  const existing = { display_name: 'Phil', name_source: 'extracted', name_confidence: 0.6 };
  assert.equal(shouldAdoptName(existing, candidate), true);
});

test('never overwrites a name the user set themselves', () => {
  const existing = { display_name: 'Phili - Amax procurement', name_source: 'user', name_confidence: null };
  assert.equal(shouldAdoptName(existing, candidate), false);
});

test('does not replace a stronger extraction with a weaker one', () => {
  const existing = { display_name: 'Philippa', name_source: 'extracted', name_confidence: 0.95 };
  assert.equal(shouldAdoptName(existing, candidate), false);
});

test('rejects a candidate below the confidence floor', () => {
  assert.equal(shouldAdoptName(null, { ...candidate, confidence: MIN_NAME_CONFIDENCE - 0.01 }), false);
});

test('rejects a candidate with no name', () => {
  assert.equal(shouldAdoptName(null, { name: '', company: 'Amax', confidence: 0.99 }), false);
  assert.equal(shouldAdoptName(null, { name: null, company: null, confidence: 0.99 }), false);
});

test('rejects a missing candidate', () => {
  assert.equal(shouldAdoptName(null, null), false);
});
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `node --test lib/contact-policy.test.js`
Expected: FAIL, `Cannot find module './contact-policy.js'`

- [ ] **Step 9: Implement contact-policy.js**

Create `server/lib/contact-policy.js`:

```js
/**
 * Whether an extracted identity may become a contact's display name.
 *
 * Kept separate from the SQL because this is the rule most likely to need
 * tuning against real calls, and it is worth being able to test it without
 * a database.
 */

/** Below this, a guessed name is worse than no name at all. */
export const MIN_NAME_CONFIDENCE = 0.7;

export function shouldAdoptName(existing, candidate) {
  if (!candidate?.name || typeof candidate.name !== 'string') return false;
  if (!(candidate.confidence >= MIN_NAME_CONFIDENCE)) return false;

  if (!existing?.display_name) return true;

  // A name the user typed is ground truth; the model does not get to argue.
  if (existing.name_source === 'user') return false;

  return candidate.confidence > (existing.name_confidence ?? 0);
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `node --test lib/contact-policy.test.js`
Expected: PASS, 7 tests

- [ ] **Step 11: Add the schema changes**

Append to `server/db/schema.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Call agent: contacts, call direction, agent numbers
-- ---------------------------------------------------------------------------

-- The Twilio number a user publishes as their business line. Inbound calls
-- are matched to their owner through this column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_number TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  phone TEXT NOT NULL,
  display_name TEXT,
  company TEXT,
  name_source TEXT NOT NULL DEFAULT 'extracted',  -- user | extracted
  name_confidence FLOAT,
  notes TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_call_at TIMESTAMPTZ,
  UNIQUE (user_id, phone)
);

ALTER TABLE calls ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS next_moves JSONB;

CREATE INDEX IF NOT EXISTS calls_contact_idx ON calls (contact_id, created_at DESC);
```

- [ ] **Step 12: Apply the migration to Supabase**

Apply the SQL from Step 11 to project `gdmmlvnfiidxrqmwkqng` using the Supabase MCP `apply_migration` tool with migration name `call_agent_contacts_and_direction`.

Then verify with `list_tables` on schema `public`: expect `users`, `calls`, `usage_minutes`, `contacts`.

- [ ] **Step 13: Write the failing tests for the contacts store**

Create `server/db/contacts.test.js`:

```js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const statements = [];
let nextRows = [];

mock.module('./pool.js', {
  namedExports: {
    query: async (text, params) => {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      return { rows: nextRows };
    },
    queryOne: async (text, params) => {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      return nextRows[0];
    },
    getPool: () => ({}),
  },
});

const { adoptExtractedName, findOrCreateContact, touchLastCall } =
  await import('./contacts.js');

test.beforeEach(() => {
  statements.length = 0;
  nextRows = [];
});

test('findOrCreateContact upserts on (user_id, phone)', async () => {
  nextRows = [{ id: 'c1', phone: '+14155552671', display_name: null }];

  const contact = await findOrCreateContact('u1', '+1 (415) 555-2671');

  assert.equal(contact.id, 'c1');
  assert.match(statements[0].text, /ON CONFLICT \(user_id, phone\) DO UPDATE/);
  // The number is normalised before it reaches the database.
  assert.deepEqual(statements[0].params, ['u1', '+14155552671']);
});

test('findOrCreateContact rejects an unusable phone number', async () => {
  await assert.rejects(() => findOrCreateContact('u1', 'anonymous'), /phone/i);
  assert.equal(statements.length, 0);
});

test('adoptExtractedName only writes when the name is not user-set', async () => {
  await adoptExtractedName('c1', { name: 'Phili', company: 'Amax', confidence: 0.9 });

  assert.match(statements[0].text, /UPDATE contacts/);
  assert.match(statements[0].text, /name_source <> 'user'/);
  assert.deepEqual(statements[0].params, ['c1', 'Phili', 'Amax', 0.9]);
});

test('touchLastCall stamps the contact', async () => {
  await touchLastCall('c1');
  assert.match(statements[0].text, /UPDATE contacts SET last_call_at = now\(\)/);
  assert.deepEqual(statements[0].params, ['c1']);
});
```

- [ ] **Step 14: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test db/contacts.test.js`
Expected: FAIL, `Cannot find module './contacts.js'`

- [ ] **Step 15: Implement the contacts store**

Create `server/db/contacts.js`:

```js
import { normalizePhone } from '../lib/phone.js';
import { query, queryOne } from './pool.js';

const COLUMNS = 'id, user_id, phone, display_name, company, name_source, name_confidence';

/**
 * Get the contact for a number, creating a blank one on first contact.
 *
 * The DO UPDATE branch is a no-op write that exists only so the statement
 * returns the existing row rather than nothing on conflict.
 */
export async function findOrCreateContact(userId, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error(`Cannot create a contact for unusable phone "${phone}"`);
  }

  return queryOne(
    `INSERT INTO contacts (user_id, phone) VALUES ($1, $2)
       ON CONFLICT (user_id, phone) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING ${COLUMNS}`,
    [userId, normalized]
  );
}

/**
 * Write a model-extracted identity.
 *
 * The `name_source <> 'user'` guard is a second line of defence behind
 * shouldAdoptName: even a caller that skips the policy cannot clobber a name
 * the user typed.
 */
export async function adoptExtractedName(contactId, { name, company, confidence }) {
  await query(
    `UPDATE contacts
        SET display_name = $2,
            company = COALESCE($3, company),
            name_source = 'extracted',
            name_confidence = $4
      WHERE id = $1 AND name_source <> 'user'`,
    [contactId, name, company ?? null, confidence]
  );
}

export async function touchLastCall(contactId) {
  await query('UPDATE contacts SET last_call_at = now() WHERE id = $1', [contactId]);
}
```

- [ ] **Step 16: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test db/contacts.test.js`
Expected: PASS, 4 tests

- [ ] **Step 17: Run the whole suite and commit**

Run: `npm test` from `server/`
Expected: PASS, all tests green

```bash
git add server/lib/phone.js server/lib/phone.test.js \
        server/lib/contact-policy.js server/lib/contact-policy.test.js \
        server/db/contacts.js server/db/contacts.test.js \
        server/db/schema.sql server/services/originate.js
git commit -m "feat: contacts store, phone normalisation and name-adoption policy"
```

---

### Task 2: Agent numbers — assignment and lookup

**Files:**
- Create: `server/db/agent-numbers.js`
- Create: `server/db/agent-numbers.test.js`
- Create: `server/scripts/assign-number.js`
- Modify: `server/routes/calls.js` (add `meRouter` export)
- Modify: `server/app.js`

**Interfaces:**
- Consumes: `query`, `queryOne` from `server/db/pool.js`; `normalizePhone`, `isE164` from `server/lib/phone.js`; `resolveUser`, `HttpError` from `server/lib/users.js`.
- Produces:
  - `assignAgentNumber(userPhone: string, agentNumber: string): Promise<{id, phone, agent_number}>`
  - `findUserByAgentNumber(agentNumber: string): Promise<{id, phone, agent_number} | undefined>`
  - `meRouter` — Express router serving `GET /api/me`

- [ ] **Step 1: Write the failing tests**

Create `server/db/agent-numbers.test.js`:

```js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const statements = [];
let nextRows = [];

mock.module('./pool.js', {
  namedExports: {
    query: async (text, params) => {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      return { rows: nextRows };
    },
    queryOne: async (text, params) => {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      return nextRows[0];
    },
    getPool: () => ({}),
  },
});

const { assignAgentNumber, findUserByAgentNumber } = await import('./agent-numbers.js');

test.beforeEach(() => {
  statements.length = 0;
  nextRows = [];
});

test('findUserByAgentNumber normalises before lookup', async () => {
  nextRows = [{ id: 'u1', phone: '+14155550000', agent_number: '+14155551111' }];

  const user = await findUserByAgentNumber('+1 (415) 555-1111');

  assert.equal(user.id, 'u1');
  assert.deepEqual(statements[0].params, ['+14155551111']);
});

test('findUserByAgentNumber returns undefined for an unusable number', async () => {
  assert.equal(await findUserByAgentNumber('not-a-number'), undefined);
  assert.equal(statements.length, 0, 'must not hit the database');
});

test('findUserByAgentNumber returns undefined when no user owns the number', async () => {
  nextRows = [];
  assert.equal(await findUserByAgentNumber('+14155559999'), undefined);
});

test('assignAgentNumber upserts the user and stores the number', async () => {
  nextRows = [{ id: 'u1', phone: '+14155550000', agent_number: '+14155551111' }];

  const user = await assignAgentNumber('+14155550000', '+14155551111');

  assert.equal(user.agent_number, '+14155551111');
  assert.deepEqual(statements[0].params, ['+14155550000', '+14155551111']);
});

test('assignAgentNumber rejects a malformed agent number', async () => {
  await assert.rejects(
    () => assignAgentNumber('+14155550000', '415-555-1111x'),
    /E\.164/
  );
});

test('assignAgentNumber rejects a malformed user number', async () => {
  await assert.rejects(() => assignAgentNumber('nope', '+14155551111'), /E\.164/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test db/agent-numbers.test.js`
Expected: FAIL, `Cannot find module './agent-numbers.js'`

- [ ] **Step 3: Implement the store**

Create `server/db/agent-numbers.js`:

```js
import { isE164, normalizePhone } from '../lib/phone.js';
import { queryOne } from './pool.js';

/**
 * The inbound call path's first database read: which user publishes this
 * number? Returns undefined rather than throwing, because an inbound call to
 * an unclaimed number is a routing mistake, not a server error.
 */
export async function findUserByAgentNumber(agentNumber) {
  const normalized = normalizePhone(agentNumber);
  if (!normalized) return undefined;

  return queryOne(
    'SELECT id, phone, agent_number FROM users WHERE agent_number = $1',
    [normalized]
  );
}

/**
 * Operator-driven provisioning. Self-serve number purchase is deferred until
 * the validation cohort proves the product; assigning by hand is enough for
 * a handful of users and avoids a Twilio purchase flow we may not keep.
 */
export async function assignAgentNumber(userPhone, agentNumber) {
  const user = normalizePhone(userPhone);
  const agent = normalizePhone(agentNumber);

  if (!user) throw new Error(`User phone must be E.164, got "${userPhone}"`);
  if (!agent) throw new Error(`Agent number must be E.164, got "${agentNumber}"`);

  return queryOne(
    `INSERT INTO users (phone, agent_number) VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET agent_number = EXCLUDED.agent_number
     RETURNING id, phone, agent_number`,
    [user, agent]
  );
}

export { isE164 };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test db/agent-numbers.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Add the GET /api/me route**

Append to `server/routes/calls.js`:

```js
export const meRouter = express.Router();

/** The app needs to know which number to tell the user to publish. */
meRouter.get('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const row = await queryOne(
      'SELECT id, phone, tier, agent_number FROM users WHERE id = $1',
      [user.id]
    );

    res.json({
      phone: row.phone,
      tier: row.tier,
      agent_number: row.agent_number ?? null,
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 6: Mount the route**

In `server/app.js`, change the calls import and add the mount:

```js
import { callsRouter, meRouter, usageRouter } from './routes/calls.js';
```

and directly below `app.use('/api/usage', usageRouter);` add:

```js
  app.use('/api/me', meRouter);
```

- [ ] **Step 7: Write the operator script**

Create `server/scripts/assign-number.js`:

```js
/**
 * Assign an agent number to a user.
 *
 *   node --env-file=../.env scripts/assign-number.js +14155550000 +14155551111
 *
 * The Twilio number's Voice webhook must separately be pointed at
 * $PUBLIC_BASE_URL/twiml/incoming (POST) in the Twilio console.
 */
import { assignAgentNumber } from '../db/agent-numbers.js';

const [userPhone, agentNumber] = process.argv.slice(2);

if (!userPhone || !agentNumber) {
  console.error('Usage: assign-number.js <user-phone-e164> <agent-number-e164>');
  process.exit(1);
}

try {
  const user = await assignAgentNumber(userPhone, agentNumber);
  console.log(`Assigned ${user.agent_number} to ${user.phone} (${user.id})`);
  console.log(
    `Now set that number's Voice webhook to ${process.env.PUBLIC_BASE_URL}/twiml/incoming`
  );
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test` from `server/`
Expected: PASS, all tests green

```bash
git add server/db/agent-numbers.js server/db/agent-numbers.test.js \
        server/scripts/assign-number.js server/routes/calls.js server/app.js
git commit -m "feat: agent number assignment, lookup and GET /api/me"
```

---

### Task 3: Inbound bridge — TwiML, consent announcement, fail-open

**Files:**
- Create: `server/routes/inbound.js`
- Create: `server/routes/inbound.test.js`
- Modify: `server/app.js`
- Modify: `server/config.js`

**Interfaces:**
- Consumes: `findUserByAgentNumber` from `server/db/agent-numbers.js`; `findOrCreateContact` from `server/db/contacts.js`; `verifyTwilioSignature` from `server/lib/twilio-signature.js`; `query`, `queryOne` from `server/db/pool.js`; `config` from `server/config.js`.
- Produces: `inboundRouter` — Express router serving `POST /twiml/incoming`.

- [ ] **Step 1: Add the consent configuration**

In `server/config.js`, add these two entries to the `config` object, directly after the `openaiModel` line:

```js
  /**
   * Roughly a dozen US states require all-party consent to record. Users are
   * recording customers, so this is on unless explicitly disabled.
   */
  announceRecording: process.env.ANNOUNCE_RECORDING !== 'false',

  recordingNotice:
    process.env.RECORDING_NOTICE ??
    'This call may be recorded and transcribed for note taking.',
```

- [ ] **Step 2: Write the failing tests**

Create `server/routes/inbound.test.js`:

```js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_BASE_URL = 'https://agent.example.com';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.SKIP_TWILIO_SIGNATURE_CHECK = 'true';

let user;
let contact;
let failContactLookup = false;
const inserted = [];

mock.module('../db/agent-numbers.js', {
  namedExports: { findUserByAgentNumber: async () => user },
});

mock.module('../db/contacts.js', {
  namedExports: {
    findOrCreateContact: async () => {
      if (failContactLookup) throw new Error('database is down');
      return contact;
    },
    adoptExtractedName: async () => {},
    touchLastCall: async () => {},
  },
});

mock.module('../db/pool.js', {
  namedExports: {
    query: async () => ({ rows: [] }),
    queryOne: async (text, params) => {
      if (text.includes('INSERT INTO calls')) {
        inserted.push(params);
        return { id: 'call-1' };
      }
      return undefined;
    },
    getPool: () => ({}),
  },
});

const { createApp } = await import('../app.js');
const app = createApp();

async function incoming(body) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/twiml/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    return { status: res.status, xml: await res.text() };
  } finally {
    server.close();
  }
}

const CALL = { From: '+14155552671', To: '+14155551111', CallSid: 'CA_IN_1' };

test.beforeEach(() => {
  user = { id: 'u1', phone: '+14155550000', agent_number: '+14155551111' };
  contact = { id: 'c1', phone: '+14155552671', display_name: null };
  failContactLookup = false;
  inserted.length = 0;
  process.env.ANNOUNCE_RECORDING = 'true';
});

test('dials the owner with dual-channel recording', async () => {
  const { xml } = await incoming(CALL);

  assert.match(xml, /record="record-from-answer-dual"/);
  assert.match(xml, /<Number>\+14155550000<\/Number>/);
  assert.match(xml, /recording-ready\?callId=call-1/);
  assert.match(xml, /dial-done\?callId=call-1/);
});

test('announces recording to the caller before connecting', async () => {
  const { xml } = await incoming(CALL);

  const sayAt = xml.indexOf('<Say');
  const dialAt = xml.indexOf('<Dial');
  assert.ok(sayAt > -1, 'expected a consent announcement');
  assert.ok(sayAt < dialAt, 'announcement must play before the dial');
  assert.match(xml, /may be recorded/i);
});

test('omits the announcement when disabled', async () => {
  process.env.ANNOUNCE_RECORDING = 'false';
  const { xml } = await incoming(CALL);
  assert.doesNotMatch(xml, /<Say/);
});

test('records the call as inbound and links the contact', async () => {
  await incoming(CALL);

  assert.equal(inserted.length, 1);
  const [userId, userPhone, destination, sid, contactId] = inserted[0];
  assert.equal(userId, 'u1');
  assert.equal(userPhone, '+14155550000');
  assert.equal(destination, '+14155552671', 'destination is the caller');
  assert.equal(sid, 'CA_IN_1');
  assert.equal(contactId, 'c1');
});

test('rejects a call to a number nobody has claimed', async () => {
  user = undefined;
  const { xml } = await incoming(CALL);

  assert.doesNotMatch(xml, /<Dial/);
  assert.match(xml, /<Hangup\/>/);
});

test('still connects the call when the contact lookup fails', async () => {
  failContactLookup = true;
  const { xml } = await incoming(CALL);

  // The AI layer must never be able to break a phone call.
  assert.match(xml, /<Number>\+14155550000<\/Number>/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test routes/inbound.test.js`
Expected: FAIL, 404 responses because `/twiml/incoming` does not exist

- [ ] **Step 4: Implement the inbound router**

Create `server/routes/inbound.js`:

```js
import express from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import { findUserByAgentNumber } from '../db/agent-numbers.js';
import { findOrCreateContact } from '../db/contacts.js';
import { queryOne } from '../db/pool.js';
import { verifyTwilioSignature } from '../lib/twilio-signature.js';

const { VoiceResponse } = twilio.twiml;

export const inboundRouter = express.Router();
inboundRouter.use(verifyTwilioSignature);

/**
 * Best-effort contact resolution.
 *
 * A failure here costs us the contact link on this call - it must never cost
 * the user the call itself, so it resolves to null instead of throwing.
 */
async function resolveContact(userId, callerNumber) {
  try {
    const contact = await findOrCreateContact(userId, callerNumber);
    return contact?.id ?? null;
  } catch (err) {
    console.error('[inbound] contact lookup failed', err);
    return null;
  }
}

/** Twilio fetches this when someone dials a user's published agent number. */
inboundRouter.post('/', async (req, res) => {
  const { From: caller, To: agentNumber, CallSid } = req.body ?? {};
  const twiml = new VoiceResponse();

  const user = await findUserByAgentNumber(agentNumber).catch((err) => {
    console.error('[inbound] owner lookup failed', err);
    return undefined;
  });

  if (!user) {
    twiml.say('This number is not in service.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const contactId = await resolveContact(user.id, caller);

  let callId = null;
  try {
    const row = await queryOne(
      `INSERT INTO calls (user_id, user_phone, destination, twilio_call_sid,
                          contact_id, direction, status)
       VALUES ($1, $2, $3, $4, $5, 'inbound', 'ringing')
       RETURNING id`,
      [user.id, user.phone, caller, CallSid, contactId]
    );
    callId = row?.id ?? null;
  } catch (err) {
    // Losing the row means losing the notes, not the conversation.
    console.error('[inbound] could not create call row', err);
  }

  if (config.announceRecording) {
    twiml.say(config.recordingNotice);
  }

  const base = config.publicBaseUrl;
  const dial = twiml.dial({
    record: 'record-from-answer-dual',
    recordingStatusCallback: `${base}/webhooks/recording-ready?callId=${callId}`,
    recordingStatusCallbackMethod: 'POST',
    recordingStatusCallbackEvent: 'completed',
    action: `${base}/twiml/dial-done?callId=${callId}`,
    method: 'POST',
    timeout: 25,
    timeLimit: 7200,
    callerId: agentNumber,
  });
  dial.number(user.phone);

  res.type('text/xml').send(twiml.toString());
});
```

- [ ] **Step 5: Mount the router**

In `server/app.js`, add the import beside the other route imports:

```js
import { inboundRouter } from './routes/inbound.js';
```

and mount it directly above `app.use('/twiml', twimlRouter);`:

```js
  app.use('/twiml/incoming', inboundRouter);
```

**Mount it on the full path, not on `/twiml`.** A router-level `use()` guard
runs for every request reaching that mount point, including paths the router
does not handle — mounting this at `/twiml` would run the signature check a
second time on `/twiml/bridge` and `/twiml/dial-done` before they fell through
to `twimlRouter`. That is the same trap that once made every unmatched URL
answer 403 instead of 404 (commit `bf8d58a`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test routes/inbound.test.js`
Expected: PASS, 6 tests

- [ ] **Step 7: Run the whole suite and commit**

Run: `npm test` from `server/`
Expected: PASS, all tests green

```bash
git add server/routes/inbound.js server/routes/inbound.test.js \
        server/app.js server/config.js
git commit -m "feat: inbound bridge with recording consent announcement"
```

---

### Task 4: Direction-aware call completion

**Files:**
- Modify: `server/routes/webhooks.js:102-140` (the `dial-done` handler)
- Modify: `server/routes/webhooks.test.js`

**Interfaces:**
- Consumes: existing `resolveCall`, `currentMonth`, `query`, `queryOne`.
- Produces: no new exports. Behaviour change only.

**Why:** `dial-done` currently assumes the dialled leg is the *destination*. On an inbound call the dialled leg is the *user's own handset*, so a `no-answer` there means the user missed the call — a different outcome from a failed outbound dial, and one that must not be billed as connected time.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/webhooks.test.js`:

```js
test('an unanswered inbound call is recorded as missed, not failed', async () => {
  const call = seedCall({ direction: 'inbound' });

  await post(`/twiml/dial-done?callId=${call.id}`, {
    DialCallStatus: 'no-answer',
    DialCallDuration: '0',
    CallSid: 'CA_PARENT',
  });

  assert.equal(call.status, 'missed');
  assert.equal(usageWrites().length, 0);
});

test('an answered inbound call still processes and bills normally', async () => {
  const call = seedCall({ direction: 'inbound' });

  await post(`/twiml/dial-done?callId=${call.id}`, {
    DialCallStatus: 'completed',
    DialCallDuration: '120',
    CallSid: 'CA_PARENT',
  });

  assert.equal(call.status, 'processing');
  assert.equal(usageWrites().length, 1);
});

test('an unanswered outbound call is still failed', async () => {
  const call = seedCall({ direction: 'outbound' });

  await post(`/twiml/dial-done?callId=${call.id}`, {
    DialCallStatus: 'no-answer',
    DialCallDuration: '0',
    CallSid: 'CA_PARENT',
  });

  assert.equal(call.status, 'failed');
});
```

Also update the fake `run()` in that file so the `dial-done` branch stores whichever status the statement is given. Replace the body of the `sql.includes('UPDATE calls') && sql.includes('duration_sec = $2')` branch with:

```js
    const call = db.calls.find((c) => c.id === params[0]);
    if (!call || call.duration_sec !== null) return { rows: [] };
    call.duration_sec = params[1];
    call.status = params[2] ? 'processing' : params[5];
    return { rows: [{ id: call.id, user_id: call.user_id }] };
```

and add `direction: 'outbound'` to the defaults object inside `seedCall`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test routes/webhooks.test.js`
Expected: FAIL — inbound no-answer yields `failed`, not `missed`

- [ ] **Step 3: Update the dial-done handler**

In `server/routes/webhooks.js`, replace the `queryOne` call inside the `dial-done` handler with:

```js
    // On an inbound call the dialled leg is the user's own handset, so an
    // unanswered dial means a missed call rather than a failed one.
    const missedStatus = call.direction === 'inbound' ? 'missed' : 'failed';

    const updated = await queryOne(
      `UPDATE calls
          SET duration_sec = $2,
              status = CASE WHEN $3 THEN 'processing' ELSE $5 END,
              error = CASE WHEN $3 THEN error ELSE $4 END
        WHERE id = $1 AND duration_sec IS NULL
        RETURNING id, user_id`,
      [call.id, seconds, connected, `Dial ${DialCallStatus}`, missedStatus]
    );
```

`missedStatus` is `$5`, which is what the test fake in Step 1 reads as
`params[4]`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test routes/webhooks.test.js`
Expected: PASS

- [ ] **Step 5: Add `missed` to the documented status set**

In `server/db/schema.sql`, update the status comment on the `calls` table:

```sql
  -- initiating | ringing | in-progress | missed | processing | ready | failed
```

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test` from `server/`
Expected: PASS, all tests green

```bash
git add server/routes/webhooks.js server/routes/webhooks.test.js server/db/schema.sql
git commit -m "feat: distinguish missed inbound calls from failed outbound dials"
```

---

### Task 5: Business summaries with next moves

**Files:**
- Modify: `server/services/summarize.js`
- Modify: `server/services/summarize.test.js`

**Interfaces:**
- Produces: `parseSummary(content: string)` now returns
  `{ summary, next_moves: string[], action_items: {task, owner}[], key_points: string[] }`.
  The `language` field is dropped — this product is English-first.

- [ ] **Step 1: Write the failing tests**

In `server/services/summarize.test.js`, replace the first test and add three more:

```js
test('parses a well-formed business summary', () => {
  const result = parseSummary(
    JSON.stringify({
      summary: 'Phili from Amax wants pricing for 200 units.',
      next_moves: ['Send the volume price list', 'Confirm the Tuesday call'],
      action_items: [{ task: 'Send pricing', owner: 'me' }],
      key_points: ['200 units', 'Budget approved'],
    })
  );

  assert.deepEqual(result.next_moves, [
    'Send the volume price list',
    'Confirm the Tuesday call',
  ]);
  assert.deepEqual(result.action_items, [{ task: 'Send pricing', owner: 'me' }]);
});

test('defaults next_moves to an empty list when absent', () => {
  const result = parseSummary(JSON.stringify({ summary: 'Short call.' }));
  assert.deepEqual(result.next_moves, []);
});

test('ignores a non-array next_moves', () => {
  const result = parseSummary(
    JSON.stringify({ summary: 'x', next_moves: 'call them back' })
  );
  assert.deepEqual(result.next_moves, []);
});

test('drops blank next_moves entries', () => {
  const result = parseSummary(
    JSON.stringify({ summary: 'x', next_moves: ['Send pricing', '', null] })
  );
  assert.deepEqual(result.next_moves, ['Send pricing']);
});
```

Delete the existing Amharic-specific assertions on `result.language` from the first test in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test services/summarize.test.js`
Expected: FAIL, `next_moves` is undefined

- [ ] **Step 3: Update the prompt and parser**

In `server/services/summarize.js`, replace `SYSTEM_PROMPT` with:

```js
export const SYSTEM_PROMPT = `You process business phone call transcripts.
The transcript is speaker-labelled: "User:" is the person you work for,
"Caller:" is the other party.

Return JSON:
{
  summary: 3-6 sentences covering what was discussed and agreed,
  next_moves: 2-4 short imperative suggestions for what the User should do
              next, ordered by importance,
  action_items: [{task, owner}] - things someone explicitly committed to,
  key_points: [strings] - facts worth remembering, such as figures, names,
              dates and constraints
}

Never invent facts. Keep names, companies and numbers exactly as transcribed.
If the call was too short or unclear to summarize, say so in summary and
return empty arrays.`;
```

In `parseSummary`, remove the `language` line from the returned object and add `next_moves` beside `key_points`:

```js
  return {
    summary: data.summary.trim(),
    next_moves: (Array.isArray(data.next_moves) ? data.next_moves : [])
      .map((move) => (typeof move === 'string' ? move.trim() : ''))
      .filter(Boolean),
    action_items: actionItems
      .map((item) =>
        typeof item === 'string'
          ? { task: item, owner: null }
          : { task: item?.task ?? '', owner: item?.owner ?? null }
      )
      .filter((item) => item.task),
    key_points: (Array.isArray(data.key_points) ? data.key_points : [])
      .map((point) => (typeof point === 'string' ? point : String(point ?? '')))
      .filter(Boolean),
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test services/summarize.test.js`
Expected: PASS

- [ ] **Step 5: Update the pipeline write**

In `server/services/process-recording.js`, replace the whole `UPDATE calls`
statement and its parameter array with this. The `language` and
`language_probability` writes are dropped — this product is English-first, and
the columns stay in the table only so the migration does not need to remove
them.

```js
    await query(
      `UPDATE calls
          SET transcript = $2,
              transcript_data = $3,
              summary = $4,
              next_moves = $5,
              action_items = $6,
              key_points = $7,
              error = NULL,
              status = 'ready'
        WHERE id = $1`,
      [
        callId,
        result.text,
        JSON.stringify(result.raw),
        summary.summary,
        JSON.stringify(summary.next_moves),
        JSON.stringify(summary.action_items),
        JSON.stringify(summary.key_points),
      ]
    );
```

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test` from `server/`
Expected: PASS, all tests green

```bash
git add server/services/summarize.js server/services/summarize.test.js \
        server/services/process-recording.js
git commit -m "feat: business-call summaries with suggested next moves"
```

---

### Task 6: Caller identification

**Files:**
- Create: `server/services/identify.js`
- Create: `server/services/identify.test.js`

**Interfaces:**
- Consumes: `config` from `server/config.js`.
- Produces:
  - `IDENTIFY_PROMPT: string`
  - `parseIdentity(content: string): {name: string|null, company: string|null, confidence: number}`
  - `identifyCaller(transcript: string): Promise<{name, company, confidence}>`
  - `openingOf(transcript: string, lines?: number): string`

- [ ] **Step 1: Write the failing tests**

Create `server/services/identify.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openingOf, parseIdentity } from './identify.js';

test('parses a confident identification', () => {
  const result = parseIdentity(
    JSON.stringify({ name: 'Phili', company: 'Amax', confidence: 0.92 })
  );
  assert.deepEqual(result, { name: 'Phili', company: 'Amax', confidence: 0.92 });
});

test('returns a null identity when the caller never introduces themselves', () => {
  const result = parseIdentity(
    JSON.stringify({ name: null, company: null, confidence: 0 })
  );
  assert.equal(result.name, null);
  assert.equal(result.confidence, 0);
});

test('treats an empty name as no identification', () => {
  const result = parseIdentity(JSON.stringify({ name: '   ', confidence: 0.9 }));
  assert.equal(result.name, null);
});

test('clamps confidence into 0..1', () => {
  assert.equal(parseIdentity(JSON.stringify({ name: 'A', confidence: 5 })).confidence, 1);
  assert.equal(parseIdentity(JSON.stringify({ name: 'A', confidence: -2 })).confidence, 0);
});

test('defaults a missing confidence to zero rather than guessing', () => {
  assert.equal(parseIdentity(JSON.stringify({ name: 'Phili' })).confidence, 0);
});

test('returns a null identity for unparseable output instead of throwing', () => {
  // Identification is best-effort: a bad response must not fail the call.
  assert.deepEqual(parseIdentity('sorry, I cannot help'), {
    name: null,
    company: null,
    confidence: 0,
  });
});

test('openingOf takes only the first lines of a transcript', () => {
  const transcript = ['Caller: hi', 'User: hello', 'Caller: so about the order', 'User: yes'].join('\n');
  assert.equal(openingOf(transcript, 2), 'Caller: hi\nUser: hello');
});

test('openingOf handles a transcript shorter than the window', () => {
  assert.equal(openingOf('Caller: hi', 5), 'Caller: hi');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test services/identify.test.js`
Expected: FAIL, `Cannot find module './identify.js'`

- [ ] **Step 3: Implement the identifier**

Create `server/services/identify.js`:

```js
import OpenAI from 'openai';
import { config } from '../config.js';

/** People introduce themselves early; the rest of the call is noise here. */
const OPENING_LINES = 12;

export const IDENTIFY_PROMPT = `You extract who the "Caller:" is from the start
of a phone transcript.

Look for a self-introduction such as "this is Phili from Amax", or the User
addressing them by name. Do not guess from the topic of conversation.

Return JSON: { name, company, confidence }.
- name: the caller's personal name, or null if they never gave one.
- company: their organisation, or null.
- confidence: 0 to 1. Use 0 when nobody introduced themselves. Only exceed
  0.7 when the introduction is explicit and unambiguous.

Never invent a name. Absent an introduction, return nulls with confidence 0.`;

let client;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: config.openaiApiKey });
  return client;
}

export function openingOf(transcript, lines = OPENING_LINES) {
  return String(transcript ?? '')
    .split('\n')
    .slice(0, lines)
    .join('\n');
}

const NO_IDENTITY = { name: null, company: null, confidence: 0 };

/**
 * Identification is best-effort. Unlike the summary parser, which throws so a
 * bad response cannot be written as if it were good, this returns a null
 * identity: failing to name a contact is not worth failing a call over.
 */
export function parseIdentity(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return { ...NO_IDENTITY };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ...NO_IDENTITY };
  }

  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
  const company =
    typeof data.company === 'string' && data.company.trim() ? data.company.trim() : null;

  const raw = Number(data.confidence);
  const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;

  return { name, company, confidence: name ? confidence : 0 };
}

export async function identifyCaller(transcript) {
  const completion = await getClient().chat.completions.create({
    model: config.openaiModel,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      { role: 'system', content: IDENTIFY_PROMPT },
      { role: 'user', content: openingOf(transcript) },
    ],
  });

  return parseIdentity(completion.choices[0]?.message?.content ?? '');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test services/identify.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add server/services/identify.js server/services/identify.test.js
git commit -m "feat: extract caller identity from a transcript opening"
```

---

### Task 7: Wire identification into the pipeline

**Files:**
- Modify: `server/services/process-recording.js`
- Create: `server/services/process-recording.test.js`

**Interfaces:**
- Consumes: `identifyCaller` (Task 6), `shouldAdoptName` (Task 1), `adoptExtractedName`, `touchLastCall` (Task 1).
- Produces: no new exports. `processRecording(callId)` gains a naming step.

- [ ] **Step 1: Write the failing tests**

Create `server/services/process-recording.test.js`:

```js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let call;
let identity;
let identifyThrows = false;
const adopted = [];
const touched = [];

mock.module('../db/pool.js', {
  namedExports: {
    query: async () => ({ rows: [] }),
    queryOne: async () => call,
    getPool: () => ({}),
  },
});

mock.module('./originate.js', {
  namedExports: {
    fetchRecording: async () => ({ ok: true, blob: async () => new Blob(['x']) }),
    isE164: () => true,
  },
});

mock.module('./transcribe.js', {
  namedExports: {
    transcribe: async () => ({
      text: 'Caller: hi this is Phili from Amax\nUser: hello',
      language: 'eng',
      languageProbability: 0.99,
      raw: {},
    }),
  },
});

mock.module('./summarize.js', {
  namedExports: {
    summarize: async () => ({
      summary: 'Pricing discussion.',
      next_moves: ['Send pricing'],
      action_items: [],
      key_points: [],
    }),
  },
});

mock.module('./identify.js', {
  namedExports: {
    identifyCaller: async () => {
      if (identifyThrows) throw new Error('openai is down');
      return identity;
    },
  },
});

mock.module('../db/contacts.js', {
  namedExports: {
    adoptExtractedName: async (id, candidate) => adopted.push({ id, candidate }),
    touchLastCall: async (id) => touched.push(id),
    findOrCreateContact: async () => ({ id: 'c1' }),
  },
});

const { processRecording } = await import('./process-recording.js');

test.beforeEach(() => {
  call = {
    id: 'call-1',
    recording_url: 'https://api.twilio.com/x/Recordings/RE1',
    contact_id: 'c1',
    contact_display_name: null,
    contact_name_source: 'extracted',
    contact_name_confidence: null,
  };
  identity = { name: 'Phili', company: 'Amax', confidence: 0.92 };
  identifyThrows = false;
  adopted.length = 0;
  touched.length = 0;
});

test('names the contact from a confident identification', async () => {
  await processRecording('call-1');

  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].id, 'c1');
  assert.equal(adopted[0].candidate.name, 'Phili');
  assert.deepEqual(touched, ['c1']);
});

test('does not overwrite a name the user set', async () => {
  call.contact_display_name = 'Phili (procurement)';
  call.contact_name_source = 'user';

  await processRecording('call-1');

  assert.equal(adopted.length, 0);
  assert.deepEqual(touched, ['c1'], 'still records that we spoke');
});

test('skips naming below the confidence floor', async () => {
  identity = { name: 'Maybe Phil', company: null, confidence: 0.4 };
  await processRecording('call-1');
  assert.equal(adopted.length, 0);
});

test('completes the call even when identification fails', async () => {
  identifyThrows = true;
  await assert.doesNotReject(() => processRecording('call-1'));
  assert.equal(adopted.length, 0);
});

test('skips naming when the call has no contact', async () => {
  call.contact_id = null;
  await processRecording('call-1');
  assert.equal(adopted.length, 0);
  assert.equal(touched.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test services/process-recording.test.js`
Expected: FAIL — nothing is adopted, because the naming step does not exist

- [ ] **Step 3: Add the naming step**

In `server/services/process-recording.js`, extend the imports:

```js
import { adoptExtractedName, touchLastCall } from '../db/contacts.js';
import { shouldAdoptName } from '../lib/contact-policy.js';
import { identifyCaller } from './identify.js';
```

Widen the initial `queryOne` so the policy has the current name to compare against:

```js
  const call = await queryOne(
    `SELECT c.id, c.recording_url, c.contact_id,
            k.display_name  AS contact_display_name,
            k.name_source   AS contact_name_source,
            k.name_confidence AS contact_name_confidence
       FROM calls c
       LEFT JOIN contacts k ON k.id = c.contact_id
      WHERE c.id = $1`,
    [callId]
  );
```

Add this function above `processRecording`:

```js
/**
 * Name the contact from the conversation.
 *
 * Best-effort by design: a call whose notes are perfectly good should not be
 * marked failed because the identification model was unavailable.
 */
async function nameContact(call, transcript) {
  if (!call.contact_id) return;

  try {
    await touchLastCall(call.contact_id);

    const identity = await identifyCaller(transcript);
    const existing = {
      display_name: call.contact_display_name,
      name_source: call.contact_name_source,
      name_confidence: call.contact_name_confidence,
    };

    if (shouldAdoptName(existing, identity)) {
      await adoptExtractedName(call.contact_id, identity);
    }
  } catch (err) {
    console.error('[identify] naming failed for call', call.id, err);
  }
}
```

Then call it inside the `try` block, directly after `const summary = await summarize(result.text);`:

```js
    await nameContact(call, result.text);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test services/process-recording.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test` from `server/`
Expected: PASS, all tests green

```bash
git add server/services/process-recording.js server/services/process-recording.test.js
git commit -m "feat: name contacts from the conversation after each call"
```

---

### Task 8: Surface contacts, direction and next moves in the app

**Files:**
- Modify: `server/routes/calls.js` (list and detail queries)
- Modify: `src/api.ts`
- Modify: `src/i18n.ts`
- Modify: `app/(tabs)/index.tsx`
- Modify: `app/(tabs)/notes.tsx`
- Modify: `app/call/[id].tsx`
- Modify: `src/theme.ts`

**Interfaces:**
- Consumes: `contacts` table (Task 1), `calls.direction` and `calls.next_moves` (Tasks 1, 5).
- Produces: `CallSummary` and `CallDetail` gain `contact_name: string | null`, `company: string | null`, `direction: 'inbound' | 'outbound'`; `CallDetail` gains `next_moves: string[] | null`.

- [ ] **Step 1: Join contacts into the list query**

In `server/routes/calls.js`, replace `LIST_COLUMNS` and the list query body:

```js
const LIST_COLUMNS = `
  c.id, c.destination, c.status, c.duration_sec, c.direction, c.summary,
  c.created_at, k.display_name AS contact_name, k.company
`;
```

and in the `GET /` handler replace the query with:

```js
    const { rows } = await query(
      `SELECT ${LIST_COLUMNS} FROM calls c
         LEFT JOIN contacts k ON k.id = c.contact_id
        WHERE c.user_id = $1
        ORDER BY c.created_at DESC
        LIMIT 100`,
      [user.id]
    );
```

- [ ] **Step 2: Join contacts into the detail query**

In the `GET /:id` handler, replace the query with:

```js
    const call = await queryOne(
      `SELECT c.id, c.destination, c.status, c.duration_sec, c.direction,
              c.recording_url, c.transcript, c.summary, c.next_moves,
              c.action_items, c.key_points, c.error, c.created_at,
              k.display_name AS contact_name, k.company
         FROM calls c
         LEFT JOIN contacts k ON k.id = c.contact_id
        WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, user.id]
    );
```

- [ ] **Step 3: Verify the server still passes**

Run: `npm test` from `server/`
Expected: PASS, all tests green

- [ ] **Step 4: Update the API types**

In `src/api.ts`, replace the `CallSummary` and `CallDetail` type declarations:

```ts
export type CallSummary = {
  id: string;
  destination: string;
  contact_name: string | null;
  company: string | null;
  direction: 'inbound' | 'outbound';
  status: string;
  duration_sec: number | null;
  summary: string | null;
  created_at: string;
};

export type CallDetail = CallSummary & {
  recording_url: string | null;
  audio_url: string | null;
  transcript: string | null;
  next_moves: string[] | null;
  action_items: ActionItem[] | null;
  key_points: string[] | null;
  error: string | null;
};
```

Remove the `language` and `language_probability` fields, which no longer exist server-side.

- [ ] **Step 5: Add the new strings**

In `src/i18n.ts`, add to the `en` object (before the `// Errors` comment):

```ts
  nextMoves: 'Next moves',
  incoming: 'Incoming',
  outgoing: 'Outgoing',
  statusMissed: 'Missed',
  unknownCaller: 'Unknown caller',
```

and the matching entries to `am`:

```ts
  nextMoves: 'ቀጣይ እርምጃዎች',
  incoming: 'ገቢ ጥሪ',
  outgoing: 'የወጣ ጥሪ',
  statusMissed: 'ያመለጠ',
  unknownCaller: 'ያልታወቀ ደዋይ',
```

- [ ] **Step 6: Show contact names and direction in Recents**

In `app/(tabs)/index.tsx`, inside `renderItem`, replace the row's text block with:

```tsx
            <View style={{ flex: 1, gap: 2 }}>
              <Txt size="subhead">
                {item.contact_name ?? item.destination}
              </Txt>
              <Txt size="caption" tone="muted">
                {item.direction === 'inbound' ? t('incoming') : t('outgoing')}
                {'  '}
                {t(statusKey(item.status))}
                {item.duration_sec ? `  ${formatDuration(item.duration_sec)}` : ''}
              </Txt>
            </View>
```

Add `missed` to the status colour map in `src/theme.ts`:

```ts
  missed: color.madder,
```

- [ ] **Step 7: Show next moves in the call detail**

In `app/call/[id].tsx`, add this block directly after the `{call.summary && (...)}` section:

```tsx
      {call.next_moves && call.next_moves.length > 0 && (
        <Section title={t('nextMoves')}>
          <View style={{ gap: space.xs }}>
            {call.next_moves.map((move, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: space.sm }}>
                <Txt tone="accent">→</Txt>
                <Txt style={{ flex: 1 }}>{move}</Txt>
              </View>
            ))}
          </View>
        </Section>
      )}
```

Also update the header title effect to prefer the contact name:

```tsx
  useEffect(() => {
    const title = call?.contact_name ?? call?.destination;
    if (title) navigation.setOptions({ title });
  }, [call?.contact_name, call?.destination, navigation]);
```

- [ ] **Step 8: Show contact names in Notes too**

`app/(tabs)/notes.tsx` still titles each card with the raw number, which would
leave Notes the only screen showing `+14155552671` where the others show
"Phili". In the card header, replace:

```tsx
              <Txt size="subhead" weight="bold">
                {item.destination}
              </Txt>
```

with:

```tsx
              <Txt size="subhead" weight="bold">
                {item.contact_name ?? item.destination}
              </Txt>
```

- [ ] **Step 9: Typecheck the app**

Run: `npx tsc --noEmit` from the repo root
Expected: exit 0. If `language` or `language_probability` is still referenced
anywhere outside `src/i18n.ts` and `app/settings.tsx` — where `language` is the
label for the language toggle and unrelated — remove those references.

- [ ] **Step 10: Verify the app still bundles**

Run: `npx expo export --platform android --output-dir "$SCRATCH/export-check"` from the repo root, where `$SCRATCH` is any writable temporary directory.
Expected: "Android Bundled" with no errors.

- [ ] **Step 11: Commit**

```bash
git add server/routes/calls.js src/api.ts src/i18n.ts src/theme.ts \
        "app/(tabs)/index.tsx" "app/(tabs)/notes.tsx" "app/call/[id].tsx"
git commit -m "feat: show contact names, call direction and next moves"
```

---

## Manual verification

Automated tests never touch a live API, so these steps confirm the parts only a real call can prove. **Keep test calls short** — inbound plus outbound legs bill at roughly $0.025/min.

1. Buy a Twilio number, then run from `server/`:
   `node --env-file=../.env scripts/assign-number.js <your-phone> <twilio-number>`
2. In the Twilio console, set that number's Voice webhook to
   `$PUBLIC_BASE_URL/twiml/incoming` (HTTP POST).
3. Start the server (`npm run server`) and the tunnel
   (`ngrok http 3000 --url=<static>`).
4. **Inbound:** call the Twilio number from another phone. Expected: you hear
   the recording notice, your handset rings, the call connects. Open the call
   in the app during the call — status shows `in-progress`, direction
   `Incoming`.
5. Say "hi, this is <name> from <company>" early in the call, talk for thirty
   seconds, hang up.
6. Within about a minute the row reaches `ready` with a summary, next moves,
   and **a contact name matching what you said**. Confirm in Supabase that
   `contacts.display_name` is set and `name_source` is `extracted`.
7. **Name precedence:** update that contact with
   `UPDATE contacts SET display_name='Typed Name', name_source='user' WHERE ...`,
   make a second call, and confirm the typed name survives.
8. **Missed call:** call the number and do not answer. Expected: the row
   reaches `missed`, not `failed`, and `usage_minutes` does not increase.
9. **Outbound:** place a call from the dialer and confirm it still records,
   transcribes and summarizes as before.
10. **Fail-open:** stop the database, call the number, and confirm your handset
    still rings. Notes will be missing; the call must connect.

## Self-review notes

Spec coverage checked section by section. §5.1 capture is Tasks 2–3; §5.2 call
flow is Task 3 (briefing push is Phase 3, correctly absent); §6 data model is
Task 1 minus the `briefings`, `commitments`, `drafts` and `integrations`
tables, which belong to Phases 3–5; §7.4 identity is Tasks 1, 6 and 7; §8
consent is Task 3; §10 fail-open is Tasks 3 and 7; §11 testing is distributed
across every task.

Deliberately deferred within Phase 1–2 scope: self-serve number purchasing
(operator script instead, Task 2), and `contacts.notes`, which no feature in
this plan reads or writes.
