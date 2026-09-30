# Dimts (ድምፅ)

Call capture and follow-up assistant for Android, iPhone and the web. Twilio
rings your mobile handset and connects the other person. Both people press 1
to agree before a recorded conversation connects. After the call, the server
transcribes the separate audio channels, summarizes the conversation, extracts
commitments and identifies the contact from their introduction.

The default local AI stack uses Whisper for transcription and Ollama for
summaries and contact extraction. ElevenLabs and OpenAI remain optional
providers. Calendar booking and email execution are not implemented yet.
See [MVP status](docs/MVP_STATUS.md).

## Local setup

Requires Node 22.13 or later, Python 3.12, Ollama and a Twilio account.

```powershell
npm ci
npm ci --prefix server
Copy-Item .env.example .env
```

Fill in `.env`, which Git ignores. Never put credentials in `EXPO_PUBLIC_`
variables; those are embedded in the client bundle.

- `TWILIO_ACCOUNT_SID`: your AC account identifier.
- `TWILIO_AUTH_TOKEN`: account token for API access and webhook validation.
- `TWILIO_NUMBER`: a voice-enabled Twilio number, separate from your handset.
- `TWILIO_VERIFY_SERVICE_SID`: a Twilio Verify service for SMS signup/sign-in.
- `DATABASE_MODE=local`: persistent embedded PostgreSQL in ignored `.data/`.
- `LLM_PROVIDER=ollama`, `OLLAMA_MODEL=llama3:latest`: use an installed model.
- `TRANSCRIBE_PROVIDER=whisper`, `WHISPER_API_TOKEN`: a random token shared
  by the backend and local transcription worker.

```powershell
python -m pip install --target .data/python -r server/whisper/requirements.txt
ollama pull llama3
python server/whisper/local-server.py
```

The worker listens only on `127.0.0.1:3104`. Its first transcription downloads
the Whisper model into `.data/whisper-models`. Keep this port private.

In a second terminal:

```powershell
npx expo export --platform web --output-dir dist
npm run server
```

Open the backend URL (port 3000 by default, or `PORT` from `.env`) for the web
app. Web requests use the same origin. Native builds use
`EXPO_PUBLIC_API_BASE_URL`, which must be reachable from the phone.

## Real calls

To run summaries and contact extraction on Ollama Cloud, use
`OLLAMA_BASE_URL=https://ollama.com`, `OLLAMA_MODEL=gemma4:31b` and a server-only
`OLLAMA_API_KEY`. The backend sends transcripts to Ollama Cloud; audio
transcription remains on the configured Whisper/ElevenLabs provider. Cloud
responses are prompted as JSON and parsed before being used.

Expose the backend through an authorized public HTTPS tunnel, set
`PUBLIC_BASE_URL` to that origin and restart the backend. Configure your Twilio
number's incoming voice webhook to POST to `/twiml/incoming`. Assign that
number to its account owner with `server/scripts/assign-number.js`.

Sign in with your actual mobile number and its SMS code. On a trial account,
verify test phones in Twilio and check Voice geographic permissions for the
countries used in the test.

Outgoing calls ring your handset first. Press 1 to agree to recording; Dimts
then rings the destination, asks that person to press 1 and connects you.
Unanswered agreement prompts hang up. Turning recording off in Settings omits
the recording flow for outgoing calls. Calls have a 30-minute cap.

Do not use the Twilio number as your own handset or dial it as an outgoing
destination: that would route the call back into itself.

## Accounts and data

`/api/auth/start` sends a verification code; `/api/auth/verify` checks it and
creates or signs into the account. The server issues a random 30-day session,
stores only its hash and rejects expired/revoked sessions. Native clients keep
tokens in the OS keystore; the web client uses tab session storage.
The old `x-user-phone` header no longer grants access.

Call history and audio are filtered by the authenticated owner. Recordings are
proxied by the backend. Duplicate processing workers are prevented with atomic
database leases. Expired leases can be reclaimed with the retry endpoint.

## Checks

On a ready call, choose **Prepare follow-ups** to generate an email draft and
an agreed meeting proposal. Edit and save them before opening your mail app or
Google Calendar. A recipient is required for email; meeting start and end times
must be explicitly confirmed in UTC. Relative times from the call remain text
until you fill these in. The handoff opens a review screen; it does not establish
that the message was sent or the event booked. Drafts remain private to the
call's owner and repeated generation preserves saved edits.

Call duration and minute accounting commit together in one database statement.
Failed accounting leaves the callback retryable, and duplicate completion
callbacks do not add usage again.

Call initiation requires an `Idempotency-Key`; the dialer retains it after a
lost response. A retry returns the existing call, and reusing a key with changed
parameters is rejected. Twilio incoming call IDs similarly prevent duplicate
inbound rows. Budget reservations serialize in the database before any outgoing
API call or incoming bridge. Defaults are one active call per account, ten call
attempts per UTC day, 120 connected minutes per account per UTC month, and 300
connected minutes across the pilot per UTC month. The bridge duration shortens
when fewer minutes remain. Uncertain initiation outcomes retain their full
reservation; only definitive provider rejections release it. A failed budget
check or unavailable database prevents bridging, including incoming calls.
These are minute limits, not a dollar cap: setup time, both phone legs, SMS and
number rental have separate costs. Configure Twilio geographic permissions and
account spending controls for the destinations permitted in your pilot.

```powershell
npm run server:test
npx tsc --noEmit
npx expo install --check
npx expo export --platform web --output-dir dist
```

Synthetic audio check on Windows, without a phone call or microphone:

```powershell
./server/scripts/audio-smoke.ps1
python server/scripts/audio-smoke.py
node --env-file=.env server/scripts/smoke-local-audio.js
```

The result is written to ignored `.data/audio-smoke/result.json`. This checks
local audio-to-notes behavior, not carrier connectivity or real call agreement.

## Deployment

`server/api/index.js` is the Vercel entry; it creates the same Express app as
`server/dev.js`. Set the Vercel project root to `server/`. Production must use
hosted PostgreSQL (`DATABASE_URL`) and reachable transcription/LLM services.
A cloud function cannot reach Ollama at `127.0.0.1` on your laptop. Local
database mode is explicitly rejected on Vercel.

Apply `server/db/schema.sql` to hosted PostgreSQL before using this server.
Keep Twilio webhook signature checks enabled. Background processing uses
`waitUntil` on Vercel; long jobs need a durable worker before production scaling.
