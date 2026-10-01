# Linux pilot deployment

The repository now contains a web/backend image, a private CPU Whisper image,
PostgreSQL and a Caddy HTTPS proxy in `compose.yaml`. Runtime credentials are
supplied separately and excluded from image build contexts. This is prepared
source, not a deployed or container-tested service: Docker is not installed on
the current workstation. No existing hosted database has been changed.

Use a chosen, authorized Linux x86_64 host with Docker Compose and a public
domain you control. Point its DNS to the host and make ports 80/443 reachable.
Whisper CPU performance and model download time must be checked on that host.
The separate Vercel deployment is described in `VERCEL_DEPLOYMENT.md`; that
work restored the Supabase `dimts` project. This Linux stack instead uses its
own PostgreSQL volume. It does not migrate the
current embedded local database or reuse the separate MiniMe project.

## Prepare runtime settings

Copy `deploy/pilot.env.example` to the ignored root `.env.pilot.local` and fill
in the existing Twilio AC account/token, Voice number, Verify service and Ollama
Cloud key. Generate independent 32-byte random values encoded as 64 hex
characters for the database password, Whisper token and integration encryption
key. Keep that file and key backups private. The database password is hex-only
so interpolation into the connection URI is unambiguous.

Set `PUBLIC_BASE_URL` to the public HTTPS origin, without a path, query or
trailing slash. For Google, configure all OAuth settings, including the exact
`PUBLIC_BASE_URL/oauth/google/callback` redirect. See `GOOGLE_SETUP.md` for the
required Google console configuration. Keep the encryption key stable: changing
it makes previously saved Google credentials unreadable.

The backend image contains the Expo web export. Web requests use the same
origin. Installed phone builds must separately set `EXPO_PUBLIC_API_BASE_URL`
to the public origin and configure APNs/FCM as described in
`NOTIFICATION_SETUP.md`. No backend credential belongs in an `EXPO_PUBLIC_`
variable. Signing and installing native builds remains a separate release gate.

## Validate and start on the chosen host

Run from the repository root on that host:

```sh
docker compose --env-file .env.pilot.local config --quiet
docker compose --env-file .env.pilot.local build
docker compose --env-file .env.pilot.local run --rm --no-deps backend node scripts/check-deployment.js
docker compose --env-file .env.pilot.local run --rm --no-deps edge caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file .env.pilot.local up -d
docker compose --env-file .env.pilot.local ps
```

Do not publish the output of ordinary `docker compose config`: it expands
runtime credentials. The quiet validation command avoids that output.

The backend validates settings and applies `server/db/schema.sql` in a database
transaction before listening. A PostgreSQL advisory transaction lock serializes
schema application across instances. Startup fails if migration/configuration
fails. The startup error avoids logging database URLs or query details; the
separate validation command names invalid settings.

On SIGTERM/SIGINT, production stops accepting HTTP connections, lets active
responses finish, waits for tracked background tasks (including tasks spawned
by those tasks), then closes the database. One 45-second deadline covers all
three stages; Compose allows 60 seconds before forced termination. Repeated
signals share the same shutdown. A timeout or teardown failure exits with an
incomplete-shutdown message and a nonzero status, without logging provider
exceptions. It does not cancel or roll back external actions. Investigate saved
leases and unknown provider outcomes after restarting; no automatic replay is
introduced by this shutdown handling.

Only the proxy exposes public ports. Database and Whisper have no host ports;
backend port 3103 is bound to host loopback for diagnostics. Keep it that way.
Caddy forwards paths unchanged to the backend. Its certificate volume persists
TLS state. These patterns follow [Compose readiness dependencies](https://docs.docker.com/compose/how-tos/startup-order/)
and [Caddy site/environment configuration](https://caddyserver.com/docs/caddyfile/concepts).

## Verify the deployment

Check public HTTPS `/health`, then open and refresh `/onboarding`, `/first-call`
and a real `/call/<uuid>` link. `/health` is process liveness, not proof that the
database, telecom, AI or Google services are working. Whisper's health response
can have `loaded: false`; the first transcription loads/downloads the model.
Warm it with permitted synthetic test audio and measure processing latency
before the pilot. Review deployment logs privately and keep call content out of
shared diagnostics.

Configure the existing Twilio Voice webhook as POST to
`PUBLIC_BASE_URL/twiml/incoming`, then stock/assign existing business numbers
with the scripts in the README. Do not buy numbers as part of configuration.
Use the separate mobile handset for SMS signup; a trial account also needs its
test destinations verified and allowed by its geographic permissions.

Follow the app's first-call guide on installed iPhone and Android builds.
Verify both consent paths, actual two-sided audio, names/notes, exported files,
incoming/background alerts and reviewed Google receipts. Use
`CALLER_REVIEW_VALIDATION.md` to record observed outcomes. A green build or a
healthy container does not establish any of those results.

## Data and updates

Database/model volumes persist across container replacement. Do not use
`docker compose down --volumes` on a live pilot: it removes stored data. Back up
the database and integration key securely, define backup expiry, and test that
restoring a backup cannot resurrect deleted recordings before opening it to
users. See `RECORDING_PRIVACY.md`; this deployment source does not implement or
verify that backup policy.

Before updates, record the running source revision and protect existing data.
The present schema contains additive creation/alteration statements; future
schema changes still need review and a restore test. A container restart can
interrupt in-flight AI work after the drain deadline; lease expiry and
transcript checkpoints make it
retryable, but live interruption/recovery must be tested. No reliable automatic
replay of every pending job or zero-downtime update is claimed.

## Checks performed here

Configuration and migration tests exercise invalid/partial settings, account
references, repeated real SQL application and failure propagation. PGlite does
not implement advisory locks, so tests inspect that lock request and execute
the migration SQL separately within its transaction; distributed PostgreSQL
locking remains a live-host check. HTTP tests cover app-shell deep links and
API/asset error separation. Compose YAML parses and private-port/dependency
checks pass. Container builds, Linux wheel installation, certificate issuance,
public callback reachability and physical calls remain unverified.
