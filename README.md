# Dimts (ድምፅ)

AI call recorder for Amharic and English speakers. The app places a call, the
server records both legs through Twilio, then transcribes with ElevenLabs
Scribe and summarizes with OpenAI.

```
Expo app  ──►  Express (server/)  ──►  Postgres (Supabase)
                     │
                     ├─ Twilio        originates and records the call
                     ├─ ElevenLabs    scribe_v2, dual-channel transcript
                     └─ OpenAI        summary, action items, key points
```

## Before the first call

These are account settings, not code, and each one can stop a call dead.

1. **Upgrade Twilio off trial.** A trial account can only dial verified
   numbers and is restricted to your signup country, so it cannot reach
   Ethiopia at all. Trials also play a spoken message that ends up inside the
   recording and therefore inside the transcript.
2. **Enable Ethiopia in Voice → Settings → Geo permissions** (low-risk ranges).
   International destinations are off by default.
3. Have a **voice-capable** Twilio number for `TWILIO_NUMBER`.
4. **Claim ngrok's free static domain.** Without it the tunnel URL changes on
   every restart and every Twilio callback goes stale.
5. Get an ElevenLabs API key with speech-to-text credit.

### What a call costs

Twilio bills **both** legs. At published rates a 10-minute call from a US
number to an Ethiopian mobile is about **$5.11**, of which $5.04 is Twilio
voice. Transcription and summarization together come to roughly **four cents**.

A user *inside* Ethiopia costs about twice that (~$0.98/min), because both legs
terminate on Ethiopian mobile. Replacing leg A with the Twilio Voice SDK
(WebRTC, $0.0040/min) is the fix; `server/services/originate.js` is the seam
where that swap happens.

Keep test calls short.

## Running it

```bash
npm install
npm install --prefix server
cp .env.example .env          # then fill it in

npm run server                # http://localhost:3000
ngrok http 3000 --url=<your-static>.ngrok-free.app
```

Set `PUBLIC_BASE_URL` and `EXPO_PUBLIC_API_BASE_URL` to the ngrok URL, then:

```bash
npm start                     # Expo dev server
```

Apply `server/db/schema.sql` to your database if it is not already applied.

### Checks

```bash
npx tsc --noEmit              # app typecheck, includes i18n completeness
npx expo-doctor
npm run server:test           # 37 tests, no network calls
```

## Deploying the server

`server/` is a standalone package so Vercel's zero-config Express detection
targets it without colliding with the Expo app at the repo root.

- Set the Vercel project's **Root Directory to `server/`**.
- Add every `server/` variable from `.env.example` as a project environment
  variable, with `PUBLIC_BASE_URL` set to the deployment URL.
- `server/index.js` is the Vercel entry; `server/dev.js` is the local one.
  Both build the same app from `server/app.js`.

Webhooks acknowledge Twilio immediately and finish the transcribe/summarize
pipeline in the background via `waitUntil`, inside the 300s Fluid compute
budget. Twilio abandons a webhook after roughly 15 seconds.

## Building the APK

```bash
eas build -p android --profile preview
```

Point `EXPO_PUBLIC_API_BASE_URL` at the deployed server, not the tunnel. The
free EAS tier allows 15 Android builds a month on a low-priority queue where
peak waits exceed 90 minutes, so batch device testing rather than rebuilding
per change.

## Known limitations

- **`x-user-phone` is not authentication.** The header is spoofable and anyone
  who guesses a phone number can read that user's calls. Replacing it with
  verified OTP plus a JWT is the first thing to do before anyone else installs
  the app.
- **No recording-consent disclosure.** Many jurisdictions require all parties
  to be told. The bridge TwiML should play one before `<Dial>` connects.
- **No tier enforcement.** `usage_minutes` is recorded but nothing stops a call
  at a limit, which matters at roughly $0.50 a minute.
- **The `free` tier in the schema is not viable as priced.** Thirty free
  minutes costs about $15 a month per user in carrier fees alone.
- The Supabase free plan pauses a project after a week of inactivity, which
  surfaces as connection errors long after everything last worked.
