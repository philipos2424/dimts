# Incoming-call notifications

The app now supports an opt-in alert for calls arriving at the user's Dimts
number. It is separate from the telephone bridge: notification failure must not
prevent either person from receiving the call. Foreground briefings still poll
the authenticated API.

## Build and credentials

1. Configure a reachable HTTPS backend and apply `server/db/schema.sql`.
2. Use the EAS project configured in `app.json`. Verify access to that project
   before creating builds; no EAS build or credential change was made here.
3. Configure Android FCM and iOS APNs credentials for this project. The
   `expo-notifications` plugin is included. Use an installed preview/release
   build for physical-phone tests; Android remote notifications are unavailable
   in Expo Go. `eas.json` already has an internal `preview` profile. Set a valid
   iOS bundle identifier before the first iOS build, if EAS has not configured it.
4. Build with the project's preview profile using EAS, install on the test
   phone and sign in with its real verified mobile number. The native API origin
   must be reachable from that phone, not just this computer's loopback address.
5. If Expo enhanced push security is enabled, set `EXPO_ACCESS_TOKEN` in the
   backend environment. It is server-only; never prefix it with `EXPO_PUBLIC_`.
6. In Settings, choose **Enable on this phone** and grant OS permission.
   Registration succeeds only after the server stores the token for the current
   authenticated session. Changing accounts during token retrieval cancels the
   registration attempt rather than assigning it to the new account.

Official references: [Expo SDK 57 Notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/),
[push setup and credentials](https://docs.expo.dev/push-notifications/push-notifications-setup/),
and [sending and checking receipts](https://docs.expo.dev/push-notifications/sending-notifications/).

## Privacy and lifecycle

The alert contains a generic title/body and an opaque call ID. It includes no
phone number, name, conversation, previous notes or credentials. Opening it
first fetches the call through the authenticated API; only the verified owner
can see a briefing. A late notification for a finished call opens its detail.
Deleted calls are not opened. Arbitrary notification URLs are never navigated.

At most five enabled device registrations are allowed per account. Tokens are
not returned in Settings diagnostics. Disable removes registrations for the
current session. Successful server logout deletes the session and cascades its
device registrations; expiry prevents further sends. If logout occurs offline,
the server may still have the session until logout succeeds or expiry, so users
can also revoke notification permission in OS settings. In-flight messages cannot
be recalled. Tokens reassigned on account changes cannot dispatch old pending
work; the payload never supplies old-account private context.

Each incoming call/device pair has one durable outbox record. A sending claim
prevents duplicate callbacks or workers from sending a second alert. The alert
has a 60-second lifetime; calls older than two minutes cannot start new alerts,
and stale pending work is marked expired when status is checked. A timeout, interrupted process or ticket-storage
failure remains unconfirmed; there is no blind resend. New work requires an
active, undeleted incoming call and an enabled device with an unexpired session.
Deleting call content also deletes its notification records.

## Delivery diagnostics

Choose **Check delivery status** in Settings. An Expo ticket means the request
was accepted, not delivered. For tickets older than 15 minutes, this endpoint
checks receipts; a successful receipt indicates handoff to APNs/FCM, not proof
that a phone displayed the alert. Expired receipts after 24 hours are shown as
unconfirmed. `DeviceNotRegistered` disables that registration when reported by
either a ticket or receipt. Error details are reduced to diagnostic codes.
Receipt checks currently run when the authenticated user requests status; a
scheduled operator reconciler has not been deployed.

## Release checks still required

- Real iPhone and Android preview/release builds with configured push credentials.
- Foreground, background, locked-screen, app closed, denied permission, offline,
  delayed delivery and OS force-stop behavior. OS settings and networks can
  suppress notifications; this is not a guaranteed real-time or native CallKit
  incoming-call interface.
- Tap while signed in; tap after session expiry; switch accounts; tap an old or
  deleted call. Verify the authenticated briefing belongs to the active user.
- Inspect device display and provider receipts separately. No real Expo/APNs/FCM
  message was sent during automated tests.
- Full routed two-person call with notification failure: normal telephone
  connection, consent and recording must still work.

Automated evidence: the backend suite passes 213 tests; the notification-specific
SQL/HTTP tests cover registration isolation/caps, private payloads, duplicate
claims, lifecycle exclusions, uncertain sends, invalid devices, receipt handoff,
interrupted ticket storage and account reassignment. TypeScript, Expo dependency
checks and web/Android/iOS bundle exports pass; generated output contains none
of the configured secrets. These checks do not prove device delivery or native
installation. The running services still require rollout of this code.
