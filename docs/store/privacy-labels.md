# Privacy answers for the stores

Answers for App Store Connect (App Privacy) and Google Play Console (Data safety), drafted 2026-10-31 from the code on `caller-mvp`. Where a choice was unclear, the answer declares more rather than less. Re-check this file whenever a new data flow ships.

**Sources checked:** `server/lib/analytics.js` (PostHog: random account ID plus coarse facts, never a phone number or call content), `src/sentry.ts` + `server/lib/sentry-privacy.cjs` (`sendDefaultPii: false`, scrubbed events, no user set), `src/notifications.ts` (Expo push token), `app.json` (calendar is write-only, Face ID stays on the device, Android `RECORD_AUDIO` blocked), `/subprocessors` (who processes call content).

## Apple: App Privacy

**Tracking:** No. Nothing is used for tracking across other companies' apps or sites, and no data goes to data brokers. No ATT prompt is needed.

| Apple data type | Collected | Linked to the user | Purpose | Notes |
|---|---|---|---|---|
| Contact info › Phone number | Yes | Yes | App functionality | The account is the user's mobile number. |
| Contact info › Email address | Yes | Yes | App functionality | Only if the user connects Google (Calendar/Gmail drafts). Remove if Google connections are off in the release. |
| Contacts | Yes | Yes | App functionality | The app never reads the address book. Declared because the people list stores the names and numbers of people the user talked to. |
| User content › Audio data | Yes | Yes | App functionality | Call recordings. They are recorded by the carrier, not the device microphone. |
| User content › Emails or text messages | Yes | Yes | App functionality | Recap and Gmail drafts the user approves. |
| User content › Other user content | Yes | Yes | App functionality | Transcripts, summaries, agreements, promises, Ask questions. |
| Purchases › Purchase history | Yes | Yes | App functionality | Plan and credit balance shown in the app. Purchases are made on the web. |
| Identifiers › User ID | Yes | Yes | App functionality, Analytics | Random account ID. It is the PostHog `distinct_id`. |
| Identifiers › Device ID | Yes | Yes | App functionality | Expo push token, used only to deliver notifications. |
| Usage data › Product interaction | Yes | Yes | Analytics | PostHog funnel events (signed up, call started, notes ready…), keyed to the account ID. |
| Diagnostics › Crash data | Yes | No | App functionality | Sentry, PII scrubbed, no user attached. |
| Diagnostics › Performance data | Yes | No | App functionality | Sentry. |

**Not collected:** location, health, financial info (card details stay with Polar on the web), browsing and search history, sensitive info, photos or videos, the device microphone, Face ID data (stays on the device), and calendar contents (write-only).

## Google Play: Data safety

- **Data encrypted in transit:** Yes (HTTPS everywhere; call content is also encrypted at rest with a per-account key).
- **Users can request deletion:** Yes. In the app (Settings › delete a call, a contact, or the account) and on the web at https://dimts.vercel.app/privacy-and-your-data.
- **Data shared with third parties:** No. Every recipient is a service provider processing on Dimts's behalf (carrier, AI transcription and notes, hosting, database, analytics, crash reporting). Google does not count that as sharing. They are listed on /subprocessors.
- **Committed to Play Families policy:** No (18+ app).

| Play data type | Collected | Optional? | Purpose |
|---|---|---|---|
| Personal info › Phone number | Yes | Required | Account management, App functionality |
| Personal info › Email address | Yes | Optional (Google connect) | App functionality |
| Personal info › Name | Yes | Optional | App functionality (names of people in the people list) |
| Audio › Voice or sound recordings | Yes | Required for recorded calls | App functionality |
| Messages › Other in-app messages | Yes | Optional | App functionality (recaps and drafts) |
| Contacts | Yes | Required | App functionality (people the user called; the address book is never read) |
| Financial info › Purchase history | Yes | Required | App functionality |
| App activity › App interactions | Yes | Required | Analytics |
| App activity › Other user-generated content | Yes | Required | App functionality (transcripts, notes, Ask) |
| App info and performance › Crash logs, Diagnostics | Yes | Required | App functionality |
| Device or other IDs | Yes | Required | App functionality (push token) |

Every row: processed ephemerally? **No** (stored). Shared? **No** (service providers only).

## Open questions for the founder

- [ ] If Google connections are hidden in the store build, remove the email and "Emails or text messages" rows.
- [ ] Both stores ask for a privacy policy URL: https://dimts.vercel.app/privacy-and-your-data (switch it to dimts.app later).
