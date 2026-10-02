# Vercel pilot deployment

## Current production — 2 October 2026

https://dimts.vercel.app points to READY `dpl_FngM4dBLVJLJcopq7BJfzYscjajz`
(`dimts-5qk4jbdcz-philiposw11-9068s-projects.vercel.app`). Health and onboarding
return 200; signed callbacks return 204 and invalid signatures return 403.
The optional synthetic AI build check is disabled. When enabled, it failed
because `ELEVENLABS_API_KEY` was unavailable to the build, although Vercel
lists a Secret with that name. Transcription remains unverified.

The end-call and stale-provider-state fix is deployed. An unauthenticated
request to the new end-call endpoint returns 401. The specified ended test
attempt was reconciled against Twilio and the production database; it no
longer occupies an active reservation. The attempt never connected a second
leg and provides no two-person recording evidence.

Real SMS delivery and completed signup are now confirmed for the selected
verified pilot handset: the owner reported delivery, supplied the signed-in
dashboard screenshot, and a read-only database audit confirms the matching
business line and active session. The unverified
alternative handset still encounters Twilio's trial restriction.

Deployment identities and pending-signup statements below are historical.

## Signup restriction fix — 2 October 2026

The signup-fix deployment was READY `dpl_EMERJqdpAW5vNsABB332LKuAQVjh`
(`dimts-douhw9s7d-philiposw11-9068s-projects.vercel.app`). Verify errors for
trial-unverified numbers and blocked country delivery now use explicit safe
codes and client messages. All 245 backend tests, six client API-module tests
and TypeScript pass; Vercel's web build succeeds.

A live request using the screenshot's unverified number first returned
HTTP 403 / Twilio `21608`. After deployment, the same request returns
HTTP 403 / `verification_trial_number_required`. Read-only provider checks
confirm the active trial account and recipient verification state. The failure
is an upstream restriction; rejected attempts did not send an OTP. Actual
delivery and completed signup remain unverified. Verify the handset in Twilio
or use the previously verified pilot handset; no ownership check was bypassed.

The following deployment details are historical and are superseded by this
latest deployment identity.

## Latest deployment — 2 October 2026

Production alias https://dimts.vercel.app now points to READY deployment
`dpl_6NccbRtjbLZJ5BX626GBGyZjnqJV`
(`dimts-f6xwq2svc-philiposw11-9068s-projects.vercel.app`). This contains the
review-driven error/call-ID changes and configurable recording policy described
in [the deep dive](CALLER_REVIEW_DEEP_DIVE.md).

The additive consent-policy migration is applied to the Dimts database.
Production `RECORDING_CONSENT_MODE` is explicitly saved as `all_parties`.
Owner-only is implemented but not globally enabled for unrestricted locations.

All 243 backend tests, five client API tests, TypeScript and web/Android/iOS
bundle exports pass. A scan of 65 exported client files found none of the
configured private values. These are bundle exports, not installed-device tests.

Live checks after deployment: health/onboarding 200; unknown API 404;
unissued-session lookup 401 `session_expired`; invalid signup 400 `invalid_phone`
before sending SMS. Signed call-status callbacks return 204, including URLs
with query strings; bad signatures return 403. The new post-notice callback
rejects a missing call with signed 200/hangup and rejects unsigned requests
with 403. The served application bundle includes the new onboarding and safe
error text. No real SMS, paid phone call or recording was created by these probes.

One initial upload ended with a fetch error; a provider listing confirmed no new
deployment before retry. A subsequent build succeeded. The final build corrects
the Number-whisper flow to use supported Say/Gather instructions rather than
Redirect. Provider inspection confirms READY and the production alias.

The following 1 October observations describe earlier deployments and remain
historical evidence; the latest deployment details above supersede them.

The current Expo web app and Express API were deployed on 1 October 2026 to
https://dimts.vercel.app in the existing `dimts` Vercel project. Deployment
`dpl_FKcgkVzyrX8m11SzBfFkUTyGpud9` reached READY and owns the production alias.
The deploy CLI ended with a fetch error, but a subsequent provider inspection
confirmed the deployment and alias. The root project now uses
`vercel.json`, `api/index.js` and the `dist` Expo export; it no longer builds
only the `server` directory. Private environment files and local data are
excluded from uploads and Git.

