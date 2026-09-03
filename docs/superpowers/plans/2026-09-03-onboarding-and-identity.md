# Onboarding and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the operator script and the spoofable `x-user-phone` header with Google sign-in, an invite-gated signup, pooled number assignment, and a monthly spending circuit breaker.

**Architecture:** The Google account becomes identity; `phone` demotes to a nullable attribute. The app sends Google's ID token as a bearer credential and the server verifies it per request against Google's cached public keys — no JWT of our own. `resolveUser()` keeps its name and return shape, so every existing route handler is untouched. Numbers are assigned atomically from an operator-stocked pool rather than purchased per signup, and each number's webhook is configured once on entry to the pool, so onboarding makes no Twilio call at all.

**Tech Stack:** Node 22 ESM, Express 5, PostgreSQL via `pg`, `jose` for JWT verification, `node:test` with `--experimental-test-module-mocks`. App: Expo SDK 57, expo-router, `expo-auth-session`, `expo-secure-store`.

**Spec:** `docs/superpowers/specs/2026-09-03-onboarding-and-identity-design.md`

## Global Constraints

- **The Google account is identity; `phone` is a nullable attribute** that keeps its `UNIQUE` constraint. (Spec §3)
- **A bad token is 401; an unverifiable token is 503.** Google's key endpoint being unreachable must never log users out. (Spec §9)
- **The allowlist is checked at provisioning, not at sign-in** — an uninvited user gets a clear message, not a broken login. (Spec §4)
- **Number assignment must be atomic**; two concurrent signups must never receive the same number. (Spec §6)
- **Onboarding makes no Twilio API call.** Webhooks are configured when a number enters the pool. (Spec §6)
- **The minute ceiling is a circuit breaker, not a quota.** Default 3,000/month, warning at 80%. (Spec §7)
- **No test touches Google, Twilio, ElevenLabs or OpenAI.** Tests sign their own JWTs with a locally generated key pair. (Spec §10)
- Server code is ESM in `server/`, its own npm package. Tests run with `npm test --prefix server`.

## Out of scope

Payments and subscriptions, SMS verification, self-serve number purchasing, number porting, team accounts. (Spec §2)

## File Structure

**Create**
- `server/lib/google-auth.js` — verify a Google ID token; owns the 401-vs-503 distinction.
- `server/db/users.js` — user reads/writes keyed on `google_id`.
- `server/db/invites.js` — allowlist reads/writes.
- `server/lib/limits.js` — monthly minute ceiling; pure decision plus one read.
- `server/scripts/add-number.js` — operator script: put a number in the pool and set its webhook. Replaces `assign-number.js`.
- `src/auth.ts` — app-side Google sign-in and token storage.
- `app/sign-in.tsx`, `app/onboarding/phone.tsx`, `app/onboarding/confirm.tsx`, `app/onboarding/number.tsx` — the four onboarding screens.

**Modify**
- `server/db/schema.sql` — the migration.
- `server/lib/users.js` — `resolveUser` reads a bearer token. The seam.
- `server/db/agent-numbers.js` — pool assignment; the owner lookup becomes a join.
- `server/routes/calls.js` — provisioning endpoint, `/api/me`, usage warning fields.
- `server/routes/inbound.js` — ceiling check before bridging.
- `server/services/originate.js` — ceiling check before dialling.
- `src/AppContext.tsx`, `src/api.ts` — hold and send the token.
- `app/_layout.tsx` — route by auth state.
- `app/settings.tsx` — show the agent number.
- `app.json` — drop `RECORD_AUDIO`.

**Delete**
- `server/scripts/assign-number.js`, `app/onboarding.tsx`.

---

### Task 1: Google token verification

**Files:**
- Create: `server/lib/google-auth.js`, `server/lib/google-auth.test.js`
- Modify: `server/config.js`, `server/package.json`

**Interfaces:**
- Produces:
  - `verifyGoogleToken(token: string, keySet?): Promise<{googleId, email, name}>`
  - `class TokenInvalidError extends Error` — `status = 401`
  - `class TokenUnverifiableError extends Error` — `status = 503`

- [ ] **Step 1: Install jose**

Run from `server/`: `npm install jose`

`jose` is chosen over `google-auth-library` because its key set is an injectable
function, which is what makes the tests below possible without touching Google.

- [ ] **Step 2: Add the Google client id to config**

In `server/config.js`, add inside the `config` object, after `openaiModel`:

```js
  /** OAuth client id; the audience every ID token must be issued for. */
  get googleClientId() {
    return requireEnv('GOOGLE_CLIENT_ID');
  },
```

- [ ] **Step 3: Write the failing tests**

Create `server/lib/google-auth.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';

process.env.GOOGLE_CLIENT_ID = 'test-client-id';

const { TokenInvalidError, TokenUnverifiableError, verifyGoogleToken } =
  await import('./google-auth.js');

const ISSUER = 'https://accounts.google.com';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
jwk.kid = 'test-key';
jwk.alg = 'RS256';
const keySet = createLocalJWKSet({ keys: [jwk] });

async function token(claims = {}, overrides = {}) {
  return new SignJWT({ email: 'a@b.com', name: 'Ada', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? 'test-client-id')
    .setSubject(overrides.subject ?? 'google-123')
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? '1h')
    .sign(privateKey);
}

test('accepts a valid token and returns the profile', async () => {
  const profile = await verifyGoogleToken(await token(), keySet);
  assert.deepEqual(profile, {
    googleId: 'google-123',
    email: 'a@b.com',
    name: 'Ada',
  });
});

test('rejects an expired token', async () => {
  const expired = await token({}, { exp: '-1h' });
  await assert.rejects(() => verifyGoogleToken(expired, keySet), TokenInvalidError);
});

test('rejects a token issued for another audience', async () => {
  const wrong = await token({}, { audience: 'someone-elses-app' });
  await assert.rejects(() => verifyGoogleToken(wrong, keySet), TokenInvalidError);
});

test('rejects a token from the wrong issuer', async () => {
  const wrong = await token({}, { issuer: 'https://evil.example.com' });
  await assert.rejects(() => verifyGoogleToken(wrong, keySet), TokenInvalidError);
});

test('rejects a malformed token', async () => {
  await assert.rejects(() => verifyGoogleToken('not-a-jwt', keySet), TokenInvalidError);
});

test('rejects an absent token', async () => {
  await assert.rejects(() => verifyGoogleToken('', keySet), TokenInvalidError);
  await assert.rejects(() => verifyGoogleToken(undefined, keySet), TokenInvalidError);
});

test('accepts the alternate Google issuer', async () => {
  const alt = await token({}, { issuer: 'accounts.google.com' });
  const profile = await verifyGoogleToken(alt, keySet);
  assert.equal(profile.googleId, 'google-123');
});

test('a key set that cannot be reached is 503, not 401', async () => {
  // Losing Google must not look like a bad credential, or every user is
  // signed out because Google had a blip.
  const unreachable = async () => {
    throw new Error('getaddrinfo ENOTFOUND www.googleapis.com');
  };
  await assert.rejects(
    () => verifyGoogleToken(await token(), unreachable),
    TokenUnverifiableError
  );
});

test('tolerates a token with no name claim', async () => {
  const noName = await new SignJWT({ email: 'a@b.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER).setAudience('test-client-id').setSubject('google-123')
    .setIssuedAt().setExpirationTime('1h').sign(privateKey);

  const profile = await verifyGoogleToken(noName, keySet);
  assert.equal(profile.name, null);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run from `server/`: `node --test lib/google-auth.test.js`
Expected: FAIL, `Cannot find module './google-auth.js'`

- [ ] **Step 5: Implement the verifier**

Create `server/lib/google-auth.js`:

```js
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';

