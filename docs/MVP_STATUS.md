# Caller MVP acceptance status

This build is in progress. Passing unit tests does not establish a working
phone-call MVP.

Implemented and checked:

- OTP signup/sign-in, opaque sessions, logout and account isolation tests.
- OS keystore storage on native; tab session storage on web.
- Local PostgreSQL option and schema execution test.
- Chronological transcript merge and correct incoming speaker labels.
- Ollama summaries and contact extraction with actual local model testing.
- Outgoing and incoming contact linking.
- Processing leases, provider timeouts and recording URL validation.
- Callback SID checks and duplicate/late callback protection.
- Two-party recording agreement flow and outgoing recording toggle.
- Expo web build, TypeScript and dependency compatibility checks.
- Local backend and Whisper worker health checks.
- Synthetic stereo audio transcribed with alternating speaker turns; actual
  Ollama output checked for caller identity and email commitment ownership.
- Contacts editing and vCard export, including cross-owner access tests.

Still required:

- Real SMS signup and owner handset verification.
- Public callback endpoint and real inbound/outbound two-person calls.
- Confirm playback, transcript, summary and contact on a real call.
- Follow-up drafts, calendar proposal review and calendar/email execution.
- Call initiation idempotency, spending limits and atomic usage accounting.
- Deployment with reachable AI services and hosted PostgreSQL.
- Resolve applicable dependency advisories without downgrading Expo.

Operational notes:

- Twilio account authentication succeeded; the account is a trial account.
- Credentials, local database and test audio are ignored by Git.
- Automatic approval review rejected starting a public Cloudflare tunnel with
  `blocked by policy`; it returned no specific reason.
- The separate handset number for the next test awaits user clarification.
- The full working MVP goal remains active.
