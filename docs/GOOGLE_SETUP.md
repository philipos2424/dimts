# Google connection setup

The connection flow and reviewed primary-calendar booking are implemented; live
Google authorization and event creation still require an operator-owned OAuth
client and account consent. Reviewed Gmail draft creation and recovery are also
implemented; actual Google consent, events and drafts remain unverified.

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

Gmail authorization also requests OpenID and email identity. The server verifies
Google's signed ID token and requires a verified email address; this address
becomes the MIME sender. Older Gmail connections without that verified identity
must reconnect. This identity stays within encrypted server credentials.

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

After connecting Calendar, open a processed call and review its meeting proposal,
source quotes, title and both UTC times. **Confirm and book in my Google Calendar**
saves that review and starts the event creation. Only a matching provider response
produces a confirmed receipt with an event ID. This creates a personal event in
the connected account's primary calendar; it does not invite the caller.

The action stores its own immutable meeting snapshot and Google connection ID.
An uncertain request freezes the proposal and subsequent booking requests return
the existing action. **Check booking result** reads the saved event ID; it never
blindly creates another event. A missing event, changed event, changed Google
connection or another uncertain provider result remains unconfirmed. Such cases
need operator investigation rather than automatic resubmission. A definite
provider refusal permits corrected review and an explicit new attempt. A server
crash after dispatch is handled by the same lookup after its two-minute lease
expires. Changes to the call transcript block execution of older proposals;
explicit regeneration replaces saved drafts and requires another review.

Calendar tests cover creation, response validation, duplicate requests, stale
reviews, account isolation, uncertain results, expired leases and a database
failure after provider commit. These tests use a simulated provider, so a live
Google event check is still an acceptance requirement.

For email, review the proposal, recipient, subject and message, then choose
**Confirm and create draft in my Gmail**. Only a matching saved Gmail draft
produces a confirmed draft ID. There is no sending endpoint: the user must open
Gmail, choose the connected account, review the draft and send it themselves.

Gmail does not assign a client-selected draft ID. Dimts saves a unique Message-ID
with the action, creates the draft once, then reads it back and verifies the
sender, recipient, subject and body. Uncertain results and server crashes are
reconciled by searching drafts for that Message-ID and reading the matching
draft. Missing, duplicate, edited or deleted drafts remain uncertain; no blind
resubmission occurs. Provider refusals before creation allow an explicit retry.
A failed lookup after creation never releases the reservation. Reconnecting
Google changes the local grant ID, so unresolved actions under an earlier grant
require operator investigation. Draft receipts attest to creation at the saved
time, not that a message was sent or that later Gmail edits were synchronized.

Tests simulate Gmail and check Unicode MIME, header injection, post-creation
lookup failures, Message-ID recovery, stale/unauthorized requests and a database
failure after provider commit. They do not prove Gmail's live MIME preservation
or search indexing behavior; those require the real OAuth account test.

References: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
API references: [create draft](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create),
[list drafts](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/list),
[get draft](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/get).
