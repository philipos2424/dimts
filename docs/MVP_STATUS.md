# Caller MVP acceptance status

This build is in progress. Passing unit tests does not establish a working
phone-call MVP.

Provider deletion now retains the original Twilio account on new reservations
and legacy calls with canonical recording URLs. Unknown ownership or changed
configuration blocks provider requests and never confirms removal from another
account's absence response. Previously scrubbed legacy rows without account
evidence require operator investigation. All 216 backend tests, targeted
SQL/provider checks and TypeScript pass on 1 October 2026; live deletion across
account configuration changes is unverified. The current local backend and
Whisper worker return healthy responses, but Twilio still uses its demo Voice
webhook and public callbacks, a hosted database and Google OAuth are unconfigured.
The account-association changes have not been rolled out to those live processes.
The later transcript-timestamp change passes all 220 backend tests, TypeScript
and web/Android/iOS bundle exports. The generated files contain none of the
configured secrets. No real-call timestamp accuracy or physical playback test
has been completed, and these changes are not deployed.

Implemented and checked:

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