This is a reachable deployment, not a verified caller MVP. Public onboarding
and first-call pages returned HTML 200, `/health` returned JSON 200, missing API
paths returned JSON 404, and unsigned Twilio callbacks returned 403. A
database-backed session lookup now returns the expected `401 session_expired`
for an unissued token, confirming the deployed database connection. It
previously returned 500 while `DATABASE_URL` was missing. Signed synthetic
callbacks return 204, including
URLs with query parameters; invalid signatures return 403. Named rewrite
parameters previously added `?path=incoming` to the runtime URL and broke
signature validation. Noncapturing routes preserve the URL and query string
Twilio signs without removing any public query parameters.
No real SMS, phone call or recording was created by these deployment checks.
Initial browser automation timed out; a later browser snapshot confirms that
the deployed onboarding screen renders with the phone input and verification
button. Verification and recording are not yet tested.

The dedicated Supabase project `gdmmlvnfiidxrqmwkqng` was restored to
ACTIVE_HEALTHY. Its public schema was empty before migration. A subsequent
live check found only the three initial tables; the complete migration was
reapplied and live metadata now confirms 15 tables. The current
`server/db/schema.sql` and `server/db/supabase-privacy.sql` were applied using
the Supabase migration API. All 15 application tables have RLS enabled and no
browser access policies were added. The application uses its authenticated
Express API and a direct database role. The separate MiniMe project was not
changed. A real SQL test also verifies that a granted non-owner role cannot
read existing user rows or insert users through these tables.

On the user's request, the `dimts_caller_backend` login was created with a
privately generated password. Its role-specific policies permit CRUD on the
15 app tables, without SUPERUSER, CREATEROLE or BYPASSRLS. A live role-switch
query successfully reads the empty users table. The local SQL test proves
that this backend role can read/write while a non-owner Data API role still
cannot. Permissions are reproducible in `supabase-backend-access.sql`;
passwords are excluded from the source. The administrator password was not
changed. Dashboard sign-in succeeded and the Connect dialog confirmed
`aws-0-eu-central-2.pooler.supabase.com:6543`. Do not infer a project's cluster
index from its region.

## Runtime settings and remaining verification

The CLI was updated from 59.11.7 to 62.1.0 while investigating environment
encoding. Device sign-in succeeded. Runtime provider settings and Twilio
credentials were saved again; a private environment pull confirms public
origin, database mode, provider names and budget caps as the expected plaintext
values. Encrypted envelopes in `env ls` are not evidence of corrupt values.
The scoped backend connection was saved as a Production Secret and deployed.
It uses `sslmode=verify-full` with `sslrootcert=server/db/supabase-ca.crt`.
The public Supabase CA certificate was downloaded from the official dashboard
link and explicitly included in the function bundle. Its SHA-256 fingerprint
is `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
Both a local TLS-verified query and the deployed session lookup pass. No TLS
verification was disabled; no database password is stored in source.

Keep `DATABASE_URL` a Secret and redeploy after changing it. The unissued-token
check tests database access without creating a user or bypassing verification.

The pilot settings select Ollama Cloud for summaries and the project's saved
ElevenLabs key for transcription. A private Whisper server is not included in
this Vercel deployment. The saved transcription credential has not been proven
valid with a real recording. Pilot caps are configured as three call attempts
per day, ten owner minutes per month and twenty global minutes per month; their
values were verified in the Production environment before the latest deploy.

A live Ollama Cloud request using the backend's summarization code and a
synthetic speaker-labelled transcript succeeded. It returned a valid summary,
kept the meeting's unspecified AM/PM ambiguous, and assigned the promised
proposal email to Caller. This verifies the local cloud credential and summary
request, not recording/transcription or deployed end-to-end processing.

The handset +251953405253 is verified in Twilio, and Ethiopia's low-risk Voice
permission is enabled. After public backend and signed callback checks passed,
Twilio's owned business number was changed to POST directly to
`https://dimts.vercel.app/twiml/incoming`; a provider read confirmed the setting.
The operator script stocked the number without buying another one. The Verify
service is accessible and uses six-digit codes. The owner must still sign in
with OTP and claim the number before a real incoming test. No real SMS was
sent by these automated checks, and no real phone call has been placed.

After a two-person consent-based call, verify both voices, playback, transcript,
summary and export. Google actions require separate OAuth configuration, and
live transcripts/agent suggestions during the call are not implemented. Use
`CALLER_REVIEW_VALIDATION.md`; never label an HTTP or build check as a passed
recording test. The full backend suite passed 235 tests during this deployment.
