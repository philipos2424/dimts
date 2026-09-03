# Call Agent — Design

**Date:** 2026-09-03
**Status:** Approved for planning
**Supersedes:** the product direction in `SPEC.md` (see "Relationship to SPEC.md")

---

## 1. Problem

Salespeople, founders and consultants run their businesses on phone calls and
remember almost none of it. Notes get taken during some calls and never during
the important ones. Commitments made out loud — "let's meet Tuesday", "send me
a proposal" — die between hanging up and opening a laptop. And when a number
rings back three weeks later, the context from last time is gone.

Meeting notetakers (Granola, Fireflies, Otter) solved this for Zoom and Meet.
Almost nobody has solved it for **phone calls, especially inbound ones**,
because mobile operating systems make capturing them hard.

## 2. What we are building

An agent that sits on the user's business phone line and:

1. **Records both directions** of every call, inbound and outbound.
2. **Identifies who called** from what they say — "hi, this is Phili from
   Amax" becomes a contact named Phili at Amax, with no typing.
3. **Summarizes afterwards** with a full report and suggested next moves.
4. **Acts on what was agreed** — a meeting both parties accepted becomes a
   calendar event; a request for a proposal or email becomes a written draft.
5. **Briefs before answering** — when a known number rings, the previous
   summary and suggested topics are on screen while the phone is still
   ringing.

Point 5 is what makes it an agent rather than a transcript archive: it acts
before the conversation, not only after it.

## 3. Users

**English-first B2B**: salespeople, founders, consultants, recruiters,
agencies. People whose calls carry money and who already accept that their
calls are worth recording.

Explicitly **not** the Amharic diaspora audience of `SPEC.md`. Amharic is not
a v1 requirement. The transcription layer stays provider-swappable so that
market remains reachable later, but nothing in v1 is designed for it.

### Why this is defensible

The AI is not the moat — every notetaker summarizes well. **The phone call is
the moat**, particularly inbound calls on a mobile, because Android's
restrictions mean few competitors bother.

## 4. Platform constraints (researched, not assumed)

These shape the architecture and are not negotiable.

- **Only the default dialer may record calls on Android.** Google banned the
  Accessibility API route for call recording in May 2022 and removed hundreds
  of apps from the Play Store. The policy still stands.
- **iOS cannot record calls at all.** CallKit's Call Directory extension maps
  a number to a name label and nothing more — no audio, no custom UI. This is
  an Android-first product; the bridge architecture below is the only part
  that works on iOS.
- **`CallScreeningService` with `ROLE_CALL_SCREENING` can display a custom
  activity over an incoming call.** The pre-call briefing is achievable
  natively — but the chosen architecture reaches it without needing that role
  at all.
- **The briefing is Android-only even on the bridge.** Android's full-screen
  intent lets a push take over the screen while the phone rings; iOS has no
  equivalent and would show an ordinary notification. So although the bridge
  records iOS calls perfectly well, the flagship pre-call feature is degraded
  there. Android first for that reason, not for recording.
- Any native path requires Kotlin modules and a custom dev build. Expo Go
  cannot run it.

## 5. Architecture

### 5.1 Capture: forwarding bridge

Calls route through our server, which records them and connects them to the
user's handset.

Two ways a user gets on it, both served by the same code:

- **Preferred — publish the agent number as their business line.** For a
  salesperson this is normal and desirable, and requires no carrier
  configuration at all.
- **Fallback — unconditional call forwarding** from their existing number,
  for users who cannot change the number they have already given out.

Conditional forwarding (busy / no-answer) is **not** an option: it captures
only calls the user failed to answer, which is the opposite of what is needed.

Outbound calls reuse the existing dial-through origination, so both directions
bridge through the same recording path and present the same caller ID.

**Why this over becoming the default dialer:** the bridge ships in weeks
rather than months, needs no native modules, carries no Play Store policy
risk, works on iOS, and reuses most of the server already built. Its weakness
is unit economics (§9), which is a scaling problem, not a validation problem.
The open question is whether commitment extraction and briefings are good
enough to pay for — not whether a call can be recorded.

