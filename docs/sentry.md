# Sentry monitoring

The app pins `@sentry/react-native` to the installed Expo SDK 57 recommendation
(`~7.11.0`). Dimts reports errors only when `SENTRY_DSN` (server) or
`EXPO_PUBLIC_SENTRY_DSN` (app) is set to an EU project DSN. Empty values
leave initialization and capture disabled. Non-EU DSNs are rejected by the
deployment validator and disabled at runtime, including on Vercel.

## Founder setup

1. Create Sentry projects for Node and React Native in an EU (Germany)
   organization. Copy their DSNs, which use `o<id>.ingest.de.sentry.io`.
2. Set `SENTRY_DSN` in Vercel production and `EXPO_PUBLIC_SENTRY_DSN` in the
   EAS environment used for the release. The app value is inlined at build
   time, so it requires a new app build/update. Leave these unset in tests.
3. In the server Sentry project, configure an issue alert for error events
   with a `call_id` tag, notifying the founder for new and recurring failures.
   Use the `stage` and `carrier` tags to filter recording, transcription,
   summary, storage and processing-timeout failures. Capture alone does not
   configure a notification recipient or alert rule.
4. Optional: set `SENTRY_ORG`, `SENTRY_PROJECT`, and a sensitive
   `SENTRY_AUTH_TOKEN` in EAS for source-map uploads. Never put the auth token
   in an `EXPO_PUBLIC_` variable. The Expo upload plugin is enabled only
   when a token is set. EAS Update uploads use
   `npx sentry-expo-upload-sourcemaps dist` after the authorized update.
5. After an authorized release, trigger a synthetic error with no real call
   content and confirm delivery and the alert. No Sentry project, live event,
   deployment, alert rule or production configuration was changed by this PR.

## Privacy boundary and limitations

The server and app share `server/lib/sentry-privacy.cjs`. It rebuilds each
error event from an allowlist: call/user UUIDs, stage, carrier, recognized
error class, and explicitly safe error messages (including known provider
HTTP statuses). All other message text is replaced with `[redacted]`.
The server also reuses `maskPhones` before handing an error to the SDK.

Request bodies/headers/URLs, phone numbers, transcripts, summaries, audio
URLs, extras, contexts, breadcrumbs, stack locals/source context and arbitrary
exception fields are discarded. Key-name filtering alone is insufficient:
providers can echo a whole transcript inside an ordinary `Error.message`.

`sendDefaultPii` is false. Default integrations, performance tracing, replay,
logs, automatic sessions and client reports are disabled. App native crash
reporting is deliberately disabled because native events can bypass the JS
`beforeSend` filter. Monitoring covers JS errors and server failures; it does
not provide native crash reports. JS stacks retain at most 50 frames per event,
with only filename, identifier-like function, line, column and in-app flag.
Paths are limited to application/package sources and Expo/Hermes bundles;
machine prefixes, queries and fragments are removed, unknown paths redacted.
Function names are limited to 80 characters and sanitized paths to 247.

Source-map images retain only type `sourcemap`, UUID Debug IDs and sanitized
code paths matching retained frames. Canonical `app:///` paths are preserved.
The same path sanitizer is used for frames and images: Sentry Relay derives
`abs_path` from `filename` when absent, preserving the exact match required by
[Sentry's troubleshooting guide](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/).
See [Relay's normalization](https://github.com/getsentry/relay/blob/master/relay-event-normalization/src/stacktrace.rs).
Uploaded artifacts must contain the corresponding Debug IDs and be uploaded
before errors occur. Live symbolication still needs verification after an
authorized release; the tests use a local transport and send no live events.

Server captures are flushed with a bounded timeout through the existing
`defer` / Vercel `waitUntil` path. Monitoring failures never replace the
pipeline's original result or exception. Expiry alerts use only rows changed
by the existing failure update, so repeated polls do not re-alert them.

## Verification

- `npm test`: client, dependency compatibility, reminders, and full server suite.
- `npm run typecheck`.
- Privacy tests inspect both the scrubber output and a real Node SDK envelope
  using a local fake transport; no event is sent to Sentry.
- Client tests verify conditional initialization, native/web JS handlers,
  wrapping and the shared privacy configuration.

Setup references: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/) and
[Expo's Sentry guide](https://docs.expo.dev/guides/using-sentry/).
