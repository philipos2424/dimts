# Onboarding and Identity — Design

**Date:** 2026-09-03
**Status:** Approved for planning
**Parent spec:** `docs/superpowers/specs/2026-09-03-call-agent-design.md`

---

## 1. Problem

The call agent works but nobody except the developer can use it.

Today an account is created by `server/scripts/assign-number.js`, a script the
operator runs by hand, and the app identifies itself with an `x-user-phone`
header that anyone can set to anyone's number. `GET /api/me` exists but no
screen consumes it, so a user cannot even see the number they were given.

Three concrete consequences:

- **There is no authentication.** Setting a header to someone else's number
  reads their calls and transcripts.
- **A second person cannot sign up** without the developer running a script.
- **Nothing stops a signup spending money.** Numbers bill monthly and calls
  bill per minute, with no ceiling on either.

## 2. Scope

Replace the operator script and the header with real sign-in, an invite-gated
signup, pooled number assignment, and a spending circuit breaker.

**In scope:** Google sign-in, the identity migration, an invite allowlist,
atomic number assignment from a pool, a monthly minute ceiling, and the
onboarding screens.

**Out of scope:** payments and subscriptions (deferred with the allowlist),
SMS verification (see §5), self-serve number purchasing (the pool is stocked
by the operator), number porting, and team or multi-user accounts.

## 3. Identity

**The Google account is the identity.** `users` gains `google_id TEXT UNIQUE`
plus `email` and `name`. `phone` stops being the identity and becomes an
ordinary column — **nullable**, because a user exists from the moment they
sign in, before they have given us a handset number.

`phone` stays `UNIQUE`: two accounts sharing one handset would mean both
users' calls ringing the same phone.

### Session

The app sends Google's ID token; the server verifies it per request against
Google's published keys, which are cached.

```text
App → Google sign-in (expo-auth-session) → ID token
App → API  with  Authorization: Bearer <google_id_token>
API → verify signature, issuer and audience → google_id, email
```

**Rejected: exchanging Google's token for our own JWT.** It would avoid
Google's hourly expiry, but in return we would own a signing secret, a refresh
path and a revocation story — three things that are easy to get subtly wrong
and that buy nothing at this size. Google's SDK already refreshes on-device.

### The seam

`resolveUser(req)` in `server/lib/users.js` keeps its name and return shape and
reads a bearer token instead of a header. **Every handler in
`server/routes/calls.js` is untouched.** Webhook routes are unaffected — they
authenticate by Twilio signature, which is why separating those routers earlier
pays off here.

### Migration

`users.phone` goes from `NOT NULL` to nullable and keeps its unique
constraint. Existing rows keep their phone and get a null `google_id`, meaning
nobody can sign in as them yet. The table is expected to be empty or nearly so,
so this is a formality rather than a real backfill.

## 4. Invite allowlist

An `invites` table keyed by email, so people can be added without a redeploy.

**Sign-in succeeds for any Google account; the allowlist is checked at
provisioning.** An uninvited person gets a clear "you are not on the list yet"
rather than a login that mysteriously fails.

This defers payments entirely. Its limitation is honest and accepted: it does
not scale past people invited by hand, and Stripe becomes necessary the moment
you want strangers to sign up.

## 5. Phone number handling

The user types their handset number and **confirms it on a separate step**
before it is saved.

**Verification was considered and deliberately skipped.** With Google sign-in
and an invite-only allowlist, only invited people can enter a number at all, so
the malicious case is largely closed. The residual risk is a **typo**: we would
then repeatedly ring, and record, an uninvolved stranger who never consented.
The confirmation step is the mitigation. If that risk shows up in practice, the
cheapest fix is to ring the number during onboarding and ask for a keypress —
this uses Twilio Voice, which we already have, costs about $0.014, and doubles
as an end-to-end test of the exact path the product depends on.

## 6. Number provisioning

**Numbers come from a pool, not a purchase per signup.** The operator buys a
few numbers up front; onboarding assigns an unused one.

Number spend is therefore capped by pool size rather than by signups: an
abandoned account costs nothing new, and releasing a number returns it to the
pool. **Start with three numbers — $3.45/month.**

**Each number's voice webhook is configured once, when it enters the pool** —
never at assignment. This removes an entire class of failure where a number is
assigned but its webhook was never set, so calls silently go nowhere. It also
means **onboarding makes no Twilio API call at all**: assignment is a single
atomic database write.

Assignment must be genuinely atomic or two simultaneous signups get the same
number:

```sql
UPDATE agent_numbers SET user_id = $1, assigned_at = now()
 WHERE id = (SELECT id FROM agent_numbers WHERE user_id IS NULL
             ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
 RETURNING phone;
```

An empty pool returns no row, and onboarding says so rather than
half-completing.

Searching Twilio's inventory is free — only owning a number bills — so a future
version can let users browse area codes while still assigning from stock.

## 7. Spending ceiling

`usage_minutes` is already written on every completed call and read by
`GET /api/usage`. What is missing is enforcement: refuse to originate an
outbound call, and refuse to bridge an inbound one, past the month's ceiling.

**This is a circuit breaker, not a billing quota, and the distinction sets the
value.** Enforcement on an inbound call means refusing a customer's call to the
user's business line. You cannot dodge that by connecting-without-recording,
because the bridged minutes *are* the cost. So its job is to stop a runaway — a
robocall loop, a bug, an attack — not to meter normal use.