The capture layer sits behind a single interface so that moving to a
default-dialer implementation later is a contained change, the way
`server/services/originate.js` isolates Twilio today.

### 5.2 Inbound call flow

```text
Caller ──► agent number ──► bridge
                              │
                              ├─1. look up cached briefing        (~50ms, primary key)
                              ├─2. push to handset (FCM full-screen intent)
                              ├─3. consent announcement            (§8)
                              └─4. dial handset, record dual-channel
                                        │
                                   conversation
                                        │
                         recording webhook → transcribe → two-pass analysis
                                        │
              ┌──────────────┬──────────┴─────────┬──────────────┐
          summary +      identify caller      commitments      requests
          next moves     → contact record     → calendar       → drafts
                                        │
                              precompute next briefing
```

### 5.3 The latency constraint

The briefing must be on screen **while the phone is ringing** — a 2–5 second
budget. That is far too little to run a language model.

Therefore **briefings are precomputed when the previous call with that contact
ends**, cached keyed by phone number, and step 1 is a primary-key read. This
is the difference between the feature working and it arriving after the user
has already answered. It is the single most important performance decision in
the design.

### 5.4 What is reused

From the existing server: the recording webhook, `defer`/`waitUntil`
background execution, the transcription and summarization services, the
Postgres layer, webhook signature validation, and the reprocess/idempotency
machinery.

New: an inbound TwiML route, contacts, precomputed briefings, FCM push, the
extraction layer, and Google OAuth for Calendar and Gmail.

## 6. Data model

```text
contacts       id, user_id, phone (unique per user), display_name, company,
               name_source: 'user' | 'extracted', name_confidence,
               first_seen_at, last_call_at, notes

briefings      contact_id (PK), user_id, headline, bullets JSONB,
               suggested_topics JSONB, open_commitments JSONB,
               generated_at, source_call_id
               -- one row per contact, written at end of previous call

commitments    id, call_id, user_id, contact_id,
               kind: 'meeting' | 'callback' | 'deadline',
               raw_quote, proposed_by: 'user' | 'contact', accepted BOOLEAN,
               starts_at TIMESTAMPTZ, duration_min, title, confidence,
               status: 'pending' | 'created' | 'dismissed' | 'failed',
               external_event_id, created_at

drafts         id, call_id, user_id, contact_id, kind: 'email' | 'proposal',
               subject, body, to_email, to_email_verified BOOLEAN,
               status: 'draft' | 'saved' | 'dismissed', external_draft_id

integrations   user_id, provider: 'google', access_token, refresh_token,
               scopes, expires_at
               -- tokens encrypted at rest

calls          (existing table) + direction: 'inbound' | 'outbound',
               + contact_id, + next_moves JSONB
```

`status` together with `external_event_id` make agent actions idempotent:
reprocessing a call — already supported for retries — can never create the
same calendar event twice.

## 7. Extraction

### 7.1 Two passes, not one

The summary is generative and may be impressionistic. A calendar event that
creates itself may not be. Splitting them lets the extractor run under a
strict schema at low temperature while the summary stays free. Both passes
together cost roughly $0.0006 per call, so cost is not a reason to merge them.

### 7.2 A commitment requires proposal *and* acceptance

"Let's meet Tuesday" said in passing is not a commitment. "Let's meet Tuesday"
followed by "sure" is.

Dual-channel recording makes this checkable: channel 0 is the user, channel 1
is the caller, so the extractor knows **who said which half**. Requiring a
cross-channel proposal/acceptance pair eliminates most false positives, which
is what makes automatic action defensible at all.

### 7.3 The model never does date arithmetic

Language models are unreliable at resolving "next Tuesday" against a date.
The extractor returns `{relative: "next tuesday", time: "14:00", duration: 30}`
and **application code** resolves it against the call's start timestamp and the
user's timezone.

Wrong dates are the most damaging failure this product can produce, and
date arithmetic is the easiest part to get right deterministically.

### 7.4 Identity and addresses

Caller identification reads the opening of the transcript for a
self-introduction. A contact is auto-named only when confidence is high and
`name_source` is not already `'user'` — **a human-set name always wins.**

