# Dimts-to-Dimts calls over the internet — design

Status: draft v2 for founder review (2026-10-20), updated with the founder's decisions of the same day. Nothing is built. Supersedes the "bridge internet calls to phone numbers" idea in `2026-10-20-internet-calling-design.md` as the first thing to build; that design stays as a later, separate option.

**Founder decisions (2026-10-20):** (1) The normal phone-call flow stays exactly as it is. (2) When the other person also has Dimts, the call automatically goes app-to-app over the internet. (3) Call quality and encryption are requirements. (4) Because both people have the app, they know calls are recorded, so there is **no per-call confirmation**.

## Intent and why
When both people have Dimts, a call between them can run phone-to-phone over the internet, like a WhatsApp call, with Dimts adding what WhatsApp doesn't: notes, promises and follow-ups afterwards. Founder, 2026-10-20: "people might use it". The motive is a recording path that works on both Android and iOS with no third party on the call, no forwarding and no merge step, because the app is the phone.

Secondary reasons: almost no per-minute cost (no phone-network leg), real end-to-end encryption of the call, and the lowest legal exposure in Ethiopia, because no call touches the phone network.

## Goals
- Call another Dimts user from inside the app and get notes, promises and agreements on both sides after hang-up.
- No per-call confirmation: both people are Dimts users who accepted terms stating that calls between Dimts users are recorded and summarized. The call still shows a clear "Recorded and summarized by Dimts" notice on both screens, and either person can stop recording.
- One calling button: the app chooses app-to-app when the other person is reachable on Dimts and falls back to the normal phone call otherwise.
- Voice quality at least equal to a WhatsApp call on the same network (see Quality).
- Works on Android and iOS, including when the app is closed (incoming ring via push).
- The call audio is end-to-end encrypted between the two phones.
- Each person's notes belong to them, are stored encrypted like all call content, and obey their own retention and deletion settings.

## Non-goals and anti-goals
- Not a replacement for WhatsApp or Telegram as a general calling app: no group calls, no video, no chat, in v1.
- No calling of non-Dimts phone numbers in this project (that is the PSTN-bridge design, later and country-gated).
- Dimts must never hear the other person's voice unless that person uploaded it for their own notes. A design where the server quietly records both sides of an "end-to-end encrypted" call is an anti-goal.
- Failure even if it technically works: a call that rings on one phone and never the other; a recording that starts before both people agreed; calls that burn mobile data on weak networks without warning.

## What people experience
1. **Finding people.** In a person's page (or recents), if that number belongs to a Dimts user who has chosen to be findable, a "Call on Dimts" button appears. Otherwise "Invite to Dimts" shares a link. Being findable is opt-in per user (Settings), default off.
2. **Calling.** Tap Call as always. If the number belongs to a Dimts user who is reachable, the call goes over the internet and the screen says "Dimts call". Otherwise it is the normal phone call, unchanged. The other phone rings full-screen even if the app is closed. There is no confirmation step: both screens show "Recorded and summarized by Dimts" while ringing and during the call, and recording starts when the call connects.
3. **During the call.** A "Recording" banner; mute, speaker, hang up, and a "Stop recording" control that stops it for both people and says so on both screens. On bad data the screen says so and offers "Call on my phone instead".
4. **After.** Each person gets their own summary, promises and follow-ups in Calls, exactly like today's calls (with a "Dimts call" label and no phone-number leg cost).
5. **Missed or declined.** A normal missed-call entry; no voicemail in v1.