**Default: 3,000 minutes per month, warning at 80%.** The warning is a field on
`GET /api/usage` (`minutes_used`, `minutes_limit`, `warning: boolean`) that the
app renders in Settings — not a push notification, which would need the
messaging infrastructure Phase 3 introduces. That is about 50 hours,
comfortably above heavy use, and caps a runaway at roughly $75 rather than
something unbounded. Set it tight and it will cut off a real customer
conversation to save two dollars. Raisable per account.

## 8. Onboarding flow

Four steps. Only the third touches shared state, and none spends money.

1. **Sign in with Google.**
2. **Enter your handset number, then confirm it** on a separate step (§5).
3. **Get assigned a number** from the pool; the allowlist is checked here.
4. **Publish it.** The screen tells the user this is now their business
   number and offers to copy it.

**Forwarding was cut from this phase.** Publishing the assigned number works
immediately and needs no carrier configuration, whereas forwarding makes the
user's business line depend on our uptime and cannot be verified — carriers
offer no reliable way to check whether it was set, and pretending otherwise
would produce a confident lie. Add it when someone asks.

## 9. Failure handling

**Distinguish "your token is bad" from "we could not check your token."** An
expired or malformed token is a **401** and the app signs in again. Google's
key endpoint being unreachable is a **503** — logging everyone out because
Google had a blip would be a self-inflicted outage.

- Not on the allowlist: **403 at provisioning**, not at sign-in.
- Empty pool: a clear message; no purchase is attempted.
- Over the ceiling: outbound is refused with an error the app surfaces.
  Inbound plays a short spoken message to the caller and hangs up rather than
  ringing the user, because connecting is what costs money. The call is still
  recorded as a row with status `blocked`, so the user can see who tried.
- Existing rows with a null `google_id` are simply unreachable by sign-in;
  nothing crashes.

## 10. Testing

Token verification is the security boundary and gets the most coverage: valid,
expired, wrong issuer, wrong audience, malformed, absent. **Tests sign their
own JWTs with a locally generated key pair and inject the key set — no test
touches Google**, consistent with the existing 86 tests, none of which reach a
live service.

Beyond that:

- Allowlist admits an invited email and refuses an uninvited one.
- Pool assignment gives two concurrent claimants different numbers, or a clean
  empty-pool answer.
- The ceiling admits under, warns at 80%, refuses over.
- A row with a phone and a null `google_id` survives the migration.

## 11. Folded-in cleanups

Two small items in the same files, done here rather than left to rot:

- **Surface the agent number in the app.** `GET /api/me` exists with no
  consumer; Settings should show the user their number.
- **Drop `RECORD_AUDIO` from `app.json`.** It was mandated by the original
  `SPEC.md`, but recording is entirely server-side and the app has never
  touched the microphone. It draws Play Store scrutiny for nothing.

## 12. Data model changes

```text
users          + google_id TEXT UNIQUE
               + email TEXT
               + name TEXT
               ~ phone TEXT UNIQUE  (was NOT NULL, now nullable)

invites          email TEXT PRIMARY KEY, invited_at TIMESTAMPTZ,
                 claimed_by UUID REFERENCES users(id), claimed_at TIMESTAMPTZ

agent_numbers    id UUID PK, phone TEXT UNIQUE NOT NULL,
                 user_id UUID REFERENCES users(id),   -- NULL = free
                 assigned_at TIMESTAMPTZ, released_at TIMESTAMPTZ

users          + monthly_minute_limit INT NOT NULL DEFAULT 3000
```

`users.agent_number`, added in the previous phase, is superseded by
`agent_numbers.user_id` and is dropped as part of this migration.

**That drop is on the inbound call path, so it is not a cosmetic change.**
`findUserByAgentNumber()` in `server/db/agent-numbers.js` is how every incoming
call resolves its owner, and it currently reads `users.agent_number`. It must
become a join:

```sql
SELECT u.id, u.phone FROM agent_numbers a
  JOIN users u ON u.id = a.user_id
 WHERE a.phone = $1 AND a.user_id IS NOT NULL
```

Four call sites move with it: that lookup, `assignAgentNumber()` in the same
file, the `agent_number` column in `GET /api/me`
(`server/routes/calls.js:208`), and `server/scripts/assign-number.js` — which
this phase deletes outright, since pooled assignment replaces it.

The existing inbound-route tests already mock `findUserByAgentNumber`, so they
keep passing across the change; that is the signal the seam was drawn in the
right place, not evidence the migration is safe. A test asserting the new join
resolves a pooled number to its owner is required.

## 13. Open risks

- **The pipeline underneath this is still unverified.** No real call has been
  made; whether ElevenLabs authenticates as expected, what shape Scribe
  returns, and whether the summaries are useful are all unknown.
  `server/scripts/try-pipeline.js` answers the first three for about a cent and
  should be run before this phase is built on top of them.
- **The allowlist does not scale.** Stripe is required before strangers can
  sign up, and that is a phase of its own.
- **Skipped phone verification** leaves the typo case open (§5).
- **Google-only sign-in** excludes anyone without a Google account. Acceptable
  for B2B; revisit if it blocks a real user.
