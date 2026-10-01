# Caller MVP acceptance status

This build is in progress. Passing unit tests does not establish a working
phone-call MVP.

Implemented and checked:

- OTP signup/sign-in, opaque sessions, logout and account isolation tests.
- OS keystore storage on native; tab session storage on web.
- Self-service business-number claim from an operator-stocked, routed pool;
  repeated and concurrent claims, account isolation and authentication tested.
  Recents and Settings expose assignment and sharing. Real pool stocking awaits
  a working public incoming webhook; Twilio still has its demo Voice URL.
- Local PostgreSQL option and schema execution test.
- Chronological transcript merge and correct incoming speaker labels.
- Ollama summaries and contact extraction with actual local model testing.
- Ollama Cloud summaries and contact extraction verified with a synthetic
  conversation using gemma4:31b; API key stored only in ignored server config.
- Outgoing and incoming contact linking.
- Pre-call contact notes and previous-call context in the dialer and call screen;
  foreground incoming-call panel. Authenticated HTTP/SQL tests verify account
  isolation, prior-call cutoff and omission of failed/future/current records.
  Background delivery and physical-device presentation remain unverified.
- Processing leases, provider timeouts and recording URL validation.
- Callback SID checks and duplicate/late callback protection.
- Atomic call completion and minute accounting; database failure and retry
  behavior verified using actual PostgreSQL-compatible queries.
- Transactional call reservations, outgoing HTTP idempotency, incoming SID
  deduplication, daily attempt limits, shared monthly minute ceilings and a
  bridge duration cap that respects the remaining allowance. SQL and HTTP
  tests cover retries, changed parameters, active calls and exhausted budgets.
- Two-party recording agreement flow and outgoing recording toggle.
- In-call recording agreement label requires both consent timestamps and an
  enabled recording; answering the first leg alone no longer displays it.
- Assigned business numbers are stored on each call and used as the bridge's
  caller ID, rather than showing every account's calls from the default line.
- Expo web build, TypeScript and dependency compatibility checks.
- Local backend and Whisper worker health checks.
- Synthetic stereo audio transcribed with alternating speaker turns; actual
  Ollama output checked for caller identity and email commitment ownership.
- Contacts editing and vCard export, including cross-owner access tests.
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

Still required:

Google connection code and Settings controls are now implemented. Tokens are
encrypted on the server; SQL/HTTP tests cover account isolation, browser nonce,
one-time confirmation, replay, expiry and disconnect invalidation. Live Google
consent still awaits OAuth client configuration (see `GOOGLE_SETUP.md`), and
live calendar execution and Gmail draft execution remain required.

- Real SMS signup and owner handset verification.
- Public callback endpoint and real inbound/outbound two-person calls.
- Confirm playback, transcript, summary and contact on a real call.
- End-to-end follow-up review and confirmed calendar/email execution.
- Verify minute limits on a real bridge and configure provider spend controls.
- Background/locked-screen briefing delivery and physical-device verification.
- Confirmed external action receipts and uncertain-result reconciliation.
- Verify real pool stocking/assignment, and implement retention/deletion controls.
- Deployment with reachable AI services and hosted PostgreSQL.
- Resolve applicable dependency advisories without downgrading Expo.

Operational notes:

- Twilio account authentication succeeded; the account is a trial account.
- Credentials, local database and test audio are ignored by Git.
- Automatic approval review rejected starting a public Cloudflare tunnel with
  `blocked by policy`; it returned no specific reason.
- The separate handset number for the next test awaits user clarification.
- The full working MVP goal remains active.
- Automatic approval review rejected the backend restart after configuring
  Ollama Cloud with `blocked by policy`; restart remains required.
