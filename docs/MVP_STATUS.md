# Caller MVP acceptance status

This build is in progress. Passing unit tests does not establish a working
phone-call MVP.

## Trial destination preflight — 2 October 2026

New outgoing attempts now read the provider account type/status and verify
both trial dial-through legs before reserving minutes or originating the
owner call. Full accounts skip trial-recipient checks. An unverified target
gets an explicit safe instruction to use Verified Caller IDs; provider lookup
failure blocks calling without revealing its error body. Existing request-key
retries retain the original result without another preflight or paid call.

A real read-only provider check confirms the pilot owner is verified and the
selected destination is still unverified. It returns the expected safe 403
without sending a verification message or placing a call. All 260 backend
tests, the six client API tests and TypeScript pass. Twilio dashboard recovery,
target verification, speech credentials and Google OAuth remain pending; this
guard does not bypass any of them or prove recording success.

## End-call and stale-call repair — 2 October 2026

The first real outgoing attempt reached the owner's handset. The owner asked
to stop it, and an operator provider check confirmed the parent ended with no
child legs. The database nevertheless remained `in-progress`, blocking a new
call. The specified row was corrected to failed with zero connected duration
and a descriptive error, after verifying the provider's terminal state.
This is a real routing attempt, not a successful two-person recording test.

Parent lifecycle completion now reconciles provider status and child duration
through the same atomic finalizer as dial-done. Before a new call, an existing
active row is checked against the provider; an idempotent retry of the same
request does not need a provider check. A genuinely active provider call remains
blocked. The authenticated owner can end a call through a new endpoint and
End call controls on the live-call and call-detail screens. Cross-account
call access returns 404 without touching the provider. Ambiguous child legs
and unconfirmed stop outcomes do not clear an active reservation.

All 255 backend tests and TypeScript pass; targeted final changes also pass.
The reconciliation service was exercised against the specified real call and
hosted database: it confirms ended and preserves the already finalized row.
No audio/AI result was established. Physical UI end-call testing remains pending.

Deployment `dpl_FngM4dBLVJLJcopq7BJfzYscjajz` is READY at the production
alias. Health/onboarding, valid and invalid signature probes, and the new
unauthenticated end-call rejection all pass. This is the current deployment.

## Processing deadline — 2 October 2026

The deployed function permits 300 seconds, but the previous per-stage timeouts
could add up beyond that limit (download, transcription, summary, identity).
Processing now shares a 270-second deadline across media fetches, transcription
and LLM requests, leaving time to persist an interrupted/timeout error and
release the lease. Saved recording and transcript checkpoints remain available
to the existing retry flow. Identification remains best-effort after notes are
committed; a deadline does not fabricate a contact identity.

All 249 backend tests pass, including shared-deadline cancellation, preventing
new requests after expiry and preserving a recoverable error without deleting
the saved media. Existing checkpoint/retry tests also pass. These tests do not
establish that a real call has been recorded or successfully transcribed.

The deadline fix is deployed READY as `dpl_C5gaYhw2Tuz7kcrANgPXHyyBz385`
at https://dimts.vercel.app. Post-deployment health/onboarding and callback
signature checks pass. This supersedes the earlier normal deployment identity.

## Verified pilot signup — 2 October 2026

The live `/api/auth/start` request for the previously selected Twilio-verified
pilot handset returned HTTP 202 `code_sent`. The owner confirmed that the SMS
arrived and then supplied a screenshot of the signed-in Recents dashboard with
the assigned business line. A read-only production database audit confirms
one matching owner/line assignment, one active owner session and zero calls.
This establishes real OTP delivery, completed signup and business-number
assignment for this pilot. It does not establish signup for arbitrary trial
recipients or recording/AI success. Earlier pending-signup notes below are
historical; the screenshot's unverified alternative handset remains restricted.

## Hosted AI check — 2 October 2026

An opt-in build check now exercises transcription, summary and identity with
a checked-in 23.5-second synthetic stereo conversation. It never uses customer
recordings or prints provider responses, model output or keys. The first two
production-target test builds failed before transcription: the second reports
`Missing required environment variable ELEVENLABS_API_KEY`. Vercel lists the
Secret by name, but that does not prove a usable value reaches the deployment.
No speech-provider request or AI success was established by these builds.
Failed deployments: `dpl_3b4XZqPAd4N53Sq8wuNCN4Qq9aZG` and
`dpl_31AnZQjtwERsKwnLgY2R44nacJRL`. Neither replaced the live alias.

