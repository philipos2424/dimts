# Internet calling in the Dimts app — design

**Decision (founder, 2026-10-20):** keep the normal phone-call flow exactly as it is. Add internet calling inside the Dimts app as a second way to take and place calls. Calls must be encrypted.

## Why
Neither iOS nor Android lets an app record a cellular call. If the app *is* the phone (voice over internet), it owns the audio, so it can place and answer calls and the server can record and summarize them with no extra person on the line. Granola does this on iPhone for outgoing calls only; Dimts can also take incoming calls to the business number.

## Goals
- Place a call from the Dimts dialer over the internet (outgoing).
- Business-number calls ring inside the app and are answered there (incoming), also when the app is closed.
- Same consent notice, recording, notes, promises and billing as today.
- Works on Android and iOS.

## Non-goals / anti-goals
- No change to the existing callback flow; it stays the default and the fallback.
- No Ethiopia launch of this feature until counsel has confirmed that bridging internet calls to phone numbers is allowed there (unresolved; see reports/legal-launch-review-2026-10-11.md). Gate by country in code.
- Not true end-to-end encryption (see below). Do not market it as such.
- Gulf numbers (press-1 consent from every party) are out of scope for v1.

## Encryption — what is and is not possible
| Hop | Protection | How |
|---|---|---|
| App ↔ Telnyx | Encrypted | WebRTC always uses DTLS-SRTP; signalling over TLS (wss). |
| Telnyx ↔ Dimts server | Encrypted | Webhooks over HTTPS, signed; recording fetched over HTTPS. |
| Telnyx ↔ the other person's phone | **Not controllable** | Ordinary phone network. SIP-TLS/SRTP only where the far carrier supports it. |
| Stored audio and notes | Encrypted at rest | Existing DMA1 chunked AES-GCM and field encryption (DATA_ENCRYPTION_KEYS). |
**End-to-end is impossible while Dimts transcribes**: the server must hear the audio. State this plainly in the privacy copy: "encrypted in transit and at rest; Dimts and its processors can access call audio to make your notes".

## How it works
1. Telnyx WebRTC (`@telnyx/react-native-voice-sdk`), SIP credential per user, minted by the server with a short-lived token (never ship the API key). Verify the exact package and API against Telnyx docs before building.
2. Outgoing: the app places the call to a Dimts SIP URI; the existing TeXML app handles the call like today (notice, record, bridge), except the owner leg is the app instead of a phone ring.
3. Incoming: business-number calls ring the user's SIP credential as well as the phone; push (PushKit on iOS with CallKit, FCM high-priority on Android with a full-screen notification) wakes the app. First to answer wins.
4. Fallback: if the app is unreachable or data is poor, ring the phone as today.

## Cost
Telnyx lists app calling at $0.002/min on top of SIP trunk rates, plus the user's mobile data. Replacing the owner's phone leg with an app leg saves most for owners in expensive countries (Ethiopia leg measured at ~$0.34/min in server/lib/pricing.js), little elsewhere. The far party's phone leg is unchanged. Update LEG_COST_MICROS/pricing only after measuring real Telnyx invoices.

## Work the builder cannot skip
- Native build: Expo Go cannot run this; needs a development/EAS build with VoIP background modes (iOS) and foreground-service permissions (Android). Read the Expo v57 docs first (AGENTS.md).
- Apple VoIP push rule: every PushKit push must show a CallKit call or iOS kills the app's push rights.
- Founder-only: Telnyx top-up (balance was $2.24), Apple Developer account (none yet), real-device testing on both OSes.

## Open questions for the founder
1. Ship internet calling to all markets except Ethiopia/Gulf first? (assumed yes)
2. OK to require a development build (no more Expo Go testing for this feature)? (assumed yes)

## Phases
1. Spike: place one outgoing app call to a real phone and confirm recording and notes work (Android first; no Apple account needed).
2. Outgoing for both platforms, behind a setting.
3. Incoming with push, then fallback to phone ring.
4. Privacy copy, country gate, pricing review.
