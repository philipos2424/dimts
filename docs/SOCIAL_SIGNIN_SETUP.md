# Google, Apple and ChatGPT sign-in

The first sign-in with an unlinked provider account verifies the user's mobile
number once. Later sign-ins with that provider create a normal Dimts session.
Provider login never authorizes access to call content at the provider, and
ChatGPT login does not enable ChatGPT plan usage or expose conversations.

## Release order

1. Apply `server/db/migrations/20261012_social_signin.sql` to the target Dimts
   database before deploying the application. It creates four tables with RLS
   and grants only `dimts_caller_backend` access. It is safe to apply twice.
2. Configure the provider credentials below in Vercel for the intended
   environment. Use Secret variables for private keys and client secrets.
   Never add secrets to `EXPO_PUBLIC_*`, commit them, or paste them into a PR.
3. Set `PUBLIC_BASE_URL` to the exact HTTPS app origin, then register the matching
   callback at each provider. A preview needs its own registered HTTPS origin;
   callbacks and web return URLs must not switch between preview and production.
4. Deploy the reviewed revision. Build new native binaries with its added
   `expo-crypto` and `expo-web-browser` dependencies and the existing `dimts` URL
   scheme. Expo Go against a production server is not a substitute for a build.
5. Run the real-account and device checks below before advertising a provider.

`GET /api/auth/social/providers` lists providers with locally valid configuration.
This checks presence, and Apple's private-key/encryption format, not provider
approval or callback registration. A listed provider still requires a real login.
No sign-in provider credentials were present in Dimts production when inspected
on 2026-10-13. Its four social sign-in tables were also absent at that check.

## Google

Use a Web application OAuth client for the server-run flow. Configure the consent
screen, authorized audience/test users and this redirect:

`https://dimts.vercel.app/oauth/signin/google/callback`

Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Existing Gmail and
Calendar integration credentials can be reused if this additional redirect is
registered. Their `/oauth/google/callback` redirect remains separate.
The sign-in flow requests only `openid` and uses the verified subject identifier.

[Google OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect)

## Apple

Enable Sign in with Apple for the app in an Apple Developer account. Create and
associate a Services ID for the server/web flow and configure the app domain and
return URL:

`https://dimts.vercel.app/oauth/signin/apple/callback`

Set:

- `APPLE_SIGNIN_SERVICE_ID`: the Services ID, not the native bundle identifier.
- `APPLE_TEAM_ID` and `APPLE_KEY_ID`.
- `APPLE_PRIVATE_KEY`: the P-256 `.p8` key. Actual newlines or literal `\n` are supported.
- `INTEGRATION_ENCRYPTION_KEY`: 32 random bytes as 64 hex characters. Back up this
  key securely and keep it stable while stored credentials exist.

Register this server-to-server notification URL:

`https://dimts.vercel.app/oauth/signin/apple/notifications`

The callback uses authorization code only, without name/email scopes. The server
stores a refresh token encrypted with AES-256-GCM and bound to the subject hash.
Disconnecting Apple or deleting a Dimts account queues revocation transactionally,
then attempts it after the response. Local deletion is not blocked by an Apple
outage. `/api/cron/retention` retries queued revocations and abandoned sign-ups.
The existing daily cron and `CRON_SECRET` must remain configured. Failed attempts
are eligible after five minutes; the next daily sweep provides the automatic
retry if no other revocation worker runs. Each sweep processes at most five
credentials, and logs a generic message for failures without exposing tokens.

Unlinked Apple grants become eligible for revocation after 40 minutes. Tokens are
erased after successful revocation. Signed consent-revoked/account-deleted events
remove the Apple method, pending link tickets and the linked user's sessions.
Users can still sign in with their verified phone. Hashed event records remain
for 30 days to reject replays and callbacks issued before revocation. Newer Apple
authorizations are preserved when older events are delivered late.

[Apple token lifecycle guidance](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)

## ChatGPT

Obtain an approved identity OAuth client from OpenAI. Commercial website identity
sign-in is offered to selected partners; an OpenAI API key and the separate
open-source `dynamic_agent_client` flow are not substitutes.

Register:

`https://dimts.vercel.app/oauth/signin/chatgpt/callback`

Set `OPENAI_SIGNIN_CLIENT_ID` and, for a confidential client,
`OPENAI_SIGNIN_CLIENT_SECRET`. Confidential clients use HTTP Basic token-endpoint
authentication; confirm that this matches the client's registration. A registered
public client omits the secret. The flow requests only `openid`.

[OpenAI website identity sign-in](https://developers.openai.com/siwc/website)

## Acceptance checks

Use disposable accounts/numbers in a non-production environment first. Tests must
not use real customer accounts for deletion or revocation.

- Each enabled provider: fresh identity, phone verification, accepted terms,
  sign out, then returning login without another SMS.
- Existing Dimts phone account: linking lands in the original account, preserving
  calls and settings. Expired or conflicting links show an error, not silent success.
- Cancel at provider, reject consent, use an expired callback and retry. Verify
  that replayed callbacks and tickets without a verifier cannot create sessions.
- Web: test a full-page redirect, reload and blocked browser storage.
- Android/iOS builds: browser return, cancellation and OS termination while the
  provider browser is open. The verifier is kept in SecureStore for cold starts.
- Apple: remove the method, delete a disposable Dimts account, exercise retry
  after a provider failure, and send a valid Apple test notification. Verify
  cleanup, token erasure and that stale notifications cannot unlink a newer grant.
- Phone-only login, account export/deletion, Google Calendar/Gmail connections and
  the existing housekeeping endpoint must continue working after migration.

Automated coverage uses signed simulated providers and local PostgreSQL/PGlite.
It does not replace real provider registration, web login or physical-device checks.
