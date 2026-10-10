# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Cloud Agent

Expo SDK 57 needs Node.js 22.13 or newer. Install dependencies with `npm ci --legacy-peer-deps` at the repo root and `npm ci --legacy-peer-deps --prefix server`. Peer conflicts in the Expo tree require `--legacy-peer-deps`; do not refresh the lockfile to get past them.

The environment boots PostgreSQL 16, applies `server/db/schema.sql`, and starts:

- API at http://127.0.0.1:3000 (`GET /health`), via `node --env-file=.env server/dev.js`
- Web UI at http://127.0.0.1:8081, via `npx expo start --web --host localhost --port 8081`

When `.env` is missing, startup writes one whose `DATABASE_URL` is `postgresql://dimts:dimts@127.0.0.1:5432/dimts` and whose Twilio, ElevenLabs, and OpenAI values are placeholders. Leave an existing `.env` alone. Replace the placeholders before placing or transcribing a real call.

`npx tsc --noEmit` typechecks the app. `npm run server:test` runs the API tests with no network calls.