The check is disabled again (`AI_SMOKE_ON_BUILD=0`) for normal builds. A usable
speech-to-text key is still needed before retesting the hosted audio pipeline.
Transcription error logging now excludes raw provider response bodies, and a
regression test checks that an HTTP 401 cannot expose that body and that a WAV
upload has the correct filename. All 245 existing backend tests and the new
provider regression test pass. Real phone OTP, call recording/playback and
Google account actions remain unverified.

Normal deployment `dpl_BGwiC9Rh48Ki4a9kw734rnJBvAgt` is READY and owns
https://dimts.vercel.app, with the optional AI check disabled. This deployment
does not resolve the missing usable speech key or establish real call success.

## Review-driven update — 2 October 2026

### Real signup rejection investigation

A user's legitimate phone entry returned HTTP 403. A live retry confirmed
Twilio error `21608`; a read-only provider audit confirms the account is an
active Trial and the screenshot number is not a verified recipient. The
previously selected pilot handset is verified. No code was sent by that
rejected request. This is an upstream trial restriction, not proof that the
user's Dimts account lacks permission. See [Twilio's Verify trial rules](https://www.twilio.com/docs/usage/trials/try-out-verify).

The Verify adapter now maps trial-number rejection and country delivery
restrictions to stable, sanitized error codes with actionable client messages.
It does not bypass verification or automatically retry SMS. All 245 backend
tests, six client tests and TypeScript pass. Real OTP delivery and owner
verification remain pending; the earlier health checks do not prove them.

The fix is deployed as READY `dpl_EMERJqdpAW5vNsABB332LKuAQVjh` at
https://dimts.vercel.app. A live retry now returns the specific safe
`verification_trial_number_required` error rather than a raw numeric provider
code. The number remains blocked until the owner verifies it with Twilio; no
OTP was delivered by these rejected attempts. The source fix cannot remove
Twilio's account restriction.

The [deep dive](CALLER_REVIEW_DEEP_DIVE.md) extends the store-review evidence with
four Reddit threads, including positive/resolved reports, and provider access
policy. Friendly signup/API errors replace raw server JSON; the English dialer
shows actionable rejection messages. Every nondeleted call detail shows a
selectable call ID. Detailed new error text is English; translated dialer
fallbacks remain available.

Scoped owner-only recording is implemented for incoming and outgoing calls:
only the account owner accepts, the other person hears a notice, and capture
uses a per-call policy snapshot. Shared atomic authorization guards also govern
receipts/recovery and the UI. Existing calls and the general production pilot
remain all-party. Owner-only requires an explicit operator scope; this setting
does not detect location, enforce the scope or certify legality worldwide.
The additive three-column migration is applied to Dimts Supabase.

These changes are deployed at https://dimts.vercel.app as READY deployment
`dpl_6NccbRtjbLZJ5BX626GBGyZjnqJV`. Live database/session checks, callback
signature guards, invalid signup rejection before SMS and updated served
client text pass. See [deployment evidence](VERCEL_DEPLOYMENT.md).

All 243 backend tests and five actual client API-module tests pass; TypeScript
and web/Android/iOS exports pass. These checks include notice-before-start,
owner-leg selection, refusal/timeout, replay, policy snapshots, recovery and
SQL/JavaScript authorization equivalence. A real two-phone recording, native
playback/export and the transcription credential remain unverified.

The dated observations below are historical; later deployment observations
supersede earlier local-only or unavailable-service findings.

Provider deletion now retains the original Twilio account on new reservations
and legacy calls with canonical recording URLs. Unknown ownership or changed
configuration blocks provider requests and never confirms removal from another
account's absence response. Previously scrubbed legacy rows without account
evidence require operator investigation. All 216 backend tests, targeted
SQL/provider checks and TypeScript pass on 1 October 2026; live deletion across
account configuration changes is unverified. Earlier local backend and
Whisper health checks succeeded, but Twilio still uses its demo Voice
webhook and public callbacks, a hosted database and Google OAuth are unconfigured.
The account-association changes have not been rolled out to those live processes.
The later transcript-timestamp change passes all 220 backend tests, TypeScript
and web/Android/iOS bundle exports. The generated files contain none of the
configured secrets. No real-call timestamp accuracy or physical playback test
has been completed, and these changes are not deployed.

The deployment and browser deep-link changes pass all 227 backend tests on
1 October 2026. The Whisper entry module imports using workstation dependencies;
this is not a Linux image test. Docker is unavailable here, and no container,
public endpoint or hosted database deployment has been verified. Review research
now covers thirteen recording store listings plus Notta, with platform-specific
evidence and priorities tied to the twenty pilot scenarios.

Production shutdown now stops new HTTP intake, waits for active responses and
tracked background jobs, then closes the database under one 45-second deadline.
Compose gives the backend 60 seconds. All 234 backend tests pass, including a
real HTTP server drain test, nested tasks, repeated signals and sanitized
timeout/teardown failure results. A shutdown deadline does not prove a provider
action was cancelled; leases and unknown outcomes still need reconciliation.
These changes have not been deployed or verified in a Linux container.

The latest live audit on 1 October 2026 found no TCP listener on ports 3103 or
3104 and neither health endpoint reachable. The previous backend PID is absent;
the old worker PID now identifies a console host, so it is not proof of a live
Whisper worker. Twilio's number still has the demo Voice webhook. Public origin,
hosted database and Google OAuth client configuration remain absent. No service
was restarted or public routing changed during this audit.

Implemented and checked:

- A production Vercel deployment now serves the web app and Express API at
  https://dimts.vercel.app. The Dimts Supabase project is restored and the schema
  plus RLS protection are applied. All 235 backend tests pass. Public HTML,
  liveness and unsigned-callback rejection checks pass, but database-backed
  database access now passes: an unissued token returns `401 session_expired`.
  Signed callbacks now pass, including query-string URLs; invalid signatures
  are rejected. A dedicated scoped database login is deployed with verified
  TLS and Supabase's CA. Twilio now routes to the backend, and the owned number
  is stocked for account claiming. Owner OTP verification is pending.
  No real recording or signup is claimed. See `VERCEL_DEPLOYMENT.md`; this
  supersedes the earlier no-hosted-deployment observations above.

- OTP signup/sign-in, opaque sessions, logout and account isolation tests.
- A first-call guide is reachable from Recents and Settings. It explains the
  distinct handset/business numbers, supported routes, two-party prompts,
  short outgoing/incoming tests, beginning/middle/end playback, export checks
  and reviewed Google follow-through. Actual owner call results link to detail
  and recovery; ready AI notes are never labelled proof of complete capture.
  The guide does not place a call, record a passed test or establish a pilot
  result. Recents now hides cached data from another account and ignores stale
  requests; the business-number panel resets per owner and ignores stale
  session responses. Rendered/physical account-switch testing remains required.
- Client API requests have a 30-second timeout covering fetch and response-body
  reading. Network failures use sanitized messages and preserve ambiguous
  call-start status; the dialer retains its request key for a lost response.
  HTTP failure codes remain distinguishable. Three actual client-module tests
  (`npm run client:test`) cover hanging requests, body stalls, same-key retry,
  authentication headers, success cleanup and HTTP rejection. TypeScript and
  all platform bundle exports pass. Transport cancellation is not proof that
  a provider-side call or Google action was undone; reconciliation still applies.
- Opt-in incoming-call notifications with session-bound device registration,
  private alerts, duplicate dispatch claims, ticket/receipt diagnostics, invalid
  device handling and authenticated cold-start/tap navigation. Dispatched
  independently of call routing. SDK 57 module/plugin and Settings controls
  included; see `NOTIFICATION_SETUP.md`. SQL/HTTP tests and platform bundles
  pass, but APNs/FCM configuration and physical delivery remain unverified.
- OS keystore storage on native; tab session storage on web.
- Self-service business-number claim from an operator-stocked, routed pool;
  repeated and concurrent claims, account isolation and authentication tested.
  Recents and Settings expose assignment and sharing. Real pool stocking awaits
  a working public incoming webhook; Twilio still has its demo Voice URL.
- Local PostgreSQL option and schema execution test.
- Chronological transcript merge and correct incoming speaker labels.
- Speaker-labelled transcript timestamps derived from saved stereo word timing
  only when the recording source and reconstructed text match the saved call.
  Missing/invalid timing, replaced audio, edited text and unsupported legacy
  layouts fall back to the plain transcript. The owner API omits raw provider
  responses; notes export adds approximate timestamps relative to recording
  start. A timestamp pauses/positions the authenticated player and brings its
  controls into view; users press Play. Seek requests are serialized, scoped to
  the call, and checked against the loaded recording duration. Call loads ignore
  stale session/route responses and hide another owner's cached detail. SQL/API
  and timing tests pass; rendered and physical-device playback remain unverified.
- Ollama summaries and contact extraction with actual local model testing.
- Ollama Cloud summaries and contact extraction verified with a synthetic
  conversation using gemma4:31b; API key stored only in ignored server config.
- Outgoing and incoming contact linking.
- Pre-call contact notes and previous-call context in the dialer and call screen;
  foreground incoming-call panel. Authenticated HTTP/SQL tests verify account
  isolation, prior-call cutoff and omission of failed/future/current records.
  Background delivery and physical-device presentation remain unverified.
- Processing leases, provider timeouts and recording URL validation.
- Transcript checkpoints bound to the recording URL survive summary failure.
  Retry resumes from that checkpoint without another audio download/STT request;
  a changed recording requires new transcription. Leases renew between expensive
  stages. Authenticated list/detail reads expose expired workers or queued jobs
  as retryable failures without removing audio/transcript; legacy queued rows
  get a fresh waiting deadline on their first authenticated observation. The retry API rejects ready notes
  and active workers, and no longer forces completed notes to regenerate. Only
  a worker that commits notes may identify/update its contact. Real SQL/HTTP
  tests cover checkpoint reuse, expiry, owner isolation, concurrent retries and
  stale workers losing the final write. Live worker-interruption testing remains.
- Browser playback fetches audio with bearer authentication into a private blob,
  revokes that URL on unmount, and shows loading/errors with retry. Native streams
  retain bearer headers; the proxy preserves validated byte-range responses for
  seeking. Playback adds 15-second skips and replay from the start. HTTP tests
  cover isolation, unavailable media and interrupted-stream recovery. Rendered
  browser playback and physical-device behavior remain unverified.
- Callback SID checks and duplicate/late callback protection.
- Atomic call completion and minute accounting; database failure and retry
  behavior verified using actual PostgreSQL-compatible queries.
- Transactional call reservations, outgoing HTTP idempotency, incoming SID
  deduplication, daily attempt limits, shared monthly minute ceilings and a
  bridge duration cap that respects the remaining allowance. SQL and HTTP
  tests cover retries, changed parameters, active calls and exhausted budgets.
- Two-party recording agreement flow and outgoing recording toggle. Dial begins
  unrecorded; REST recording starts once only after both saved acceptances.
  Decline/no response continues without recording. Known startup refusal and
  uncertain startup are distinguished; neither triggers an automatic retry.
- In-call recording label requires both agreements and a provider startup
  receipt. Live carrier timing and full audio capture remain unverified.
- Completion-based ten-minute missing-audio deadline on authenticated list/detail
  reads, clear error/call ID, refresh and recovery on a late recording callback.
  Legacy calls without completion time are excluded from deadline expiry.
- Read-only provider recovery for missing audio on finished, mutually agreed
  calls. Known recording SID is fetched directly; uncertain startup lists at
  most two recordings on the parent call and accepts only one completed,
  nonempty dual-channel receipt belonging to the same account/call. Atomic
  one-minute cooldown and conditional receipt storage avoid duplicate work
  during concurrent requests/callbacks. Missing/ambiguous/unsupported results
  remain explicit; no new call or recording is created. Mock-provider SQL/HTTP
  tests pass; live Twilio lookup and recovered audio quality remain unverified.
- Review research across nine recorders and one adjacent transcription app,
  with dated evidence, implementation gaps and a paid-pilot validation plan:
  `CALL_RECORDING_REVIEW_RESEARCH.md`. Refreshed visible reviews distinguish
  historical reports and developer responses, and include Apple's native
  recording baseline. `CALLER_REVIEW_VALIDATION.md` supplies 20 concrete pilot
  scenarios and a results schema; none are marked passed without live evidence.
  Onboarding explains supported call routes.
- Local Whisper measures decoded channel signal before inference. Silent
  channels skip inference; silent/mono/one-sided signal and incomplete channel
  transcripts prevent new AI notes and contact identification. Partial text,
  diagnostics and original audio remain saved. Initial follow-up generation
  now requires a ready call, including a transactional recheck after generation.
  Signal presence is not proof of intelligible speech or complete recording;
  a legitimately quiet participant can trigger the warning. Decoder, worker
  HTTP and SQL tests cover silence, one-sided audio, cached retries and races.
  Existing legacy single-channel provider transcripts have no signal measurement
  and are not retroactively classified. Live worker rollout remains required.
- Assigned business numbers are stored on each call and used as the bridge's
  caller ID, rather than showing every account's calls from the default line.
- Expo web build, TypeScript and dependency compatibility checks.
- Patched URI decoding and Xcode UUID dependencies while retaining Expo 57.
  A local CommonJS adapter uses upstream decoder 0.5.0; Xcode uses UUID 11.1.1.
  Clean `npm ci`, query parsing/malformed-input/Xcode-ID tests, TypeScript,
  Expo version checks and web/Android/iOS bundle exports pass. Generated output
  contains none of the configured secrets. Physical native builds remain
  unverified. Root and server audits report zero known advisories
  on 1 October 2026; this is not a guarantee of overall application security.
- Local backend and Whisper worker health checks.
- Synthetic stereo audio transcribed with alternating speaker turns; actual
  Ollama output checked for caller identity and email commitment ownership.
- Contacts editing and vCard export, including cross-owner access tests.
- Call text-note and MP3 export controls. Authenticated notes omit provider
  metadata, preserve UTF-8/speaker text and label AI suggestions. Browser saves
  downloaded copies; native uses cache files and the OS file-sharing sheet.
  Tests cover owner isolation, expired sessions and incomplete calls. Temporary
  native copies older than an hour are pruned on the next export (or by the OS);
  copies saved/shared outside Dimts remain under the user's control. Physical
  share-sheet and downloaded-file verification remain required.
- Owner-confirmed call-content deletion, provider removal receipts/retries and
  removal history in Settings. Tombstones preserve usage/consent/provider IDs
  while scrubbing content and invalidating processing. Late callbacks/startup
  receipts cannot restore notes. Unknown removal outcomes stay visible.
  Contacts, external Google actions and exported copies remain. Current retention
  is until owner deletion; no automatic age-based purge. See `RECORDING_PRIVACY.md`.
  Live removal, rendered confirmation and deployment backup expiry are unverified.
- Editable follow-up email and meeting drafts stored per call. Mail and Google
  Calendar handoff require reviewed recipients and explicit UTC meeting times.
  Cloud generation checked for both meeting and email examples; isolation and
  date validation tests pass. Actual sending/booking is not yet verified.
- Transcript-backed proposal evidence, rejection controls, version checks and
  atomic review-history events. Real Ollama Cloud checks cover accepted and
  explicitly declined meetings; invalid references/quotes and forged evidence
  are rejected or ignored. Review events are not external execution receipts.
- Reviewed Google Calendar execution with immutable meeting snapshots, provider
  event IDs, encrypted token refresh and lookup reconciliation. SQL/HTTP tests
  cover duplicate requests, stale transcripts/reviews, failed attempts, expired
  leases and a database failure after provider commit. The UI shows confirmed,
  failed and uncertain results separately. Live Google creation remains unverified.
- Reviewed Gmail draft execution with verified sender identity, immutable email
  snapshots, draft IDs and Message-ID lookup recovery. Tests cover Unicode MIME,
  injection, failed post-creation lookup, stale/unauthorized actions and receipt
  storage failure. No sending endpoint exists; live draft creation is unverified.

Still required:

Google connection code and Settings controls are now implemented. Tokens are
encrypted on the server; SQL/HTTP tests cover account isolation, browser nonce,
one-time confirmation, replay, expiry and disconnect invalidation. Live Google
consent still awaits OAuth client configuration (see `GOOGLE_SETUP.md`), and
live calendar execution and Gmail draft execution checks remain required.

- Real SMS signup and owner handset verification.
- Public callback endpoint and real inbound/outbound two-person calls.
- Confirm playback, transcript, summary and contact on a real call.
- End-to-end follow-up review and confirmed calendar/email execution.
- Verify minute limits on a real bridge and configure provider spend controls.
- Background/locked-screen briefing delivery and physical-device verification.
- Confirmed external action receipts and uncertain-result reconciliation.
- Verify real pool stocking/assignment, live deletion and backup retention policy.
- Deployment with reachable AI services and hosted PostgreSQL.

Operational notes:

- Twilio account authentication succeeded; the account is a trial account.
- Credentials, local database and test audio are ignored by Git.
- Automatic approval review rejected starting a public Cloudflare tunnel with
  `blocked by policy`; it returned no specific reason.
- The separate handset number for the next test awaits user clarification.
- The full working MVP goal remains active.
- Automatic approval review rejected the backend restart after configuring
  Ollama Cloud with `blocked by policy`; restart remains required.
- Linux pilot deployment source: web/backend and CPU Whisper Dockerfiles,
  PostgreSQL/model/certificate volumes, Caddy HTTPS proxy and private-service
  ports. Production startup validates configuration and applies the schema
  transactionally before listening; repeated migration preserves existing data
  in SQL tests. Advisory-lock request/failure tests, settings validation and
  Compose YAML/private-port checks pass. Browser deep links now serve the Expo
  shell on known routes while missing APIs/assets remain errors. Docker is not
  installed here, so images, Linux dependencies, TLS and public calls are not
  verified. See `DEPLOYMENT.md`. No hosted resource was created or changed.
