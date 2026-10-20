# Dimts-to-Dimts Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When both people have Dimts, calls go app-to-app over the internet (end-to-end encrypted, good quality) and each person gets the usual notes; every other call stays the normal phone call.

**Architecture:** One calling button. A new server step `chooseRoute` decides `app` or `phone`; `phone` runs the existing code untouched. An app call creates two `calls` rows (one per person, linked by an `app_calls` row) so billing, notes, promises, deletion and retention work per person with no new concepts. Audio flows phone-to-phone over WebRTC (Cloudflare TURN relay when needed). Signalling is short authenticated HTTP requests. Afterwards each phone uploads its owner's own-voice recording; the server transcribes the two single-voice recordings and feeds the existing notes pipeline the same two-channel transcript shape it uses today.

**Tech Stack:** Node/Express (node:test, PGlite) server; Expo 57 development build; `react-native-webrtc` with its Expo config plugin; Cloudflare Realtime TURN; existing ElevenLabs Scribe transcription; existing Expo push.

**Spec:** `docs/superpowers/specs/2026-10-20-app-to-app-calls-design.md`

## Global Constraints

- The normal phone-call flow is unchanged and is the fallback for everything. `POST /api/calls` keeps its request and response shape.
- No per-call confirmation. Recording consent is the terms both users accepted plus an on-screen "Recorded and summarized by Dimts" notice on both phones before and during the call. Bump `TERMS_VERSION` in `server/lib/terms.js` and update the terms text so it says calls between Dimts users are recorded; `chooseRoute` requires both people to have accepted the new version.
- App calls only for countries where `recordingPolicy` returns `mode: 'notice'`. Never for `requiresExplicitConsent` numbers (Gulf) and never for +251 until the founder lifts that gate after counsel's answer (feature flag `APP_CALLS_BLOCKED_PREFIXES`, default `251`).
- Call audio is end-to-end encrypted between the phones (DTLS-SRTP). Never route the live call through a Dimts media server. The server may hear only the own-voice recording each owner uploads for their notes. Describe it that way everywhere: "The call is end-to-end encrypted. After it ends, each phone sends its owner's own voice to Dimts to make notes."
- Both phones show a security code derived from the two DTLS fingerprints so users can detect a tampering server.
- Findable by number is opt-in per user (`users.app_calls_findable`, default false).
- English-only new copy. Read https://docs.expo.dev/versions/v57.0.0/ before any Expo or native config (AGENTS.md). Each worktree owns its own `node_modules`. Migrations are applied BEFORE deploying code that reads them. Production deploys and migrations need the founder's OK.
- Ring when the app is closed (v1): a high-priority Expo push on the existing `incoming-calls` channel; tapping it opens the app and connects. A full-screen CallKit/ConnectionService ring is a later phase (needs native code, and on iPhone an Apple Developer account).
- Vercel request bodies are limited to 4.5 MB: upload audio in chunks of at most 1 MiB.

## Review Focus

- Callee killed the app, is offline, or declines: the caller sees a clear result within about 10 seconds and can tap "Call on my phone instead"; no ring-forever screens, no stuck `ringing` rows.
- Only one side uploads its audio (phone died, app killed, upload failed): the other person still gets notes (marked partial) and the missing side retries for up to 48 hours; neither row is failed after 10 minutes the way phone-call rows are today.
- The upload arrives twice, out of order, or in pieces after a reconnect: exactly one audio object results, byte-identical to the original; a different file for the same part is rejected.
- Either person deletes the call, the contact or the account: their audio is removed, their row is gone, and the other person's already-made notes remain; reprocessing never reads a deleted peer's audio.
- Network switches (Wi-Fi to mobile data), bad network, or one-way audio: the call restarts ICE, shows "Poor connection", and never silently records silence (a silent own-voice file produces no notes and says why).
- A user on the old terms, the old app version, or in a blocked country is never routed to `app`, and the server (not just the UI) refuses.
- Recording must not start before both phones have shown the notice; `recordingAuthorizationSql` stays true only after `other_party_notice_issued_at` and the matching consent column are set on that person's row.

---

### Task 1: Android spike (throwaway) - settle the unknowns

