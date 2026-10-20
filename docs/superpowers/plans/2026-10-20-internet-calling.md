# Internet Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people place and answer Dimts calls inside the Dimts app over the internet, alongside the existing phone-ring flow, with the same consent notice, recording and notes.

**Architecture:** The server already starts "leg A" (the owner's side) in one place, `originateCall` in `server/services/originate.js`, and bridges to the other person through TeXML webhooks. Internet calling swaps leg A's target from the owner's phone number to a Telnyx SIP credential the app is logged into (Telnyx WebRTC). Everything after leg A (consent, bridge, recording, notes, billing) is untouched. Incoming business-number calls ring the app and the phone together; the first to answer wins.

**Tech Stack:** Node/Express server (node:test, PGlite), Telnyx TeXML + Telephony Credentials API, `@telnyx/react-native-voice-sdk` (verify the exact package and API in the spike), Expo 57 development build, FCM (Android) / PushKit + CallKit (iOS).

**Spec:** `docs/superpowers/specs/2026-10-20-internet-calling-design.md`

## How people use it

- **Turn it on once.** Settings > Internet calling > On. The app asks for microphone and notification permission. Default is off, so nothing changes for anyone who does not opt in.
- **Calling out.** In the dialer, a switch under the number reads "Call over internet" (remembered). Tap Call: the in-call screen opens and the call connects in a few seconds with no phone ringing first. The other person hears the usual notice, and notes appear after hang-up as today. If the internet is poor, the app says so and offers "Ring my phone instead".
- **Taking calls.** A call to your Dimts business number rings the Dimts app like a WhatsApp call, and your phone as well. Whichever you answer first wins. With the app closed, a push notification shows a full-screen call screen.
- **Normal phone calls are unchanged.** Calls on the phone's own dialer are never recorded or touched by Dimts.
- **What it costs them.** Mobile data (a few MB a minute; measure in the spike). On Wi-Fi it is free.

## Global Constraints

- The existing phone-ring flow stays the default and the fallback; no behavior change for users who do not turn the feature on.
- Recording may start only after the notice, exactly as `recordingAuthorizationSql` requires today. Internet calling must not add a path around it.
- Gulf numbers (`requiresExplicitConsent`) and Ethiopia (+251) are blocked from internet calling: `canUseInternetCalling` returns false for them. Premium-rate and unserved countries stay blocked by `canCall`.
- Never ship the Telnyx API key or a long-lived SIP password in the app. The app receives only a short-lived login token minted per session.
- New copy is English only (no new Amharic).
- Read https://docs.expo.dev/versions/v57.0.0/ before writing any Expo or native config (AGENTS.md).
- Each worktree owns its own `node_modules`; never install through a shared junction.
- Every production deploy and DB migration needs the founder's OK. Apply migrations BEFORE deploying code that reads them.

## Review Focus

- A user with the feature on but the app killed or offline: an incoming call must still ring the phone (no missed calls because the app is down).
- App and phone both answer in the same second: exactly one leg connects and the call is billed and recorded once.
- Token expired or revoked mid-session: the app re-registers or falls back to the phone; it never shows a dead "connecting" screen.
- Mic permission denied, or the user is already on a cellular call: clear message and phone fallback, no recording of silence.
- A user in a blocked country (+251, Gulf) enabling the setting, or being rung by the SIP path: refused server-side, not just hidden in the UI.

---

### Task 1: Spike (throwaway) - prove the unknowns

Gate: stop after this task and show the findings to the founder. Nothing below is built until it passes. Code written here is throwaway and not kept.

**Files:**
- Create: `docs/superpowers/plans/2026-10-20-internet-calling-spike-findings.md` (the only deliverable that is kept)
- Throwaway: a scratch Expo development build in a separate directory, and `server/scripts/spike-sip-call.js`

**Unknowns to answer (record each as PASS/FAIL with evidence):**
1. Does the TeXML calls API accept a SIP URI (`sip:<username>@sip.telnyx.com`) as `to`, so `originateCall` can ring a logged-in app and then fetch `/twiml/bridge`?
2. Does TeXML `<Dial>` ring a `<Number>` and a `<Sip>` at the same time, first answer wins? (Needed for incoming.)
3. Does a call whose leg A is the app still produce the recording webhook, transcript and notes through the existing pipeline, with the notice played before connection?
4. Does the Telnyx React Native SDK work in an Expo 57 development build on a real Android phone: login with a token, place a call, receive a call from an FCM push with the app killed? Which package, API and SDK version are current?
5. How many MB per minute does a call use, and what is the real Telnyx cost per minute for the app leg?

- [ ] **Step 1:** Founder: create a Firebase project and give us `google-services.json`; top up Telnyx. In the Telnyx portal create a SIP Connection with an Android push credential from the Firebase service account JSON.
- [ ] **Step 2:** In `server/scripts/spike-sip-call.js`, create a telephony credential, then call its SIP URI through TeXML from the Dimts number using the real `/twiml/bridge` URL, with the dev build logged in. Record unknown 1.
- [ ] **Step 3:** Change the script to dial the SIP URI and a phone number in one `<Dial>`. Record unknown 2.
- [ ] **Step 4:** Place an app-leg call to a real phone, speak on both sides, hang up. Confirm the call row reaches `ready` with a summary. Record unknown 3.
- [ ] **Step 5:** Kill the app and call it. Record unknown 4, plus the data and cost figures (unknown 5) from Telnyx's usage page.
- [ ] **Step 6:** Write the findings file and commit only it (`git add docs && git commit -m "docs: internet calling spike findings"`). Decide with the founder: go, adjust the tasks below to match the findings, or stop.

### Task 2: Per-user SIP credentials and login tokens (server)

**Files:**
- Create: `server/db/migrations/<date>_voip.sql`, `server/services/voip.js`, `server/routes/voip.js`, `server/services/voip.test.js`, `server/routes/voip.test.js`
- Modify: `server/db/schema.sql` (same DDL), `server/create-app.js` (mount `/api/voip`), `server/lib/destinations.js` (add `canUseInternetCalling`), `server/routes/me.js` (GET and PATCH `internet_calling`), `server/config.js` (`TELNYX_SIP_CONNECTION_ID`)

**Interfaces:**
- Produces: table `voip_credentials(user_id uuid primary key references users, telnyx_credential_id text not null, sip_username text not null, created_at timestamptz default now())` and column `users.internet_calling boolean not null default false`.
- Produces: `canUseInternetCalling(phone: string): boolean` in `destinations.js` (false for +251 and for `requiresExplicitConsent` numbers; otherwise `canCall(phone)`).
- Produces: `ensureCredential(user): Promise<{ credentialId: string, sipUsername: string }>` and `mintLoginToken(user): Promise<{ loginToken: string, sipUsername: string, expiresAt: string }>` in `server/services/voip.js`. All Telnyx REST calls go through one injectable `telnyxFetch` so tests can mock it.
- Produces: `POST /api/voip/token` (signed in): 403 `internet_calling_unavailable` when the country is blocked or the user's `internet_calling` is false; otherwise 200 `{ login_token, sip_username, expires_at }`. `PATCH /api/me` accepts `internet_calling: boolean`; `true` is refused with 403 in a blocked country.

- [ ] **Step 1: Write failing tests.** In `destinations.test.js`: `canUseInternetCalling('+251911234567') === false`, `'+971501234567' === false`, `'+14155552671' === true`. In `voip.test.js`: the first `mintLoginToken` creates a credential (one Telnyx create call) and the second reuses it; the token response never contains a password; a failed Telnyx call throws `HttpError(502, 'voip_unavailable')`. In `voip.routes` tests: 403 when the setting is off, 403 for a +251 user, 200 with the three fields otherwise, and rate limiting via `hit('voip-token:' + user.id, 20, 3600)`.
- [ ] **Step 2:** Run `npm test --prefix server -- --test-name-pattern "voip|internet"`; expect FAIL.
- [ ] **Step 3:** Implement the migration and schema, `canUseInternetCalling`, `voip.js` (Telnyx `POST /v2/telephony_credentials` with `connection_id` from `TELNYX_SIP_CONNECTION_ID`, then `POST /v2/telephony_credentials/{id}/token`; confirm the exact endpoints in the spike), the route, the `/api/me` field and the audit event `internet_calling_changed`.
- [ ] **Step 4:** Run the full server suite (`npm test --prefix server`); expect all PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(voip): per-user SIP credential and short-lived login token"`.

### Task 3: Ring the app instead of the phone for outgoing calls (server)

**Files:**
- Modify: `server/services/originate.js` (`originateCall`), `server/routes/calls.js` (POST `/`), `server/db/reserve-call.js` (store `leg_a_via`), `server/db/schema.sql` and a migration (`calls.leg_a_via text not null default 'phone' check (leg_a_via in ('phone','app'))`)
- Test: `server/services/originate.test.js` (create), `server/routes/calls.test.js`

**Interfaces:**
- Consumes: `canUseInternetCalling`, `ensureCredential` (Task 2).
- Produces: `originateCall({ callId, userPhone, destination, agentNumber, via?: 'phone' | 'app', sipUsername?: string })`. When `via === 'app'` the `to` is `sip:${sipUsername}@sip.telnyx.com`; everything else is identical.
- Produces: `POST /api/calls` body accepts `via: 'phone' | 'app'` (default `'phone'`). `via: 'app'` requires `internet_calling` on and an allowed country, else 403 `internet_calling_unavailable`. If Telnyx rejects the SIP target (app not registered), the route returns 409 `app_unreachable` and the row is marked failed with `budget_released = true`, so the app can offer "Ring my phone instead".

- [ ] **Step 1: Write failing tests.** `originateCall` with `via: 'app'` calls `calls.create` with `to === 'sip:u123@sip.telnyx.com'` and the same `url` and `statusCallback`; the default and `via: 'phone'` still use `userPhone`. Route: `via: 'app'` with the setting off returns 403; with it on, the row stores `leg_a_via = 'app'`; a Telnyx 4xx on origination returns 409 `app_unreachable` and releases the minutes.
- [ ] **Step 2:** Run `npm test --prefix server -- --test-name-pattern "originate|calls"`; expect FAIL.
- [ ] **Step 3:** Implement. Leave cost fields as they are (Task 7 revisits them). `reserveCall` receives `{ legAVia }` in `options`.
- [ ] **Step 4:** Run the full server suite; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(calls): place leg A to the app over SIP when requested"`.

### Task 4: Ring the app and the phone together for incoming calls (server)

**Files:**
- Modify: `server/lib/recording-consent.js` (`dialCall`), `server/routes/inbound.js`, `server/db/agent-numbers.js` (select `internet_calling` and the SIP username)
- Test: `server/lib/telnyx.test.js`, `server/routes/inbound.test.js`

**Interfaces:**
- Consumes: Task 2 columns. The spike's answer to unknown 2 decides whether to use one `<Dial>` with two nouns or another arrangement.
- Produces: `dialCall(twiml, call)` adds a `<Sip>` noun next to the existing `<Number>` when `call.direction === 'inbound' && call.ring_app`; `inbound.js` computes `ring_app` as `user.internet_calling && canUseInternetCalling(user.phone) && hasCredential`.

- [ ] **Step 1: Write failing tests.** With `ring_app` true the TeXML contains both the owner's phone and the SIP address, each with the party-consent callback; with the setting off the output is identical to today's; a +251 owner never gets `<Sip>`.
- [ ] **Step 2:** Run the two test files; expect FAIL.
- [ ] **Step 3:** Implement. The recording and notice sequence is unchanged because both nouns share the same `party-consent` URL.
- [ ] **Step 4:** Run the full server suite; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(inbound): ring the Dimts app alongside the phone"`.

### Task 5: Voice module in the app (client)

**Files:**
- Create: `src/voip/VoipProvider.tsx`, `src/voip/useVoip.ts`, `src/voip/push.ts`, `src/voip/voipReducer.ts`, `tests/voipReducer.test.ts`
- Modify: `package.json` (SDK and push packages per the spike), `app.config.js` and `app.json` (config plugins; `RECORD_AUDIO`; foreground-service permissions; microphone usage string, which is currently disabled in `app.json`; iOS background mode for voip/audio), `eas.json` (development profile), `app/_layout.tsx` (mount the provider)

**Interfaces:**
- Consumes: `POST /api/voip/token` via a new `getVoipToken(): Promise<{ login_token: string; sip_username: string; expires_at: string }>` in `src/api.ts`.
- Produces: `useVoip(): { status: 'off' | 'registering' | 'ready' | 'error'; incoming: IncomingCall | null; answer(): Promise<void>; hangUp(): Promise<void> }` and the pure `voipReducer(state, event)`.

- [ ] **Step 1: Write failing tests** for `voipReducer`: registering to ready; token expiry triggers re-register; incoming ring to answered; incoming ring to declined; error to fallback; `status` never returns to `ready` after `error` without a successful token fetch.
- [ ] **Step 2:** `npm run client:test`; expect FAIL.
- [ ] **Step 3:** Implement the reducer and provider. Do not auto-login on every mount: check first whether the app was launched from a push (Telnyx's docs warn this breaks cold-start answering). Never commit prebuilt native folders.
- [ ] **Step 4:** `npm run client:test` and `npx tsc --noEmit`; expect PASS.
- [ ] **Step 5:** Build a development client (`eas build --profile development --platform android`) and verify on a real phone: register, and receive a call from a second phone with the app in the foreground, backgrounded and killed. Record results in the PR.
- [ ] **Step 6:** Commit: `git commit -m "feat(app): Telnyx voice module with push and token login"`.

### Task 6: Dialer switch, settings and incoming screen (client)

**Files:**
- Create: `src/components/InternetCallingSetting.tsx`, `app/incoming-call.tsx`, `src/voip/chooseVia.ts`, `tests/chooseVia.test.ts`
- Modify: `app/(tabs)/dialer.tsx`, `src/api.ts` (`startCall(..., via)`, `patchInternetCalling`), `app/settings.tsx`, `app/in-call.tsx` (show "Over internet"; handle `app_unreachable` with a "Ring my phone instead" button)

**Interfaces:**
- Consumes: `useVoip()` (Task 5), `POST /api/calls { via }` (Task 3), `PATCH /api/me { internet_calling }` (Task 2).
- Produces: `startCall(destination, userPhone, record, requestKey, via: 'phone' | 'app' = 'phone')`; `chooseVia({ switchOn: boolean; voipStatus: VoipStatus }): 'phone' | 'app'`; `ApiError.code === 'app_unreachable'` mapped to the fallback button.

- [ ] **Step 1: Write failing tests.** `startCall(..., 'app')` sends `via: 'app'` in the body and the default sends `via: 'phone'`; `chooseVia` returns `'app'` only when the switch is on and the status is `ready`, otherwise `'phone'`.
- [ ] **Step 2:** `npm run client:test`; expect FAIL.
- [ ] **Step 3:** Implement. Turning the setting on requests mic and notification permission and explains why in one sentence of English copy. A blocked country shows "Internet calling isn't available in your country yet" (the server enforces it).
- [ ] **Step 4:** `npm run client:test`, `npx tsc --noEmit`, `npx expo export --platform web --output-dir dist-ci`; expect PASS.
- [ ] **Step 5:** On a real phone, run the journeys under "How people use it" and the Review Focus cases; record pass or fail in the PR.
- [ ] **Step 6:** Commit: `git commit -m "feat(app): call over internet switch, settings and incoming screen"`.

### Task 7: Cost, privacy copy and events

**Files:**
- Modify: `server/lib/pricing.js` and `server/lib/pricing.test.js`, `server/scripts/unit-economics.js`, `src/legal.ts`, `docs/store/` (privacy label notes), `server/lib/analytics.js` (events `voip_registered`, `voip_call_connected`, `voip_fallback_to_phone`)

- [ ] **Step 1: Write failing tests** in `pricing.test.js`: a call with `leg_a_via = 'app'` charges no leg-A surcharge (today the surcharge exists only for expensive owner countries) and plan-minute accounting is unchanged.
- [ ] **Step 2:** Run `npm test --prefix server -- --test-name-pattern pricing`; expect FAIL, then implement. Change `LEG_COST_MICROS` for app legs only from measured Telnyx invoices.
- [ ] **Step 3:** Update the privacy text to: "Calls over the internet are encrypted between your phone and our carrier. We can hear call audio to make your notes." Do not claim end-to-end encryption. Update the Play Data safety and App Store privacy answers (microphone is newly collected).
- [ ] **Step 4:** Full server suite, client suite and `tsc`; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(voip): cost accounting, privacy copy and events"`.

## Founder-only (blocks specific tasks)

Telnyx top-up and SIP Connection (Task 1) - Firebase project and FCM service account (Tasks 1, 5) - Apple Developer account and VoIP push certificate (iOS, later phase) - Play and App Store privacy label updates (Task 7) - counsel's answer before any Ethiopia launch.

## Self-review notes

Spec coverage: outgoing (Tasks 3, 6), incoming (Tasks 4, 5, 6), encryption wording (Task 7), country gate (Tasks 2, 3, 4), fallback (Tasks 3, 6), cost (Task 7), spike gate (Task 1). iOS is deliberately a later phase: the same tasks apply once an Apple Developer account exists, with PushKit and CallKit added in Task 5. Names used across tasks: `canUseInternetCalling`, `ensureCredential`, `mintLoginToken`, `originateCall({ via, sipUsername })`, `useVoip`, `voipReducer`, `chooseVia`, `app_unreachable`, `internet_calling_unavailable`.
