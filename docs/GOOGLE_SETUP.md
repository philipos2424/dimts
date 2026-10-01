# Google connection setup

The connection flow is implemented; live Google authorization still requires an
operator-owned OAuth client. Provider-confirmed calendar booking and Gmail draft
creation are separate work and are not yet enabled by this connection screen.

1. In Google Cloud, select the project, enable Calendar API and Gmail API, and
   configure the OAuth consent screen. For a private pilot, add the specific
   Google accounts as test users.
2. Create a **Web application** OAuth client. Add the exact callback URI:
   `https://YOUR-BACKEND/oauth/google/callback`. Local desktop testing can use
   `http://127.0.0.1:3103/oauth/google/callback`; it must match the configured URI.
   A phone's loopback address refers to that phone, so use a reachable HTTPS
   backend for mobile testing.
3. Save `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and
   `GOOGLE_OAUTH_REDIRECT_URI` in the ignored server `.env` or deployment secrets.
   Never prefix these with `EXPO_PUBLIC_`.
4. Generate 32 random bytes encoded as 64 hex characters for
   `INTEGRATION_ENCRYPTION_KEY`, and save that value as a server secret. Preserve
   it with the database backup; changing it makes stored authorizations unusable
   until users reconnect. Do not paste secrets into chat or commit them.
5. Start the updated backend and open Settings after signing in. Choose Calendar
   or Gmail. After Google consent, copy the one-time code displayed by the
   callback page and paste it into **Finish connection** in the same Dimts
   account. Connect each service separately. The code expires after 10 minutes.

Calendar requests `calendar.events.owned`. Gmail requests `gmail.compose`, which
Google defines as managing drafts **and sending email**. There is no draft-only
scope accepted by the Gmail draft creation API. Dimts currently has no sending
endpoint. The screen states the scope honestly. Public Gmail use with this
restricted scope may require Google's verification and, when server-stored
restricted data applies, its security assessment. Check the current requirements
before expanding beyond the pilot.

Access and refresh tokens are AES-256-GCM encrypted and bound to the Dimts user.
Authorization uses PKCE, hashed one-time requests, a browser-only nonce cookie,
expiry and authenticated final confirmation. API status responses contain no
credentials. New connection starts invalidate previous unfinished flows;
disconnect invalidates unfinished flows and removes the selected service's
local tokens. It does not revoke the app's grant at Google: users can remove
Dimts from their Google Account's third-party connections for provider revocation.
No callback URL or code should be captured in access logs or analytics; configure
the reverse proxy to omit query strings for `/oauth/google/*`.

The HTTP tests use a mocked Google token exchange and real PostgreSQL-compatible
SQL. They establish ownership, replay protection, expiry, encryption and safe
errors; they do not establish live consent or real provider execution.

References: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