Spoken email addresses ("phili at amax dot com") are normalised and stored
with `to_email_verified = false`. A draft is never addressed to a string we
heard exactly once.

## 8. Agent actions and autonomy

The target behaviour is that **calendar events create themselves** with an
undo notification, while **emails and proposals are written to drafts and
never sent** — the blast radius of a wrong calendar entry is a deletion; a
wrongly sent email is unrecoverable.

Drafting behaviour is fixed. Calendar behaviour is reached by the mechanism
below rather than switched on for everyone from day one.

### Autonomy is earned, not granted

New users start in **propose-mode**: the agent surfaces a card and the user
taps to accept. Auto-create switches on for that user after **five consecutive
accepted proposals with no dismissals** — a starting value to tune against
real data, not a derived constant.

Production then keeps measuring, because **the dismiss/undo rate is the live
precision signal**. A user whose dismissal rate climbs is quietly returned to
propose-mode.

This converts "we hope the extraction is accurate" into something
self-correcting, and means a bad prompt change degrades to annoying rather
than damaging.

### Recording consent

Roughly a dozen US states require all-party consent to record. Users will be
recording customers, so this is a live contractual risk, not a theoretical
one. The bridge plays a short announcement to the caller before connecting,
**on by default for inbound calls**. It costs about two seconds and removes a
real liability.

## 9. Cost

Verified against Twilio's published US rates:

| Item | Rate |
|---|---|
| Inbound to a US local number | $0.0085/min |
| Outbound leg to the handset | $0.0140/min |
| Recording | $0.0025/min |
| Number | $1.15/month |
| Transcription (ElevenLabs Scribe v2) | $0.22/hour |
| Both LLM passes | ~$0.0006/call |

**≈ $0.025/min all-in**, dominated by telephony.

A salesperson on the phone two hours a day costs roughly **$65/month in
carrier fees alone**. This sets a hard pricing floor and is the strongest
argument for eventually moving to the default-dialer architecture, where
telephony cost is zero. Treat the bridge as the validation vehicle; its
economics do not scale to a low-priced tier.

## 10. Failure handling

**The AI layer must never be able to break a phone call.** The bridge dials
the handset regardless of whether briefing lookup, database access or push
delivery succeeded. Each is best-effort and wrapped so a failure logs and
continues. A bug in extraction should cost a summary, never a customer
conversation.

- Transcription failure marks the call `failed` and fires **no** agent
  actions, rather than acting on a partial transcript.
- Extraction output failing schema validation is discarded, not coerced.
- Low-confidence commitments are demoted to propose-mode cards regardless of
  the user's autonomy level.
- Google token expiry queues the action and prompts re-auth rather than
  dropping it.
- Briefing generation failure falls back to the previous call's raw summary.

## 11. Testing

- **Golden transcripts in CI**: fixed transcripts with known-correct
  extractions, so a prompt edit that breaks commitment detection fails the
  build.
- **Unit tests** concentrated where bugs are silent and expensive: relative
  date resolution across timezones and DST, channel attribution, email
  normalisation, and the idempotency guard preventing double-booking.
- **An evaluation set** of labelled real calls, tracking commitment precision
  and recall separately. Precision is the gate: a missed event is annoying, a
  phantom event is why someone uninstalls.
- No test touches a live API or places a real call, consistent with the 37
  existing server tests.

## 12. Phasing

Five subsystems, each getting its own implementation plan. Order is forced —
everything downstream waits on capture.

1. **Capture** — inbound bridge, forwarding/number onboarding, dual-channel
   recording, consent announcement, outbound unification.
2. **Understand** — transcription, summary, next moves, caller identification
   and contacts. Largely reuses existing services.
3. **Brief** — precomputed briefings, FCM full-screen push, the ringing-phone
   UI.
4. **Act on calendar** — commitment extraction, deterministic date
   resolution, Google Calendar, the earned-autonomy mechanism.
5. **Act on correspondence** — request detection, Gmail drafts, email address
   verification.