/** The credential is bad. The client should sign in again. */
export class TokenInvalidError extends Error {
  constructor(message = 'Invalid token') {
    super(message);
    this.status = 401;
    this.code = 'invalid_token';
  }
}

/**
 * We could not reach Google to check the credential. Emphatically not the
 * same as the credential being bad - answering 401 here would sign out every
 * user because Google had a blip.
 */
export class TokenUnverifiableError extends Error {
  constructor(message = 'Could not verify token') {
    super(message);
    this.status = 503;
    this.code = 'verification_unavailable';
  }
}

/** Google publishes both spellings of its issuer; both are legitimate. */
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

let remoteKeySet;
function googleKeySet() {
  if (!remoteKeySet) {
    // jose caches the fetched keys and refreshes them on rotation.
    remoteKeySet = createRemoteJWKSet(
      new URL('https://www.googleapis.com/oauth2/v3/certs')
    );
  }
  return remoteKeySet;
}

/**
 * Verify a Google ID token.
 *
 * `keySet` is injectable so tests can supply a local key pair rather than
 * reaching Google.
 */
export async function verifyGoogleToken(token, keySet = googleKeySet()) {
  if (!token || typeof token !== 'string') {
    throw new TokenInvalidError('No token supplied');
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, keySet, {
      issuer: ISSUERS,
      audience: config.googleClientId,
    }));
  } catch (err) {
    // jose raises JOSE-prefixed codes for bad tokens; anything else - DNS,
    // TLS, timeouts - means we could not check, which is a different answer.
    if (typeof err?.code === 'string' && err.code.startsWith('ERR_JW')) {
      throw new TokenInvalidError(err.message);
    }
    throw new TokenUnverifiableError(err?.message);
  }

  if (!payload.sub) throw new TokenInvalidError('Token has no subject');

  return {
    googleId: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    name: typeof payload.name === 'string' ? payload.name : null,
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test lib/google-auth.test.js`
Expected: PASS, 9 tests

- [ ] **Step 7: Commit**

```bash
git add server/lib/google-auth.js server/lib/google-auth.test.js \
        server/config.js server/package.json server/package-lock.json
git commit -m "feat: verify Google ID tokens, distinguishing 401 from 503"
```

---

### Task 2: Schema migration and the users store

**Files:**
- Create: `server/db/users.js`, `server/db/users.test.js`
- Modify: `server/db/schema.sql`

**Interfaces:**
- Consumes: `query`, `queryOne` from `server/db/pool.js`; `normalizePhone` from `server/lib/phone.js`.
- Produces:
  - `findOrCreateByGoogle({googleId, email, name}): Promise<User>`
  - `setUserPhone(userId: string, phone: string): Promise<User>`
  - `getUserById(userId: string): Promise<User | undefined>`
  - `User = { id, google_id, email, name, phone, tier, monthly_minute_limit }`

- [ ] **Step 1: Write the migration**

Append to `server/db/schema.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Onboarding and identity: Google accounts, invites, pooled numbers
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_minute_limit INT NOT NULL DEFAULT 3000;

-- A user now exists from sign-in, before they have given us a handset.
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

CREATE TABLE IF NOT EXISTS invites (
  email TEXT PRIMARY KEY,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by UUID REFERENCES users(id),
  claimed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE NOT NULL,
  user_id UUID REFERENCES users(id),        -- NULL means free
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_numbers_free_idx
  ON agent_numbers (id) WHERE user_id IS NULL;

-- Carry any number already assigned under the old column into the pool,
-- then retire the column. Safe on an empty table.
INSERT INTO agent_numbers (phone, user_id, assigned_at)
  SELECT agent_number, id, now() FROM users WHERE agent_number IS NOT NULL
  ON CONFLICT (phone) DO NOTHING;

ALTER TABLE users DROP COLUMN IF EXISTS agent_number;

-- An inbound call blocked by the spending ceiling is still recorded so the
-- user can see who tried.
-- calls.status: initiating | ringing | in-progress | missed | blocked
--             | processing | ready | failed
```

- [ ] **Step 2: Apply the migration**

Run the SQL above against the `dimts` Supabase project (`gdmmlvnfiidxrqmwkqng`)
via the SQL editor in the dashboard, or the Supabase MCP `apply_migration` tool
with name `onboarding_identity` if that connector is authorised.

Verify: `SELECT column_name FROM information_schema.columns WHERE table_name='users';`
should list `google_id`, `email`, `name`, `monthly_minute_limit`, and should
**not** list `agent_number`.

- [ ] **Step 3: Write the failing tests**

Create `server/db/users.test.js`:

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

const { findOrCreateByGoogle, getUserById, setUserPhone } =
  await import('./users.js');

test.beforeEach(() => {
  statements.length = 0;
  nextRows = [];
});

test('findOrCreateByGoogle upserts on google_id', async () => {
  nextRows = [{ id: 'u1', google_id: 'g1', email: 'a@b.com', phone: null }];

  const user = await findOrCreateByGoogle({
    googleId: 'g1', email: 'a@b.com', name: 'Ada',
  });

  assert.equal(user.id, 'u1');
  assert.match(statements[0].text, /ON CONFLICT \(google_id\) DO UPDATE/);
  assert.deepEqual(statements[0].params, ['g1', 'a@b.com', 'Ada']);
});

test('findOrCreateByGoogle refreshes email and name on return visits', async () => {
  nextRows = [{ id: 'u1', google_id: 'g1' }];
  await findOrCreateByGoogle({ googleId: 'g1', email: 'new@b.com', name: 'Ada B' });
  assert.match(statements[0].text, /SET email = EXCLUDED.email/);
});

test('findOrCreateByGoogle rejects a profile with no googleId', async () => {
  await assert.rejects(
    () => findOrCreateByGoogle({ googleId: null, email: 'a@b.com' }),
    /googleId/
  );
  assert.equal(statements.length, 0);
});

test('setUserPhone normalises before writing', async () => {
  nextRows = [{ id: 'u1', phone: '+14155552671' }];
  await setUserPhone('u1', '+1 (415) 555-2671');
  assert.deepEqual(statements[0].params, ['u1', '+14155552671']);
});

test('setUserPhone rejects an unusable number', async () => {
  await assert.rejects(() => setUserPhone('u1', 'nope'), /E\.164/);
  assert.equal(statements.length, 0);
});

test('getUserById selects the identity columns', async () => {
  nextRows = [{ id: 'u1' }];
  await getUserById('u1');
  assert.match(statements[0].text, /google_id/);
  assert.match(statements[0].text, /monthly_minute_limit/);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test db/users.test.js`
Expected: FAIL, `Cannot find module './users.js'`

- [ ] **Step 5: Implement the store**

Create `server/db/users.js`:

```js
import { normalizePhone } from '../lib/phone.js';
import { queryOne } from './pool.js';

const COLUMNS =
  'id, google_id, email, name, phone, tier, monthly_minute_limit';

/**
 * The account for a Google profile, created on first sign-in.
 *
 * Email and name are refreshed on every visit because people change both,
 * and a stale email would silently break the invite allowlist.
 */
export async function findOrCreateByGoogle({ googleId, email, name }) {
  if (!googleId) throw new Error('findOrCreateByGoogle requires a googleId');

  return queryOne(
    `INSERT INTO users (google_id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (google_id) DO UPDATE
          SET email = EXCLUDED.email, name = EXCLUDED.name
     RETURNING ${COLUMNS}`,
    [googleId, email ?? null, name ?? null]
  );
}

export async function setUserPhone(userId, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error(`Phone must be E.164, got "${phone}"`);

  return queryOne(
    `UPDATE users SET phone = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
    [userId, normalized]
  );
}

export function getUserById(userId) {
  return queryOne(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [userId]);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test db/users.test.js`
Expected: PASS, 6 tests

- [ ] **Step 7: Commit**

```bash
git add server/db/users.js server/db/users.test.js server/db/schema.sql
git commit -m "feat: Google-keyed users store and identity migration"
```

---

### Task 3: Switch resolveUser to bearer tokens

**Files:**
- Modify: `server/lib/users.js`
- Create: `server/lib/users.test.js`

**Interfaces:**
- Consumes: `verifyGoogleToken`, `TokenInvalidError` (Task 1); `findOrCreateByGoogle` (Task 2).
- Produces: `resolveUser(req): Promise<User>` — same name and shape as before, now reading `Authorization: Bearer`. `HttpError` and `currentMonth` are unchanged.

**Why this is the whole migration:** every handler in `server/routes/calls.js`
calls `resolveUser`. Changing it here changes authentication everywhere without
touching a single route.

- [ ] **Step 1: Write the failing tests**

Create `server/lib/users.test.js`:

```js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let verifyResult;
let verifyError;
const created = [];

mock.module('./google-auth.js', {
  namedExports: {
    verifyGoogleToken: async () => {
      if (verifyError) throw verifyError;
      return verifyResult;
    },
    TokenInvalidError: class extends Error { status = 401; },
    TokenUnverifiableError: class extends Error { status = 503; },
  },
});

mock.module('../db/users.js', {
  namedExports: {
    findOrCreateByGoogle: async (p) => {
      created.push(p);
      return { id: 'u1', google_id: p.googleId, email: p.email, phone: null };
    },
    setUserPhone: async () => {},
    getUserById: async () => undefined,
  },
});

const { resolveUser } = await import('./users.js');

function req(authorization) {
  return { get: (h) => (h.toLowerCase() === 'authorization' ? authorization : undefined) };
}

test.beforeEach(() => {
  verifyResult = { googleId: 'g1', email: 'a@b.com', name: 'Ada' };
  verifyError = null;
  created.length = 0;
});

test('resolves a user from a bearer token', async () => {
  const user = await resolveUser(req('Bearer good-token'));
  assert.equal(user.id, 'u1');
  assert.deepEqual(created, [{ googleId: 'g1', email: 'a@b.com', name: 'Ada' }]);
});

test('rejects a request with no Authorization header', async () => {
  await assert.rejects(() => resolveUser(req(undefined)), (e) => e.status === 401);
});

test('rejects a non-Bearer scheme', async () => {
  await assert.rejects(() => resolveUser(req('Basic abc')), (e) => e.status === 401);
});

test('accepts a lowercase bearer scheme', async () => {
  const user = await resolveUser(req('bearer good-token'));
  assert.equal(user.id, 'u1');
});

test('propagates the verifier status rather than flattening it', async () => {
  // A 503 from Google must not reach the client as a 401.
  const unavailable = new Error('google down');
  unavailable.status = 503;
  verifyError = unavailable;

  await assert.rejects(() => resolveUser(req('Bearer t')), (e) => e.status === 503);
});

test('does not create a user when the token is rejected', async () => {
  const bad = new Error('bad'); bad.status = 401;
  verifyError = bad;
  await assert.rejects(() => resolveUser(req('Bearer t')));
  assert.equal(created.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test lib/users.test.js`
Expected: FAIL — `resolveUser` still reads `x-user-phone`, so the first test gets a 401

- [ ] **Step 3: Rewrite resolveUser**

In `server/lib/users.js`, replace the imports and the `resolveUser` function.
Delete the `isE164` import from `../services/originate.js` — it is no longer
used here. Keep `HttpError` and `currentMonth` exactly as they are.

```js
import { findOrCreateByGoogle } from '../db/users.js';
import { verifyGoogleToken } from './google-auth.js';

/**
 * Identify the caller from a Google ID token.
 *
 * This replaced an `x-user-phone` header that anyone could set to anyone's
 * number. Keeping the name and return shape means no route handler changed.
 */
export async function resolveUser(req) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (!token || scheme?.toLowerCase() !== 'bearer') {
    throw new HttpError(401, 'missing_token', 'Authorization: Bearer required');
  }

  // Verifier errors already carry the right status - 401 for a bad token,
  // 503 when Google is unreachable - so they pass straight through.
  const profile = await verifyGoogleToken(token);

  return findOrCreateByGoogle(profile);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/users.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Fix the route tests that still send the old header**

`server/routes/webhook-auth.test.js` and `server/routes/webhooks.test.js` do not
use `resolveUser` and need no change. Run the whole suite and repair any test
that sends `x-user-phone`:

Run: `npm test` from `server/`
Expected: PASS. If a test fails on a 401, replace its `'x-user-phone': ...`
header with `Authorization: 'Bearer test'` and add the two `mock.module` blocks
from Step 1 to that file.

- [ ] **Step 6: Commit**

```bash
git add server/lib/users.js server/lib/users.test.js
git commit -m "feat: authenticate with Google bearer tokens instead of a header"
```

---

### Task 4: Invite allowlist

**Files:**
- Create: `server/db/invites.js`, `server/db/invites.test.js`
- Create: `server/scripts/invite.js`

**Interfaces:**
- Consumes: `query`, `queryOne` from `server/db/pool.js`.
- Produces:
  - `isInvited(email: string): Promise<boolean>`
  - `claimInvite(email: string, userId: string): Promise<void>`
  - `addInvite(email: string): Promise<{email}>`

- [ ] **Step 1: Write the failing tests**

Create `server/db/invites.test.js`:

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

const { addInvite, claimInvite, isInvited } = await import('./invites.js');

test.beforeEach(() => { statements.length = 0; nextRows = []; });

test('isInvited is true for an allowlisted email', async () => {
  nextRows = [{ email: 'a@b.com' }];
  assert.equal(await isInvited('a@b.com'), true);
});

test('isInvited is false for an unknown email', async () => {
  nextRows = [];
  assert.equal(await isInvited('nobody@b.com'), false);
});

test('isInvited lowercases before lookup', async () => {
  nextRows = [{ email: 'a@b.com' }];
  await isInvited('A@B.CoM');
  assert.deepEqual(statements[0].params, ['a@b.com']);
});

test('isInvited is false for a null email rather than querying', async () => {
  assert.equal(await isInvited(null), false);
  assert.equal(statements.length, 0);
});

test('claimInvite records who claimed it', async () => {
  await claimInvite('a@b.com', 'u1');
  assert.match(statements[0].text, /UPDATE invites/);
  assert.deepEqual(statements[0].params, ['a@b.com', 'u1']);
});

test('addInvite lowercases and is idempotent', async () => {
  nextRows = [{ email: 'a@b.com' }];
  await addInvite('A@B.com');
  assert.deepEqual(statements[0].params, ['a@b.com']);
  assert.match(statements[0].text, /ON CONFLICT \(email\) DO NOTHING/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test db/invites.test.js`
Expected: FAIL, `Cannot find module './invites.js'`

- [ ] **Step 3: Implement the store**

Create `server/db/invites.js`:

```js
import { query, queryOne } from './pool.js';

/** Emails are compared case-insensitively; Google may return any casing. */
const normalize = (email) =>
  typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;

export async function isInvited(email) {
  const key = normalize(email);
  if (!key) return false;

  const row = await queryOne('SELECT email FROM invites WHERE email = $1', [key]);
  return Boolean(row);
}

export async function claimInvite(email, userId) {
  const key = normalize(email);
  if (!key) return;

  await query(
    `UPDATE invites SET claimed_by = $2, claimed_at = now()
      WHERE email = $1 AND claimed_by IS NULL`,
    [key, userId]
  );
}

export async function addInvite(email) {
  const key = normalize(email);
  if (!key) throw new Error(`Not a usable email: "${email}"`);

  return queryOne(
    `INSERT INTO invites (email) VALUES ($1)
       ON CONFLICT (email) DO NOTHING
     RETURNING email`,
    [key]
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test db/invites.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Write the operator script**

Create `server/scripts/invite.js`:

```js
/**
 * Allowlist an email so it can provision a number.
 *
 *   node --env-file=../.env scripts/invite.js someone@example.com
 */
import { addInvite } from '../db/invites.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: invite.js <email>');
  process.exit(1);
}

try {
  await addInvite(email);
  console.log(`Invited ${email.toLowerCase()}`);
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

- [ ] **Step 6: Commit**

```bash
git add server/db/invites.js server/db/invites.test.js server/scripts/invite.js
git commit -m "feat: invite allowlist"
```

---

### Task 5: Pooled number assignment

**Files:**
- Modify: `server/db/agent-numbers.js`, `server/db/agent-numbers.test.js`
- Create: `server/scripts/add-number.js`
- Delete: `server/scripts/assign-number.js`

**Interfaces:**
- Produces:
  - `findUserByAgentNumber(agentNumber): Promise<{id, phone} | undefined>` — same name, now a join
  - `assignFromPool(userId): Promise<{phone} | undefined>` — undefined when the pool is empty
  - `numberForUser(userId): Promise<{phone} | undefined>`
  - `addToPool(phone): Promise<{id, phone}>`

**Why this matters:** `findUserByAgentNumber` is on the inbound call path — it
is how every incoming call finds its owner. It currently reads
`users.agent_number`, which Task 2's migration drops.

- [ ] **Step 1: Rewrite the tests**

Replace the whole of `server/db/agent-numbers.test.js`:

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

const { addToPool, assignFromPool, findUserByAgentNumber, numberForUser } =
  await import('./agent-numbers.js');

test.beforeEach(() => { statements.length = 0; nextRows = []; });

test('findUserByAgentNumber joins the pool to its owner', async () => {
  nextRows = [{ id: 'u1', phone: '+14155550000' }];

  const user = await findUserByAgentNumber('+1 (415) 555-1111');

  assert.equal(user.id, 'u1');
  assert.match(statements[0].text, /FROM agent_numbers a JOIN users u/);
  assert.match(statements[0].text, /a.user_id IS NOT NULL/);
  assert.deepEqual(statements[0].params, ['+14155551111']);
});

test('findUserByAgentNumber returns undefined for an unassigned number', async () => {
  nextRows = [];
  assert.equal(await findUserByAgentNumber('+14155551111'), undefined);
});

test('findUserByAgentNumber does not query for an unusable number', async () => {
  assert.equal(await findUserByAgentNumber('not-a-number'), undefined);
  assert.equal(statements.length, 0);
});

test('assignFromPool claims a free number atomically', async () => {
  nextRows = [{ phone: '+14155551111' }];

  const assigned = await assignFromPool('u1');

  assert.equal(assigned.phone, '+14155551111');
  // SKIP LOCKED is what stops two simultaneous signups taking one number.
  assert.match(statements[0].text, /FOR UPDATE SKIP LOCKED/);
  assert.match(statements[0].text, /user_id IS NULL/);
  assert.deepEqual(statements[0].params, ['u1']);
});

test('assignFromPool returns undefined when the pool is empty', async () => {
  nextRows = [];
  assert.equal(await assignFromPool('u1'), undefined);
});

test('numberForUser finds an already-assigned number', async () => {
  nextRows = [{ phone: '+14155551111' }];
  const found = await numberForUser('u1');
  assert.equal(found.phone, '+14155551111');
  assert.deepEqual(statements[0].params, ['u1']);
});

test('addToPool normalises and is idempotent', async () => {
  nextRows = [{ id: 'n1', phone: '+14155551111' }];
  await addToPool('+1 (415) 555-1111');
  assert.deepEqual(statements[0].params, ['+14155551111']);
  assert.match(statements[0].text, /ON CONFLICT \(phone\) DO NOTHING/);
});

test('addToPool rejects an unusable number', async () => {
  await assert.rejects(() => addToPool('nope'), /E\.164/);
  assert.equal(statements.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test db/agent-numbers.test.js`
Expected: FAIL — the current implementation queries `users.agent_number`

- [ ] **Step 3: Rewrite the store**

Replace the whole of `server/db/agent-numbers.js`:

```js
import { normalizePhone } from '../lib/phone.js';
import { queryOne } from './pool.js';

/**
 * Which user publishes this number? The inbound call path's first read.
 *
 * Returns undefined rather than throwing: a call to an unassigned number is a
 * routing mistake, not a server error.
 */
export async function findUserByAgentNumber(agentNumber) {
  const normalized = normalizePhone(agentNumber);
  if (!normalized) return undefined;

  return queryOne(
    `SELECT u.id, u.phone FROM agent_numbers a
       JOIN users u ON u.id = a.user_id
      WHERE a.phone = $1 AND a.user_id IS NOT NULL`,
    [normalized]
  );
}

/**
 * Claim a free number from the pool.
 *
 * FOR UPDATE SKIP LOCKED is the whole point: two simultaneous signups take
 * two different rows instead of racing for the same one. An empty pool
 * returns undefined, which the caller reports rather than buying a number.
 */
export async function assignFromPool(userId) {
  return queryOne(
    `UPDATE agent_numbers SET user_id = $1, assigned_at = now(), released_at = NULL
      WHERE id = (SELECT id FROM agent_numbers
                   WHERE user_id IS NULL
                   ORDER BY id LIMIT 1
                   FOR UPDATE SKIP LOCKED)
     RETURNING phone`,
    [userId]
  );
}

export function numberForUser(userId) {
  return queryOne(
    'SELECT phone FROM agent_numbers WHERE user_id = $1 LIMIT 1',
    [userId]
  );
}

export async function addToPool(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error(`Number must be E.164, got "${phone}"`);

  return queryOne(
    `INSERT INTO agent_numbers (phone) VALUES ($1)
       ON CONFLICT (phone) DO NOTHING
     RETURNING id, phone`,
    [normalized]
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test db/agent-numbers.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Replace the operator script**

Delete `server/scripts/assign-number.js` and create `server/scripts/add-number.js`:

```js
/**
 * Put a Twilio number into the pool and point its voice webhook at us.
 *
 *   node --env-file=../.env scripts/add-number.js +14155551111
 *
 * Configuring the webhook here - once, on entry to the pool - is why
 * onboarding never has to call Twilio.
 */
import twilio from 'twilio';
import { config } from '../config.js';
import { addToPool } from '../db/agent-numbers.js';

const phone = process.argv[2];
if (!phone) {
  console.error('Usage: add-number.js <e164-number>');
  process.exit(1);
}

try {
  const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  const [incoming] = await client.incomingPhoneNumbers.list({ phoneNumber: phone });

  if (!incoming) {
    console.error(`${phone} is not owned by this Twilio account. Buy it first.`);
    process.exit(1);
  }

  await client.incomingPhoneNumbers(incoming.sid).update({
    voiceUrl: `${config.publicBaseUrl}/twiml/incoming`,
    voiceMethod: 'POST',
  });

  await addToPool(phone);
  console.log(`${phone} is in the pool, webhook -> ${config.publicBaseUrl}/twiml/incoming`);
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test` from `server/`
Expected: PASS

```bash
git add server/db/agent-numbers.js server/db/agent-numbers.test.js \
        server/scripts/add-number.js
git rm server/scripts/assign-number.js
git commit -m "feat: assign agent numbers atomically from an operator-stocked pool"
```

---

### Task 6: Monthly spending circuit breaker

**Files:**
- Create: `server/lib/limits.js`, `server/lib/limits.test.js`
- Modify: `server/routes/inbound.js`, `server/routes/calls.js`

**Interfaces:**
- Consumes: `queryOne` from `server/db/pool.js`; `currentMonth` from `server/lib/users.js`.
- Produces:
  - `usageFor(user): Promise<{minutes_used, minutes_limit, warning, blocked}>`
  - `WARN_AT = 0.8`

- [ ] **Step 1: Write the failing tests**

Create `server/lib/limits.test.js`:

```js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let usedMinutes = 0;

mock.module('../db/pool.js', {
  namedExports: {
    query: async () => ({ rows: [] }),
    queryOne: async () => ({ minutes_used: usedMinutes }),
    getPool: () => ({}),
  },
});

const { WARN_AT, usageFor } = await import('./limits.js');

const user = { id: 'u1', monthly_minute_limit: 3000 };

test.beforeEach(() => { usedMinutes = 0; });

test('normal use is neither warning nor blocked', async () => {
  usedMinutes = 100;
  const usage = await usageFor(user);
  assert.equal(usage.minutes_used, 100);
  assert.equal(usage.minutes_limit, 3000);
  assert.equal(usage.warning, false);
  assert.equal(usage.blocked, false);
});

test('warns at 80% but does not block', async () => {
  usedMinutes = 3000 * WARN_AT;
  const usage = await usageFor(user);
  assert.equal(usage.warning, true);
  assert.equal(usage.blocked, false);
});

test('blocks at the limit', async () => {
  usedMinutes = 3000;
  const usage = await usageFor(user);
  assert.equal(usage.blocked, true);
});

test('blocks beyond the limit', async () => {
  usedMinutes = 4200;
  const usage = await usageFor(user);
  assert.equal(usage.blocked, true);
});

test('treats a missing usage row as zero', async () => {
  usedMinutes = null;
  const usage = await usageFor(user);
  assert.equal(usage.minutes_used, 0);
  assert.equal(usage.blocked, false);
});

test('falls back to the default limit when the user has none', async () => {
  usedMinutes = 10;
  const usage = await usageFor({ id: 'u1', monthly_minute_limit: null });
  assert.equal(usage.minutes_limit, 3000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test lib/limits.test.js`
Expected: FAIL, `Cannot find module './limits.js'`

- [ ] **Step 3: Implement the breaker**

Create `server/lib/limits.js`:

```js
import { queryOne } from '../db/pool.js';
import { currentMonth } from './users.js';

/** Surfaced to the app so Settings can warn before anything is refused. */
export const WARN_AT = 0.8;

const DEFAULT_LIMIT = 3000;

/**
 * This is a circuit breaker, not a billing quota.
 *
 * Blocking an inbound call means refusing a customer's call to the user's
 * business line, and you cannot soften that by connecting-without-recording
 * because the bridged minutes *are* the cost. So the limit is set far above
 * normal use: its job is to stop a runaway - a robocall loop, a bug, an
 * attack - not to meter anybody.
 */
export async function usageFor(user) {
  const limit = user.monthly_minute_limit ?? DEFAULT_LIMIT;

  const row = await queryOne(
    'SELECT minutes_used FROM usage_minutes WHERE user_id = $1 AND month = $2',
    [user.id, currentMonth()]
  );

  const used = Number(row?.minutes_used ?? 0) || 0;

  return {
    minutes_used: used,
    minutes_limit: limit,
    warning: used >= limit * WARN_AT && used < limit,
    blocked: used >= limit,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test lib/limits.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Block inbound calls over the ceiling**

In `server/routes/inbound.js`, add the import:

```js
import { usageFor } from '../lib/limits.js';
```

and insert this immediately after the `if (!user) { ... }` block, before
`resolveContact` is called:

```js
  // Refuse rather than bridge: connecting is what costs money. Best-effort -
  // if the check itself fails we connect, because a broken meter must not
  // take down someone's business line.
  const usage = await usageFor(user).catch((err) => {
    console.error('[inbound] usage check failed, allowing call', err);
    return { blocked: false };
  });

  if (usage.blocked) {
    await queryOne(
      `INSERT INTO calls (user_id, user_phone, destination, twilio_call_sid,
                          direction, status, error)
       VALUES ($1, $2, $3, $4, 'inbound', 'blocked', 'Monthly minute limit reached')
       RETURNING id`,
      [user.id, user.phone, caller, CallSid]
    ).catch((err) => console.error('[inbound] could not record blocked call', err));

    twiml.say('This number has reached its monthly limit. Please try again later.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }
```

- [ ] **Step 6: Block outbound calls and expose the warning**

In `server/routes/calls.js`, add the import:

```js
import { usageFor } from '../lib/limits.js';
```

In the `POST /` handler, immediately after `const user = await resolveUser(req);`:

```js
    const usage = await usageFor(user);
    if (usage.blocked) {
      throw new HttpError(
        429,
        'minute_limit_reached',
        `Monthly limit of ${usage.minutes_limit} minutes reached`
      );
    }
```

Replace the body of the `usageRouter.get('/')` handler with:

```js
    const user = await resolveUser(req);
    const usage = await usageFor(user);

    res.json({ month: currentMonth(), tier: user.tier, ...usage });
```

- [ ] **Step 7: Run the whole suite and commit**

Run: `npm test` from `server/`
Expected: PASS

```bash
git add server/lib/limits.js server/lib/limits.test.js \
        server/routes/inbound.js server/routes/calls.js
git commit -m "feat: monthly minute circuit breaker on inbound and outbound calls"
```

---

### Task 7: Provisioning endpoint

**Files:**
- Modify: `server/routes/calls.js`
- Create: `server/routes/provision.test.js`
- Modify: `server/app.js`

**Interfaces:**
- Consumes: `isInvited`, `claimInvite` (Task 4); `assignFromPool`, `numberForUser` (Task 5); `setUserPhone` (Task 2).
- Produces: `POST /api/provision` and an updated `GET /api/me` returning `{ phone, email, tier, agent_number, provisioned }`.

- [ ] **Step 1: Write the failing tests**

Create `server/routes/provision.test.js`:

```js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_BASE_URL = 'https://agent.example.com';
process.env.TWILIO_AUTH_TOKEN = 'test-token';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';

let user;
let invited;
let poolNumber;
let existingNumber;
const claimed = [];

mock.module('../lib/google-auth.js', {
  namedExports: {
    verifyGoogleToken: async () => ({ googleId: 'g1', email: 'a@b.com', name: 'Ada' }),
    TokenInvalidError: class extends Error { status = 401; },
    TokenUnverifiableError: class extends Error { status = 503; },
  },
});

mock.module('../db/users.js', {
  namedExports: {
    findOrCreateByGoogle: async () => user,
    setUserPhone: async (id, phone) => ({ ...user, phone }),
    getUserById: async () => user,
  },
});

mock.module('../db/invites.js', {
  namedExports: {
    isInvited: async () => invited,
    claimInvite: async (email, id) => claimed.push({ email, id }),
    addInvite: async () => ({}),
  },
});

mock.module('../db/agent-numbers.js', {
  namedExports: {
    assignFromPool: async () => poolNumber,
    numberForUser: async () => existingNumber,
    findUserByAgentNumber: async () => undefined,
    addToPool: async () => ({}),
  },
});

mock.module('../db/pool.js', {
  namedExports: {
    query: async () => ({ rows: [] }),
    queryOne: async () => undefined,
    getPool: () => ({}),
  },
});

const { createApp } = await import('../app.js');
const app = createApp();

async function post(path, body) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

test.beforeEach(() => {
  user = { id: 'u1', email: 'a@b.com', phone: '+14155550000', tier: 'free' };
  invited = true;
  poolNumber = { phone: '+14155551111' };
  existingNumber = undefined;
  claimed.length = 0;
});

test('provisions a number for an invited user', async () => {
  const res = await post('/api/provision', { phone: '+14155550000' });

  assert.equal(res.status, 201);
  assert.equal(res.body.agent_number, '+14155551111');
  assert.deepEqual(claimed, [{ email: 'a@b.com', id: 'u1' }]);
});

test('refuses an uninvited user with 403', async () => {
  invited = false;
  const res = await post('/api/provision', { phone: '+14155550000' });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'not_invited');
});

test('reports an empty pool rather than half-completing', async () => {
  poolNumber = undefined;
  const res = await post('/api/provision', { phone: '+14155550000' });

  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'no_numbers_available');
});

test('is idempotent - a user who already has a number keeps it', async () => {
  existingNumber = { phone: '+14155559999' };
  const res = await post('/api/provision', { phone: '+14155550000' });

  assert.equal(res.status, 200);
  assert.equal(res.body.agent_number, '+14155559999');
});

test('rejects a handset number that is not E.164', async () => {
  const res = await post('/api/provision', { phone: '415-555-0000' });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test routes/provision.test.js`
Expected: FAIL, 404 — `/api/provision` does not exist

- [ ] **Step 3: Implement the endpoint**

In `server/routes/calls.js`, add the imports:

```js
import { assignFromPool, numberForUser } from '../db/agent-numbers.js';
import { claimInvite, isInvited } from '../db/invites.js';
import { setUserPhone } from '../db/users.js';
import { isE164 } from '../lib/phone.js';
```

and append:

```js
export const provisionRouter = express.Router();

/**
 * Finish onboarding: record the handset and hand out an agent number.
 *
 * The allowlist is checked here rather than at sign-in so an uninvited person
 * gets a clear answer instead of a login that mysteriously fails.
 */
provisionRouter.post('/', async (req, res, next) => {
  try {
    const user = await resolveUser(req);
    const { phone } = req.body ?? {};

    if (!isE164(phone)) {
      throw new HttpError(
        400, 'invalid_phone',
        'phone must be an E.164 number, e.g. +14155550000'
      );
    }

    // Idempotent: re-running onboarding must not consume a second number.
    const existing = await numberForUser(user.id);
    if (existing) {
      await setUserPhone(user.id, phone);
      return res.json({ agent_number: existing.phone, provisioned: true });
    }

    if (!(await isInvited(user.email))) {
      throw new HttpError(
        403, 'not_invited',
        'This account is not on the list yet'
      );
    }

    const assigned = await assignFromPool(user.id);
    if (!assigned) {
      throw new HttpError(
        503, 'no_numbers_available',
        'No numbers are free right now'
      );
    }

    await setUserPhone(user.id, phone);
    await claimInvite(user.email, user.id);

    res.status(201).json({ agent_number: assigned.phone, provisioned: true });
  } catch (err) {
    next(err);
  }
});
```

Replace the body of the `meRouter.get('/')` handler with:

```js
    const user = await resolveUser(req);
    const assigned = await numberForUser(user.id);

    res.json({
      email: user.email,
      name: user.name,
      phone: user.phone ?? null,
      tier: user.tier,
      agent_number: assigned?.phone ?? null,
      provisioned: Boolean(assigned),
    });
```

- [ ] **Step 4: Mount the router**

In `server/app.js`, change the calls import to include `provisionRouter` and add
the mount beside the others:

```js
import { callsRouter, meRouter, provisionRouter, usageRouter } from './routes/calls.js';
```

```js
  app.use('/api/provision', provisionRouter);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test routes/provision.test.js`
Expected: PASS, 5 tests

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test` from `server/`
Expected: PASS

```bash
git add server/routes/calls.js server/routes/provision.test.js server/app.js
git commit -m "feat: provisioning endpoint with allowlist and pooled assignment"
```

---

### Task 8: App authentication plumbing

**Files:**
- Create: `src/auth.ts`
- Modify: `src/AppContext.tsx`, `src/api.ts`, `app.json`, `package.json`

**Interfaces:**
- Produces:
  - `useGoogleAuth(): { promptAsync, request }`
  - `saveToken(token)`, `loadToken()`, `clearToken()` from `src/auth.ts`
  - `AppContext` gains `idToken: string | null`, `signIn()`, `signOut()`

- [ ] **Step 1: Install the auth packages**

Run from the repo root:

```bash
npx expo install expo-auth-session expo-web-browser expo-secure-store expo-crypto
```

- [ ] **Step 2: Add the client id to app config**

In `app.json`, remove the `android.permissions` block entirely — the app is
server-recorded and has never used the microphone, so `RECORD_AUDIO` only
attracts Play Store scrutiny. The `android` object keeps its other keys.

The Google client id is supplied at runtime as `EXPO_PUBLIC_GOOGLE_CLIENT_ID`;
add it to `.env.example`:

```
EXPO_PUBLIC_GOOGLE_CLIENT_ID=<oauth-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_ID=<the same value; the server verifies tokens against it>
```

- [ ] **Step 3: Write the token store**

Create `src/auth.ts`:

```ts
import * as Google from 'expo-auth-session/providers/google';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

const KEY = 'dimts.idToken';

/**
 * The ID token is a bearer credential, so it lives in the keystore rather
 * than AsyncStorage alongside the theme preference.
 */
export async function saveToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, token);
  } catch {
    // A device without a secure store still works for this session.
  }
}

export async function loadToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    // Nothing to clean up.
  }
}

export function useGoogleAuth() {
  const [request, , promptAsync] = Google.useIdTokenAuthRequest({
    clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
  });

  return { request, promptAsync };
}
```

- [ ] **Step 4: Hold the token in context**

In `src/AppContext.tsx`, replace `userPhone`/`setUserPhone` in the `AppState`
type with the auth fields, keeping `lang` and `autoRecord` exactly as they are:

```ts
type AppState = {
  ready: boolean;
  lang: Lang;
  idToken: string | null;
  autoRecord: boolean;
  setLang: (lang: Lang) => void;
  setIdToken: (token: string | null) => void;
  setAutoRecord: (on: boolean) => void;
  t: (key: Key) => string;
};
```

In the provider, replace the phone state with token state:

```tsx
  const [idToken, setToken] = useState<string | null>(null);
```

In the loading effect, replace the `KEYS.phone` read with a keystore read —
import `loadToken`, `saveToken` and `clearToken` from `./auth`:

```tsx
        const stored = await loadToken();
        if (stored) setToken(stored);
```

and replace `setUserPhone` with:

```tsx
  const setIdToken = useCallback((next: string | null) => {
    setToken(next);
    (next ? saveToken(next) : clearToken()).catch(() => {});
  }, []);
```

Update the `useMemo` value and its dependency array to carry `idToken` and
`setIdToken` in place of `userPhone` and `setUserPhone`. Delete `KEYS.phone`.

- [ ] **Step 5: Send the token instead of the header**

In `src/api.ts`, replace `authHeaders` and change every function's first
parameter from `userPhone` to `token`:

```ts
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
```

The remaining functions keep their shapes; only the parameter name and what it
is passed to `authHeaders` change. Add the two new calls:

```ts
export type Me = {
  email: string | null;
  name: string | null;
  phone: string | null;
  tier: string;
  agent_number: string | null;
  provisioned: boolean;
};

export function getMe(token: string) {
  return request<Me>('/api/me', token);
}

export function provision(phone: string, token: string) {
  return request<{ agent_number: string; provisioned: boolean }>(
    '/api/provision',
    token,
    { method: 'POST', body: JSON.stringify({ phone }) }
  );
}
```

Finally, map the server's error codes onto i18n keys so provisioning failures
read properly in both languages. Replace the non-2xx branch of `request` with:

```ts
/** Server error codes that deserve their own message rather than a generic one. */
const ERROR_KEYS: Record<string, Key> = {
  not_invited: 'errorNotInvited',
  no_numbers_available: 'errorNoNumbers',
  minute_limit_reached: 'errorLimitReached',
};

  if (!response.ok) {
    const detail = await response.text().catch(() => '');

    let code: string | undefined;
    try {
      code = JSON.parse(detail)?.error;
    } catch {
      // A non-JSON body just means we fall through to the generic message.
    }

    throw new ApiError(
      (code && ERROR_KEYS[code]) || 'errorGeneric',
      `HTTP ${response.status}: ${detail}`
    );
  }
```

`Key` is already imported at the top of `src/api.ts`.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit` from the repo root.
Expected: errors in the screens, which Task 9 fixes. `src/auth.ts`,
`src/AppContext.tsx` and `src/api.ts` themselves must be clean.

- [ ] **Step 7: Commit**

```bash
git add src/auth.ts src/AppContext.tsx src/api.ts app.json package.json \
        package-lock.json .env.example
git commit -m "feat: Google sign-in plumbing and bearer tokens in the app"
```

---

### Task 9: Onboarding screens and cleanups

**Files:**
- Create: `app/sign-in.tsx`, `app/onboarding/phone.tsx`, `app/onboarding/confirm.tsx`, `app/onboarding/number.tsx`
- Delete: `app/onboarding.tsx`
- Modify: `app/_layout.tsx`, `app/settings.tsx`, `src/i18n.ts`

- [ ] **Step 1: Add the strings**

In `src/i18n.ts`, add to `en` before the `// Errors` comment:

```ts
  signInTitle: 'Dimts',
  signInBody: 'Records your calls and writes the notes for you.',
  signInWithGoogle: 'Continue with Google',
  yourHandset: 'Your phone number',
  yourHandsetBody: 'We ring this phone when a call comes in.',
  confirmTitle: 'Is this right?',
  confirmBody: 'We will ring this number for every call. Check it carefully.',
  confirmYes: 'Yes, that is my number',
  confirmEdit: 'Change it',
  yourAgentNumber: 'Your business number',
  yourAgentNumberBody: 'Give this number to people who call you. Calls to it are recorded and summarised.',
  copyNumber: 'Copy',
  copied: 'Copied',
  finish: 'Start using Dimts',
  signOut: 'Sign out',
```

and the matching entries to `am`:

```ts
  signInTitle: 'ድምፅ',
  signInBody: 'ጥሪዎችዎን ይቀዳል፣ ማስታወሻውንም ይጽፍልዎታል።',
  signInWithGoogle: 'በGoogle ይቀጥሉ',
  yourHandset: 'የስልክ ቁጥርዎ',
  yourHandsetBody: 'ጥሪ ሲመጣ ይህን ስልክ እንደውላለን።',
  confirmTitle: 'ትክክል ነው?',
  confirmBody: 'ለእያንዳንዱ ጥሪ ይህን ቁጥር እንደውላለን። በጥንቃቄ ያረጋግጡ።',
  confirmYes: 'አዎ፣ ቁጥሬ ነው',
  confirmEdit: 'ቀይረው',
  yourAgentNumber: 'የንግድ ቁጥርዎ',
  yourAgentNumberBody: 'ይህን ቁጥር ለሚደውሉልዎ ሰዎች ይስጡ። ወደዚህ የሚደረጉ ጥሪዎች ተቀድተው ይጠቃለላሉ።',
  copyNumber: 'ቅዳ',
  copied: 'ተቀድቷል',
  finish: 'ድምፅን መጠቀም ጀምር',
  signOut: 'ውጣ',
```

Also add these error keys to both dictionaries:

```ts
  errorNotInvited: 'This account is not on the list yet.',
  errorNoNumbers: 'No numbers are available right now. Try again shortly.',
  errorLimitReached: 'This account has reached its monthly minute limit.',
```

```ts
  errorNotInvited: 'ይህ መለያ እስካሁን በዝርዝሩ ውስጥ የለም።',
  errorNoNumbers: 'አሁን ምንም ቁጥር የለም። ትንሽ ቆይተው ይሞክሩ።',
  errorLimitReached: 'ይህ መለያ የወሩን የደቂቃ ገደብ ደርሷል።',
```

- [ ] **Step 2: Write the sign-in screen**

Create `app/sign-in.tsx`:

```tsx
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../src/AppContext';
import { useGoogleAuth } from '../src/auth';
import { Txt } from '../src/components/Txt';
import { color, radius, space } from '../src/theme';

export default function SignIn() {
  const { t, setIdToken } = useApp();
  const { request, promptAsync } = useGoogleAuth();

  useEffect(() => {
    // The router redirects once a token lands in context.
  }, []);

  async function signIn() {
    const result = await promptAsync();
    if (result?.type === 'success' && result.params?.id_token) {
      setIdToken(result.params.id_token);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.ink, justifyContent: 'center', padding: space.xl, gap: space.lg }}>
      <View style={{ gap: space.sm }}>
        <Txt size="display" weight="bold">{t('signInTitle')}</Txt>
        <Txt tone="muted" style={{ maxWidth: 300 }}>{t('signInBody')}</Txt>
      </View>

      <Pressable
        accessibilityRole="button"
        disabled={!request}
        onPress={signIn}
        style={{
          alignItems: 'center', paddingVertical: space.md,
          borderRadius: radius.md,
          backgroundColor: request ? color.saffron : color.line,
        }}
      >
        <Txt size="subhead" weight="bold" style={{ color: color.ink }}>
          {t('signInWithGoogle')}
        </Txt>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 3: Write the handset entry and confirmation screens**

Create `app/onboarding/phone.tsx`:

```tsx
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { Txt } from '../../src/components/Txt';
import { color, font, radius, space, type } from '../../src/theme';

export default function HandsetEntry() {
  const { t } = useApp();
  const router = useRouter();
  const [value, setValue] = useState('+1');

  const valid = /^\+[1-9]\d{6,14}$/.test(value);

  return (
    <View style={{ flex: 1, backgroundColor: color.ink, justifyContent: 'center', padding: space.xl, gap: space.lg }}>
      <View style={{ gap: space.sm }}>
        <Txt size="screen" weight="bold">{t('yourHandset')}</Txt>
        <Txt tone="muted">{t('yourHandsetBody')}</Txt>
      </View>

      <TextInput
        value={value}
        onChangeText={setValue}
        keyboardType="phone-pad"
        autoFocus
        accessibilityLabel={t('yourHandset')}
        style={{
          fontFamily: font.regular, fontSize: type.title, color: color.parchment,
          backgroundColor: color.surface, borderRadius: radius.md,
          borderWidth: 1, borderColor: color.line,
          paddingHorizontal: space.md, paddingVertical: space.md,
        }}
      />

      <Pressable
        accessibilityRole="button"
        disabled={!valid}
        onPress={() => router.push(`/onboarding/confirm?phone=${encodeURIComponent(value)}`)}
        style={{
          alignItems: 'center', paddingVertical: space.md, borderRadius: radius.md,
          backgroundColor: valid ? color.saffron : color.line,
        }}
      >
        <Txt size="subhead" weight="bold" style={{ color: valid ? color.ink : color.faint }}>
          {t('continue')}
        </Txt>
      </Pressable>
    </View>
  );
}
```

Create `app/onboarding/confirm.tsx`:

```tsx
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { ApiError, provision } from '../../src/api';
import { Banner } from '../../src/components/Banner';
import { Txt } from '../../src/components/Txt';
import type { Key } from '../../src/i18n';
import { color, radius, space } from '../../src/theme';

/**
 * The typo guard. We do not verify the number by SMS or a call, so this
 * screen is the only thing standing between a mistyped digit and repeatedly
 * ringing - and recording - a stranger.
 */
export default function ConfirmHandset() {
  const { t, idToken } = useApp();
  const router = useRouter();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const [errorKey, setErrorKey] = useState<Key | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!idToken || !phone || busy) return;
    setBusy(true);
    try {
      const { agent_number } = await provision(phone, idToken);
      router.replace(`/onboarding/number?number=${encodeURIComponent(agent_number)}`);
    } catch (err) {
      setErrorKey(err instanceof ApiError ? err.messageKey : 'errorGeneric');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.ink, justifyContent: 'center', padding: space.xl, gap: space.lg }}>
      {errorKey && <Banner message={t(errorKey)} onDismiss={() => setErrorKey(null)} />}

      <View style={{ gap: space.sm }}>
        <Txt size="screen" weight="bold">{t('confirmTitle')}</Txt>
        <Txt tone="muted">{t('confirmBody')}</Txt>
      </View>

      <Txt size="display" weight="bold" style={{ textAlign: 'center' }}>{phone}</Txt>

      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={confirm}
        style={{
          alignItems: 'center', paddingVertical: space.md,
          borderRadius: radius.md, backgroundColor: color.saffron,
        }}
      >
        <Txt size="subhead" weight="bold" style={{ color: color.ink }}>{t('confirmYes')}</Txt>
      </Pressable>

      <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={12}>
        <Txt tone="accent" style={{ textAlign: 'center' }}>{t('confirmEdit')}</Txt>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 4: Write the number screen**

Create `app/onboarding/number.tsx`:

```tsx
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { Txt } from '../../src/components/Txt';
import { color, radius, space } from '../../src/theme';

export default function AgentNumber() {
  const { t } = useApp();
  const router = useRouter();
  const { number } = useLocalSearchParams<{ number: string }>();
  const [copied, setCopied] = useState(false);

  return (
    <View style={{ flex: 1, backgroundColor: color.ink, justifyContent: 'center', padding: space.xl, gap: space.lg }}>
      <View style={{ gap: space.sm }}>
        <Txt size="screen" weight="bold">{t('yourAgentNumber')}</Txt>
        <Txt tone="muted">{t('yourAgentNumberBody')}</Txt>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={async () => {
          await Clipboard.setStringAsync(String(number));
          setCopied(true);
        }}
        style={{
          alignItems: 'center', gap: space.sm, paddingVertical: space.lg,
          borderRadius: radius.md, backgroundColor: color.surface,
        }}
      >
        <Txt size="display" weight="bold">{number}</Txt>
        <Txt size="caption" tone="accent">{copied ? t('copied') : t('copyNumber')}</Txt>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.replace('/')}
        style={{
          alignItems: 'center', paddingVertical: space.md,
          borderRadius: radius.md, backgroundColor: color.saffron,
        }}
      >
        <Txt size="subhead" weight="bold" style={{ color: color.ink }}>{t('finish')}</Txt>
      </Pressable>
    </View>
  );
}
```

Run from the repo root: `npx expo install expo-clipboard`

- [ ] **Step 5: Route by auth and provisioning state**

Delete `app/onboarding.tsx`. In `app/_layout.tsx`, replace the `Gate` component's
effect and add the new screens to the Stack:

```tsx
function Gate() {
  const { ready, idToken } = useApp();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const onAuthScreen = segments[0] === 'sign-in' || segments[0] === 'onboarding';

    if (!idToken && !onAuthScreen) router.replace('/sign-in');
    else if (idToken && segments[0] === 'sign-in') router.replace('/onboarding/phone');
  }, [ready, idToken, segments, router]);
```

and in the returned `<Stack>`, replace the `onboarding` screen with:

```tsx
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding/phone" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding/confirm" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding/number" options={{ headerShown: false }} />
```

- [ ] **Step 6: Show the agent number and sign-out in Settings**

In `app/settings.tsx`, replace the `yourNumber` section with one driven by
`getMe`, and add sign-out. Import `getMe`, `type Me`, and `useEffect`/`useState`:

```tsx
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (!idToken) return;
    getMe(idToken).then(setMe).catch(() => {});
  }, [idToken]);
```

```tsx
      <Section title={t('yourAgentNumber')}>
        <Txt size="subhead">{me?.agent_number ?? '—'}</Txt>
      </Section>

      <Section title={t('yourHandset')}>
        <Txt size="subhead">{me?.phone ?? '—'}</Txt>
      </Section>

      <Pressable accessibilityRole="button" onPress={() => setIdToken(null)} hitSlop={12}>
        <Txt tone="accent" weight="bold">{t('signOut')}</Txt>
      </Pressable>
```

Take `idToken` and `setIdToken` from `useApp()` in place of `userPhone` and
`setUserPhone`, and update the usage meter to read `minutes_limit` alongside
`minutes_used`.

- [ ] **Step 7: Update every remaining caller of the old auth**

Run: `npx tsc --noEmit` from the repo root.

Every screen that passed `userPhone` to an API function now passes `idToken`.
The affected files are `app/(tabs)/index.tsx`, `app/(tabs)/notes.tsx`,
`app/call/[id].tsx`, `src/useCalls.ts` and `src/components/CallPlayer.tsx` —
in `CallPlayer` the `AudioSource` headers become
`authHeaders(idToken)`, imported from `src/api.ts`, rather than a hand-built
`Authorization` string - one place decides how the app authenticates.

Expected: exit 0.

- [ ] **Step 8: Verify the app bundles**

Run: `npx expo export --platform android --output-dir "$SCRATCH/onboarding-check"`
from the repo root, where `$SCRATCH` is any writable temporary directory.
Expected: "Android Bundled" with no errors.

- [ ] **Step 9: Commit**

```bash
git add app/ src/ package.json package-lock.json
git commit -m "feat: Google sign-in and onboarding screens; drop RECORD_AUDIO"
```

---

## Manual verification

Requires a Google OAuth client id, the Supabase migration applied, and at
least one Twilio number in the pool.

1. Create an OAuth client in Google Cloud Console (Android + Web), set
   `EXPO_PUBLIC_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_ID` to it.
2. `node --env-file=../.env scripts/invite.js you@gmail.com` from `server/`.
3. `node --env-file=../.env scripts/add-number.js +1...` — confirm it reports
   the webhook was set.
4. Start the server and tunnel; run the app with `npx expo start`.
5. Sign in with Google. Expected: handset entry, then the confirmation screen
   showing the number you typed.
6. Confirm. Expected: an agent number appears; check Supabase that
   `agent_numbers.user_id` is set and `invites.claimed_by` is populated.
7. **Idempotency:** sign out, sign back in, run onboarding again. You must get
   the *same* number back, and the pool must not have shrunk.
8. **Allowlist:** sign in with a Google account you have not invited. Expected:
   a clear "not on the list" message at provisioning, not a broken login.
9. **Empty pool:** assign every pooled number, then try a new account.
   Expected: "no numbers available", and no Twilio purchase.
10. **Old header is dead:** `curl -H 'x-user-phone: +14155550000' <base>/api/calls`
    must return 401.
11. **Circuit breaker:** set `monthly_minute_limit` to 0 for your user, then
    call the agent number. Expected: the spoken limit message, and a `blocked`
    row in `calls` — your handset must not ring.

## Self-review notes

Spec coverage checked section by section. §3 identity is Tasks 1–3; §4
allowlist is Task 4; §5 handset confirmation is Task 9 Step 3; §6 pooled
provisioning is Tasks 5 and 7; §7 ceiling is Task 6; §8 flow is Task 9; §9
failure handling is distributed (401/503 in Task 1, allowlist 403 and empty
pool 503 in Task 7); §10 testing is in every task; §11 cleanups are Task 8
Step 2 and Task 9 Step 6; §12 data model is Task 2.

The `agent_number` drop identified in §12 as touching the inbound call path is
Task 5, which rewrites `findUserByAgentNumber` as a join and adds a test for
it — the existing inbound tests mock that function and would otherwise have
hidden the change.