## Key decisions (founder-delegated; these are my calls, marked so they can be overruled)
- **Media path (my call):** direct WebRTC between the two phones using `react-native-webrtc` in an Expo development build, with Cloudflare Realtime TURN as the relay when a direct path fails ($0.05/GB after a 1,000 GB monthly free allowance, shared with Cloudflare's SFU). Chosen over Telnyx WebRTC because no phone network is involved and the relay never sees decrypted audio. The audio is encrypted with DTLS-SRTP between the two phones.
- **Signalling (my call):** Dimts's own server sends offer/answer/candidates over short authenticated requests and wakes the other phone with a push (FCM on Android, PushKit + CallKit on iOS). The server sees who called whom and when (metadata), never the audio.
- **Recording and notes (my call, verify in the spike):** the server never receives the call stream. Instead each phone records only its own microphone and, with that person's consent, uploads that audio for transcription as today. The two phones exchange transcript lines over the encrypted WebRTC data channel so each person ends up with the full two-sided transcript, and each person's notes are generated from their own copy. This keeps the promise that Dimts hears only the voice of the person who uploaded. If the spike shows the data-channel exchange is too fragile, the fallback is to tap the incoming audio track natively on each phone and upload both sides to that person's own notes, which still never goes through a Dimts media server.
- **Consent (founder decision, with a legal flag):** agreement comes from the terms both users accepted plus an on-screen notice on both phones before and during the call; there is no tap. The terms and the sign-up screen must say plainly that calls between Dimts users are recorded and summarized, and the privacy and store copy must match. Record on the call row the terms version each person had accepted and the time the notice was shown, using the existing consent columns. **Flag for counsel:** some places require every party's consent to be affirmative; terms acceptance may not satisfy them (for example California and other all-party US states, the EU/UK, and Gulf countries, which today require a key press). Until counsel answers, the feature ships only for countries where `recordingPolicy` already says `mode: 'notice'`, and Gulf numbers keep the existing press-1 flow on the phone path.
- **Routing (founder decision):** `POST /api/calls` keeps its contract. A new server step `chooseRoute(user, destination)` returns `'app'` only when the destination's number belongs to a Dimts user who is findable, has a registered device, runs an app version that supports app calls, and is in an allowed country; otherwise `'phone'` and everything runs as today. If an app call cannot connect within about 10 seconds or the other device never answers the ring, the caller sees "Call on my phone instead", which starts the phone flow for the same destination.
- **Ethiopia (my call):** feature-flagged per country. Off for +251 until (a) an Ethiopian telecom lawyer has answered the Article 10 and Article 8 questions in `memory/dimts-ethiopia-voip-law` and (b) a technical test on a local SIM passes. App-to-app calls are the lowest-risk version legally, but that is a lawyer's call, not ours.

## Quality (requirement)
- Audio codec Opus with the platform's echo cancellation, noise suppression and automatic gain control switched on; wideband voice at a bitrate that adapts to the network (target 24 to 32 kbps, floor around 12).
- Jitter buffering, packet-loss concealment and in-band forward error correction on, because mobile networks in the target markets drop packets.
- The call shows "Poor connection" to the user and sends quality events (round-trip time, packet loss, relay vs direct) to Sentry/PostHog so we can see problems without hearing calls.
- Acceptance bar for the spike: a 5-minute call on a throttled network (150 kbps, 5% packet loss) stays intelligible and recovers; no one-way audio; no echo on speaker.
- Calls keep the audio session alive in the background and survive switching between Wi-Fi and mobile data (ICE restart).

## Constraints
- Expo 57 development build; Expo Go cannot run WebRTC or CallKit. Read https://docs.expo.dev/versions/v57.0.0/ first (AGENTS.md).
- iOS needs an Apple Developer account (founder has none) for VoIP push and CallKit; Android first.
- Microphone is currently disabled in `app.json`; enabling it changes the Play and App Store privacy answers.
- Every PushKit push must report a call to CallKit or iOS removes push rights.
- Each worktree owns its own `node_modules`. Production deploys and migrations need founder approval.
- New copy English only.

## Unknowns to settle in a spike before the full plan
1. Does a call between two Android phones connect on real mobile networks in the founder's test environment, and through a local Ethiopian SIM?
2. Does the data-channel transcript exchange give both people a complete, correctly ordered transcript, or is the native-tap fallback needed?
3. Real data use per minute and real relay share (how often TURN is needed).
4. Which Expo-compatible incoming-call library handles FCM wake plus the call screen when the app is killed.

## What is left to the builder
Library choices within the constraints above; screen layout; the reducer and state names; migration naming. The builder should verify every third-party API against current docs before use.

## Cost
Per-minute cost is mostly the relay: voice is about 0.2 to 0.5 MB a minute per direction, so 1,000 GB of relay would cover on the order of a million minutes, and a direct path costs nothing. The user pays mobile data. No phone-network leg, so no surcharge for Ethiopia or the Gulf.