Gate: stop after this task and show the findings to the founder. Nothing below is built until it passes or the later tasks are adjusted to the findings. Spike code is not kept.

**Files:**
- Create: `docs/superpowers/plans/2026-10-20-app-to-app-spike-findings.md` (the only kept deliverable)
- Throwaway: a scratch Expo development build and a scratch signalling script, outside `server/` and `app/`

**Unknowns (record PASS/FAIL with evidence for each):**
1. Does a call between two real Android phones connect, directly and through Cloudflare TURN? How does a 5-minute call sound on a throttled link (150 kbps, 5% loss) and after switching Wi-Fi to mobile data (ICE restart)? Is there echo on speaker?
2. How can each phone record its own microphone while WebRTC holds the audio device? Try, in order: (a) `expo-audio` recorder running at the same time; (b) a native tap on the local audio track; (c) `react-native-audio-api` or equivalent. Which gives clean, continuous audio and survives screen-off? Record the file format and size per minute.
3. Clock skew between the two phones' recordings: start both when ICE becomes connected and measure alignment against a clap test. Can a data-channel ping reduce skew below about 300 ms?
4. Cloudflare TURN: confirm the current API for short-lived credentials (docs: https://developers.cloudflare.com/realtime/) and how often a relay is needed on the founder's real networks.
5. Expo push to a killed app: delay from sent to heads-up banner on Android, sound on the `incoming-calls` channel, and whether the tap reaches a connected call in under 10 seconds.
6. Data used per minute with and without TURN.

- [ ] **Step 1:** Founder provides two Android phones (or one phone and an emulator for signalling only; audio quality needs two real phones) and a Cloudflare account with Realtime TURN enabled.
- [ ] **Step 2:** Build the scratch dev client and answer unknowns 1 and 4 first (connection, quality, relay).
- [ ] **Step 3:** Answer unknown 2, choosing the recording method; produce a 3-minute own-voice file from each phone while talking. Answer unknown 3 with the two files.
- [ ] **Step 4:** Answer unknowns 5 and 6.
- [ ] **Step 5:** Write the findings file, including which recording method wins and the exact library versions that worked. Commit only that file: `git add docs && git commit -m "docs: app-to-app spike findings"`.
- [ ] **Step 6:** With the founder decide: go, change Tasks 6 to 8 to match, or stop.

### Task 2: Data model, terms bump, findability and route choice (server)

**Files:**
- Create: `server/db/migrations/<date>_app_calls.sql`, `server/lib/app-call-route.js`, `server/lib/app-call-route.test.js`
- Modify: `server/db/schema.sql` (same DDL), `server/lib/terms.js` (`TERMS_VERSION`), `server/routes/me.js` (GET/PATCH `app_calls_findable`), `server/routes/notifications.js` (device registration stores `app_calls_supported`), `src/legal.ts` (terms text)
- Test: `server/routes/me.test.js`

**Interfaces:**
- Produces schema: `users.app_calls_findable boolean not null default false`; `notification_devices.app_calls_supported boolean not null default false`; `calls.route text not null default 'phone' check (route in ('phone','app'))`; `calls.app_call_id uuid`; table `app_calls(id uuid pk default gen_random_uuid(), caller_id uuid not null references users, callee_id uuid not null references users, caller_call_id uuid references calls, callee_call_id uuid references calls, status text not null default 'ringing' check (status in ('ringing','connecting','connected','ended','declined','missed','failed')), created_at timestamptz not null default now(), answered_at timestamptz, ended_at timestamptz)`.
- Produces `chooseRoute(caller: User, destination: string): Promise<{ route: 'phone' } | { route: 'app', callee: User }>`. It returns `app` only when ALL hold: a non-deleted user owns `destination`; `app_calls_findable`; the callee has an enabled device with a valid session and `app_calls_supported`; both have `hasAcceptedTerms`; neither number is blocked by `APP_CALLS_BLOCKED_PREFIXES` or `requiresExplicitConsent`; `recordingPolicy` mode is `notice` for both phones; the feature flag `APP_CALLS_ENABLED=true`; and the callee can afford at least one minute (same check as `callBudget`, with no surcharge). Anything else is `{ route: 'phone' }`. Never throws for "not found"; a database error also returns `phone` (and is reported to Sentry).
- Produces: `PATCH /api/me { app_calls_findable: boolean }` with audit event `app_calls_findable_changed`.

- [ ] **Step 1: Write failing tests** in `app-call-route.test.js` (PGlite), one per condition above, asserting `route: 'phone'` when exactly that condition is false and `route: 'app'` when all hold; plus: a +251 callee, a Gulf callee, a callee with an expired session, and a callee out of minutes each return `phone`. In `me.test.js`: PATCH accepts only booleans (400 otherwise), and GET returns the field.
- [ ] **Step 2:** Run `npm test --prefix server -- --test-name-pattern "app-call-route|app_calls"`; expect FAIL.
- [ ] **Step 3:** Implement the migration and schema, `chooseRoute` and the endpoints. Bump `TERMS_VERSION` to `2026-10-21` (or the date of merge) and add the sentence "Calls between Dimts users happen over the internet, are end-to-end encrypted while they last, and are recorded and summarized by Dimts for both people." to the terms text; check the existing terms-accept screen still renders.
- [ ] **Step 4:** Run the full server suite; expect all PASS. Update tests that pin `TERMS_VERSION` if any.
- [ ] **Step 5:** Commit: `git commit -m "feat(app-calls): data model, terms bump, findability and route choice"`.

### Task 3: Call lifecycle and signalling API (server)

**Files:**
- Create: `server/services/app-calls.js`, `server/routes/app-calls.js`, `server/services/app-calls.test.js`, `server/routes/app-calls.test.js`
- Modify: `server/create-app.js` (mount `/api/app-calls`), `server/db/reserve-call.js` and `server/lib/pricing.js` consumers (see below), `server/services/notifications.js`

**Interfaces:**
- Consumes: `chooseRoute` (Task 2), `reserveCallInTransaction`.
- Produces: `startAppCall(caller: User, callee: User, requestKey: string): Promise<{ appCallId: string, callId: string }>`: in one transaction creates the caller row (`direction 'outbound'`, `route 'app'`), the callee row (`direction 'inbound'`, `route 'app'`) and the `app_calls` row. `reserveCallInTransaction` gets `options.route === 'app'`: no `callSurcharge`, `twilio_call_sid` stays null, and the existing minutes/credits checks, one-active-call rule and daily limit still apply to both people.
- Produces endpoints (signed in; the caller or callee of that `app_calls` row only, else 404): `POST /api/app-calls` (internal use by `POST /api/calls`), `POST /:id/signals { kind: 'offer'|'answer'|'candidate'|'bye', payload }`, `GET /:id/signals?after=<int>` (returns signals from the other person only, ordered, at most 50), `POST /:id/answer`, `POST /:id/decline`, `POST /:id/connected { fingerprintHash }` (sets `answered_at`, status `connected`, and on EACH person's row sets `other_party_notice_issued_at = now()`, plus `parent_consent_at` for the caller row and `child_consent_at` for the callee row, only after that person's own client reports the notice was shown), `POST /:id/end { seconds }`, `GET /ice` (returns Cloudflare TURN short-lived credentials; never the API token), `GET /incoming` (the signed-in user's ringing app call, for a foreground app).
- Produces: ringing times out after 45 s to `missed` (callee row `missed`, caller row `failed` with message "No answer"); `end` calls the existing `finishCall` for each row with that person's reported duration capped by the server-measured `answered_at..ended_at`; status transitions are monotonic (an `ended` call cannot become `connected`).
- Push: `sendIncomingNotification(callId)` is reused for the callee row; its `WHERE` clause requires `direction='inbound'` and status in (`ringing`,`in-progress`), so the callee row uses `ringing` while the app call rings.

- [ ] **Step 1: Write failing tests**: starting creates two rows and one `app_calls` row; the caller cannot start a second call while one is active (409 `call_in_progress`); only the other participant's signals are returned; a stranger gets 404; `connected` sets the notice and consent columns for the reporting person only and `hasRecordingAuthorization(row)` is false for a person whose client has not reported yet; `end` twice finishes once (billing ledger has one entry per person, usage minutes added once); a ring older than 45 s becomes `missed`; the callee's row never shows a surcharge.
- [ ] **Step 2:** Run the two test files; expect FAIL.
- [ ] **Step 3:** Implement. Rate-limit signals with `hit('app-signal:'+user.id, 600, 600)`; limit signal payloads to 16 KiB and `kind` to the four values; the ICE endpoint calls Cloudflare's credentials API (confirm exact URL and fields from the spike findings) with a one-hour TTL and caches nothing. Audit events: `app_call_started`, `app_call_ended` (no content).
- [ ] **Step 4:** Full server suite; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(app-calls): lifecycle, signalling and TURN credentials API"`.

### Task 4: Route `POST /api/calls` through `chooseRoute` (server)

**Files:**
- Modify: `server/routes/calls.js` (POST `/`), `server/routes/calls.test.js`

**Interfaces:**
- Consumes: `chooseRoute`, `startAppCall`.
- Produces: when `chooseRoute` returns `app`, `POST /api/calls` responds `201 { callId, status: 'ringing', route: 'app', appCallId }` for the caller's row; otherwise exactly today's behavior and response (plus `route: 'phone'`). A new optional body field `route: 'phone'` forces the phone path (used by the "Call on my phone instead" button), and the same `Idempotency-Key` rules apply: a retry of an app call returns the existing row.

- [ ] **Step 1: Write failing tests**: a callee that qualifies yields `route: 'app'` and no Telnyx/Twilio call is made (assert `originateCall` is not invoked); a callee that does not qualify yields the phone flow identical to today's (existing tests still pass unchanged); `route: 'phone'` in the body forces the phone path even for a qualifying callee; reusing the key with another destination still returns 409 `request_key_reused`; an app-call failure while creating rows falls back to the phone path rather than failing the request.
- [ ] **Step 2:** Run `npm test --prefix server -- --test-name-pattern calls`; expect FAIL.
- [ ] **Step 3:** Implement. Keep the review-demo, `call_loop`, `canCall` and preflight checks before routing, exactly as they are.
- [ ] **Step 4:** Full server suite; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(calls): choose app-to-app or phone per call"`.

### Task 5: Own-voice audio upload and notes for app calls (server)

**Files:**
- Create: `server/services/app-call-audio.js`, `server/services/app-call-audio.test.js`, `server/routes/app-call-audio.js`, `server/routes/app-call-audio.test.js`
- Modify: `server/services/process-recording.js` (branch for `route = 'app'`), `server/services/transcribe.js` (export `transcribeVoice`), `server/db/expire-recording-wait.js` (exclude `route = 'app'`), `server/db/schema.sql` + migration (`app_call_audio_parts`, `calls.own_audio_complete_at`, `calls.own_audio_offset_ms`), `server/create-app.js`

**Interfaces:**
- Consumes: `archiveAudio`/`putAudio`/`getAudio`, `sealText`/`sealJson`, `processRecording`.
- Produces: `PUT /api/calls/:id/audio-part?index=<int>&total=<int>` (body is raw bytes, at most 1 MiB, header `X-Part-Sha256`): idempotent per `(call_id, index)`; a different hash for an existing index is 409. `POST /api/calls/:id/audio-complete { offsetMs, mime }`: joins the parts in order, verifies the count, stores one encrypted object through the existing `archiveAudio`, sets `own_audio_complete_at`, `own_audio_offset_ms` and a marker `recording_url = 'dimts-app:' || app_call_id` (so existing `recording_url IS NOT NULL` logic works), then calls `defer(processAppCallNotes(callId))`. Only the row's owner may upload; only for rows with `route='app'`, `record_enabled` true and `hasRecordingAuthorization`.
- Produces: `processAppCallNotes(callId): Promise<void>`: waits (re-queued by the cron that already retries stuck calls, and by every upload) until both rows have `own_audio_complete_at`, or until 10 minutes after the call ended with only one, in which case it proceeds one-sided and the row records `notes_partial = true`. It transcribes each single-voice file with `transcribeVoice(audio, { mime, signal }) -> { text, words[], raw }` and builds the same shape `processRecording` stores today: `raw = { transcripts: [ownerSide, peerSide], audio_quality }` with the peer's word times shifted by the difference of the two `own_audio_offset_ms` values, so `mergeMultiChannel` and `transcriptTurns` work unchanged. Channel 0 is the row owner's voice and channel 1 the peer's; `labels` already map by `direction`. For a partial call the missing side's transcript is `{ text: '', words: [] }` and `recordingQualityError` is bypassed for `route = 'app'` only when `notes_partial` is true.
- Produces: the app-call expiry: rows with `route='app'` and no own audio are failed 48 hours after `completed_at` with the same plain message as today's, never after 10 minutes.

- [ ] **Step 1: Write failing tests**: chunk upload is idempotent and rejects a changed part; completing with a missing part is 409; two parts out of order reassemble to the original bytes; a non-owner and a non-authorized row are refused; with both uploads present, both rows reach `ready` with two-sided `transcript` and `transcript_data.transcripts.length === 2` and `transcriptTurns(row)` non-empty; with one upload only, after the wait the row is `ready` with `notes_partial = true`; a silent own file yields the plain "no detectable audio" error and no notes; a peer who deleted their call is not read (the row falls back to one-sided and says so); `EXPIRE_RECORDING_WAIT_SQL` does not touch an app row 11 minutes after completion but does after 48 hours.
- [ ] **Step 2:** Run `npm test --prefix server -- --test-name-pattern "app-call-audio|app call"`; expect FAIL.
- [ ] **Step 3:** Implement. The peer's audio is read only through the server's storage key for the peer's row and is never copied into this row's storage. Sealing and retention use each row's own `userId`.
- [ ] **Step 4:** Full server suite; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(app-calls): own-voice upload and two-sided notes"`.

### Task 6: WebRTC engine in the app (client)

**Files:**
- Create: `src/appcall/engine.ts`, `src/appcall/signaling.ts`, `src/appcall/securityCode.ts`, `src/appcall/reducer.ts`, `tests/appcallReducer.test.ts`, `tests/securityCode.test.ts`
- Modify: `package.json` (WebRTC package and its Expo config plugin, versions from the spike), `app.json` / `app.config.js` (plugin, `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`, microphone usage string, iOS background mode `audio`), `eas.json` (development profile), `src/api.ts`

**Interfaces:**
- Consumes: the Task 3 endpoints through `src/api.ts` functions `postSignal(id, kind, payload)`, `getSignals(id, after)`, `getIce()`, `answerAppCall(id)`, `declineAppCall(id)`, `reportConnected(id, fingerprintHash)`, `endAppCall(id, seconds)`.
- Heartbeat (added after the Task 3 review): once connected the engine POSTs `/api/app-calls/:id/heartbeat` every 30 s (`heartbeatAppCall(id)` in `src/api.ts`). The server ends a call silent for 90 s and bills only up to the last heartbeat. Also poll `GET /api/app-calls/:id` for `status` and `peerEnded` instead of relying on a `bye` signal, because signals are purged 10 minutes after a call ends.
- Produces: `appCallReducer(state, event): AppCallState` with states `idle | ringing-out | ringing-in | connecting | connected | reconnecting | ended`, events `started, offerReceived, answered, iceConnected, iceDisconnected, iceRestarted, hangup, remoteBye, timeout`, and no transition out of `ended`.
- Produces: `securityCode(localFingerprint: string, remoteFingerprint: string): string` returning the same 8-digit string (formatted `1234 5678`) for both phones regardless of order.
- Produces: `class AppCallEngine { start(appCallId, role: 'caller'|'callee'): Promise<void>; hangUp(): Promise<void>; mute(on: boolean): void; speaker(on: boolean): void; onState(cb): void; onQuality(cb): void }`. Opus with echo cancellation, noise suppression and auto gain on; signalling polled every 700 ms until connected (then every 5 s for `bye` only); ICE restart on network change or `disconnected` for more than 3 s; a 10-second connect deadline emitting `timeout`.

- [ ] **Step 1: Write failing tests** for the reducer (every transition above, `ended` is terminal, an `offerReceived` while `connected` is ignored) and `securityCode` (symmetric, stable, 8 digits, differs when either fingerprint differs).
- [ ] **Step 2:** `npm run client:test`; expect FAIL.
- [ ] **Step 3:** Implement the reducer, `securityCode` and the engine. Verify every WebRTC API name against the installed package version, not memory.
- [ ] **Step 4:** `npm run client:test` and `npx tsc --noEmit`; expect PASS.
- [ ] **Step 5:** Build a development client and, on two real phones, verify: connect, two-way audio, mute, speaker, hang up from either side, Wi-Fi to data switch, airplane-mode drop and recover, and that `reportConnected` is sent only after the notice was visible. Record results in the PR.
- [ ] **Step 6:** Commit: `git commit -m "feat(app): WebRTC call engine with security code"`.

### Task 7: Own-voice recorder with a durable upload queue (client)

**Files:**
- Create: `src/appcall/recorder.ts`, `src/appcall/uploadQueue.ts`, `tests/uploadQueue.test.ts`
- Modify: `src/api.ts` (`putAudioPart`, `completeAudio`)

**Interfaces:**
- Produces: `interface CallRecorder { start(): Promise<void>; stop(): Promise<{ uri: string; durationSec: number; offsetMs: number; mime: string }> }` implemented by the method the spike chose (keep the choice behind this interface).
- Produces: `uploadQueue`: `enqueue(job: { callId: string; uri: string; offsetMs: number; mime: string }): Promise<void>`, `drain(): Promise<void>`. Jobs persist on disk (not only in memory), split files into 1 MiB parts with SHA-256, retry with exponential backoff for up to 48 hours, resume from the first unconfirmed part after an app restart, survive airplane mode, and delete the local file only after `audio-complete` succeeds. `drain()` runs at app start, on connectivity regained, and after each call.

- [ ] **Step 1: Write failing tests** (with a fake API and fake file system): a job interrupted after part 2 resumes from part 3; a 409 for a changed part marks the job failed and reports it; the local file is deleted only after completion; jobs older than 48 hours are dropped with a visible "Notes unavailable" state; two jobs for the same call do not run in parallel.
- [ ] **Step 2:** `npm run client:test`; expect FAIL.
- [ ] **Step 3:** Implement. Start the recorder when ICE first connects and stop on hang-up or `ended`, and enqueue the upload without waiting for it. If the user taps "Stop recording" mid-call, stop and enqueue what exists and tell the peer via the signalling `bye`-free `recording-stopped` signal so both screens say so.
- [ ] **Step 4:** `npm run client:test` and `npx tsc --noEmit`; expect PASS.
- [ ] **Step 5:** On two phones, record a 3-minute call, kill the app mid-upload, reopen, and confirm both people's notes arrive. Record the result in the PR.
- [ ] **Step 6:** Commit: `git commit -m "feat(app): own-voice recorder and durable upload queue"`.

### Task 8: Screens and settings (client)

**Files:**
- Create: `app/app-call.tsx` (in-call and ringing, caller and callee), `src/components/AppCallsSetting.tsx`
- Modify: `app/(tabs)/dialer.tsx` and `src/api.ts` (`startCall` returns `route`; `forcePhone`), `app/settings.tsx`, `app/_layout.tsx` (register the device with `app_calls_supported: true`, handle the push tap and the foreground `GET /incoming` poll every 3 s only while the app is foreground), `app/call/[id].tsx` (a "Dimts call, your voice only for playback" label and the partial-notes banner), `src/i18n.ts` strings (English only)

**Interfaces:**
- Consumes: Tasks 6 and 7, `POST /api/calls` (`route`, `appCallId`), `PATCH /api/me { app_calls_findable }`.
- Produces: `chooseScreen(response): 'app-call' | 'in-call'` (pure, unit-tested): `'app-call'` only when `response.route === 'app'`.

- [ ] **Step 1: Write failing tests**: `chooseScreen` for both routes; the "Call on my phone instead" action sends `route: 'phone'` with a fresh idempotency key; the settings toggle PATCHes `app_calls_findable` and reverts the switch on failure.
- [ ] **Step 2:** `npm run client:test`; expect FAIL.
- [ ] **Step 3:** Implement. The ringing and in-call screens show "Dimts call", the notice "Recorded and summarized by Dimts. The call is end-to-end encrypted.", the security code with a one-line explanation, mute, speaker, hang up, "Stop recording" and "Poor connection" when quality drops. The first time a user opens Settings after updating, ask once "Let Dimts users call you over the internet?" (default No).
- [ ] **Step 4:** `npm run client:test`, `npx tsc --noEmit`, `npx expo export --platform web --output-dir dist-ci`; expect PASS.
- [ ] **Step 5:** On two phones run every journey in the spec and every Review Focus case; record pass or fail per line in the PR description.
- [ ] **Step 6:** Commit: `git commit -m "feat(app): app-to-app call screens and settings"`.

### Task 9: Quality telemetry, copy and store answers

**Files:**
- Modify: `server/lib/analytics.js` (events `app_call_started`, `app_call_connected`, `app_call_fallback_to_phone`, `app_call_quality_poor`, `app_call_upload_failed`, no content), `src/sentry.ts` breadcrumbs (no audio, no numbers), `src/legal.ts` and `docs/store/` (privacy label: microphone, audio data), `server/lib/pricing.js` + `server/scripts/unit-economics.js` (app-call cost: relay GB x $0.05 and transcription for both voices), `README` runbook section

- [ ] **Step 1: Write failing tests**: `analytics` events carry only ids, durations and booleans; `sentry-privacy` strips any `sdp`, `candidate`, `fingerprint` and file paths from events.
- [ ] **Step 2:** Run server and client suites; expect FAIL, then implement.
- [ ] **Step 3:** Update the privacy text exactly: "Calls between Dimts users are end-to-end encrypted while they last. After a call, each phone sends its owner's own voice to Dimts to make notes. We can hear that audio." Update Play Data safety and App Store privacy answers (audio recordings: collected, linked to the user, used for app functionality).
- [ ] **Step 4:** Full suites plus `tsc`; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(app-calls): telemetry, privacy copy and cost tracking"`.

### Task 10: Staged rollout and acceptance

- [ ] **Step 1:** Run the acceptance matrix on two real phones, each on mobile data from different carriers and once on a throttled link: connect time under 10 s, a 5-minute call stays intelligible, no one-way audio, no echo on speaker, notes for both people within 5 minutes of hang-up with both voices, partial-notes path works, "Call on my phone instead" works, a non-Dimts callee gets the normal phone call, a +251 and a Gulf number never route to `app`. Save the results as `docs/superpowers/plans/2026-10-20-app-to-app-acceptance.md`.
- [ ] **Step 2:** Founder approves the migration and the deploy. Apply migrations first, then deploy with `APP_CALLS_ENABLED=false`.
- [ ] **Step 3:** Enable for the founder's own two accounts only (`APP_CALLS_ALLOWLIST_USER_IDS`), make five real calls, review events, then enable for all users in `notice` countries.
- [ ] **Step 4:** Keep +251 blocked until the founder lifts `APP_CALLS_BLOCKED_PREFIXES` after counsel answers and a local-SIM test passes.

## Founder-only (blocks specific tasks)

Two Android phones and a Cloudflare account with Realtime TURN (Task 1) - approval to apply migrations and deploy (Task 10) - Apple Developer account and VoIP push entitlement (iPhone, later phase) - Play and App Store privacy answers (Task 9) - counsel on affirmative-consent places and on Ethiopia (before widening beyond the `notice` countries).

## Self-review notes

Spec coverage: hybrid routing and fallback (Tasks 2, 4, 8), no per-call confirm plus notice (Tasks 2, 3, 8), E2E and security code (Tasks 6, 8), quality (Tasks 1, 6, 10), partial notes and retries (Tasks 5, 7), consent evidence (Task 3), Ethiopia and Gulf gates (Tasks 2, 10), privacy wording (Task 9), push when closed (Tasks 3, 8; full-screen ring deferred). Names used across tasks: `chooseRoute`, `startAppCall`, `processAppCallNotes`, `transcribeVoice`, `CallRecorder`, `uploadQueue`, `AppCallEngine`, `appCallReducer`, `securityCode`, `chooseScreen`, `route`, `app_call_id`, `own_audio_complete_at`, `notes_partial`. Known v1 limits stated to users: playback of an app call contains only the listener's own voice; ringing with the app closed is a notification, not a full-screen call.