Phase 1 + 2 is the smallest thing that is useful on its own: recorded calls
with summaries and auto-named contacts. Phase 3 is the first feature that is
hard to copy.

## 12a. Future phase: app-to-app calling tier

**Decided 2026-09-03: keep the PSTN bridge as the product, add app-to-app
later as an additional tier. No code changes now.**

Calls placed over WebRTC between two people who both have the app cost
roughly **$0.004/min** (LiveKit: $0.0004/min participant time, $0.004/min
audio recording; self-hosting trades that for server cost) against $0.025/min
for a US bridged call and $0.98/min for an Ethiopian domestic one.

It also removes the hardest technical constraint in §4: Android's recording
ban applies to *cellular* calls, and audio inside our own app is ours. On this
path recording is trivial, inbound and outbound are one code path, and there
are no numbers, carriers, geo permissions or trial restrictions at all.

### Why it cannot replace the bridge

**App-to-app cannot serve cold prospects.** A salesperson's value is capturing
conversations with people outside their organisation, and a prospect will not
install an app to take a first call. App-to-app works only where both parties
are motivated to install — repeat relationships, internal teams, existing
clients — so it is strictly additive to the PSTN bridge, never a replacement.

### Where it wins

Repeat-relationship calling. The clearest case is diaspora managing affairs in
Ethiopia: the same four or five contacts — contractor, lawyer, family, bank —
over and over. That is a five-installs problem, not a network-effects problem,
and PSTN can never serve it because Twilio sells no Ethiopian numbers
(Ethiopia is absent from Twilio's phone-number regulatory list while Kenya,
Nigeria, Ghana, Uganda, Tanzania and South Africa are present), so both legs
would terminate on Ethiopian mobile at $0.4903/min each.

### Blockers to resolve before building it

- **Legal.** Ethiopia's 2012 Telecom Fraud Proclamation, Article 10(3),
  criminalises the *commercial* use of VoIP, written to protect the state
  telecom monopoly. The government stated Skype users would not be prosecuted
  but never amended the text. Sources are 2012-2014 and the country has
  liberalised substantially since 2019, so this may have changed — but
  selling a paid VoIP product is exactly the targeted activity. **Needs an
  Ethiopian telecoms lawyer before any build for that market.** Tolerated
  incidental WhatsApp use is not the same permission.
- **Connectivity.** Ethiopian mobile data quality varies sharply outside
  Addis, and internet shutdowns have been a recurring pattern. A calling
  product that dies during a shutdown is a support cost to price in.
- **Client.** WebRTC needs a custom dev build; Expo Go cannot run it.

### The seam

No preparatory work is needed. `process-recording.js` already depends on a
single audio-retrieval function (`fetchRecording` in `services/originate.js`);
an app-to-app source substitutes there. Adding a `calls.source` discriminator
now would be speculative — do it when the second source exists.

## 13. Relationship to SPEC.md

This is a **different product**, not an extension:

| | `SPEC.md` (Dimts) | This design |
|---|---|---|
| Users | Amharic diaspora, consumer | English-first B2B |
| Calls | Outbound only | Inbound and outbound |
| Capture | Dial-through | Forwarding bridge |
| Value | Transcript + summary | Agent that acts |

**Carries over:** the entire server pipeline — webhooks, `defer`,
transcription, summarization, Postgres, signature validation, reprocessing.

**Does not carry over:** most of the Expo app. It is a dial-through client;
its dialer, recents and notes screens do not survive the change. The bilingual
i18n layer and design system are reusable but not needed for an English-first
v1.

## 14. Open risks

- **Extraction precision is unproven.** The entire product rests on it, and
  no amount of design substitutes for measuring it on real calls. Phase 4
  should not ship auto-create until precision is measured.
- **Unit economics do not scale** on the bridge (§9). Acceptable for
  validation; a blocker for a cheap self-serve tier.
- **Carrier forwarding is fragile** and varies by operator. The
  publish-the-number path avoids it and should be the default.
- **Competitive**: HeyPocket and others occupy this space. The inbound
  mobile-call capture and pre-call briefing are the differentiators; generic
  summarization is not.
