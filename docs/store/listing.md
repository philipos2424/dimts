# Store listing copy (English only)

Draft for App Store Connect and Google Play Console. Every claim below maps to something shipped on `caller-mvp` as of 2026-10-24. Keep it that way: remove a line when the feature goes, and add one only after it ships.

**Rules this copy follows**

- No prices, plan names, "upgrade" or "buy" wording, and no link to a web checkout. Native apps are consumption-only (Apple 3.1.3(f), Google Payments policy); purchases happen on the web. Revisit if in-app purchase is added.
- No promise that Dimts sends anything on its own. It drafts; the user approves.
- No emergency-call, legal, medical or financial-advice claims. The app states that emergency calls go through the phone's own dialler (`EMERGENCY_NOTICE` in `src/legal.ts`).
- AI providers are named in the app and on /subprocessors; do not write "no third parties".
- Age: 18+.

## Shared

| Field | Text | Limit |
|---|---|---|
| App name | Dimts: AI Call Notes | 30 |
| App Store subtitle | Call notes and follow-ups | 30 |
| Google short description | AI notes, agreements and next steps from your business calls. | 80 |
| App Store promotional text | Stop taking notes on calls. Dimts records with a spoken notice, then gives you the summary, what was agreed and what to do next. | 170 |
| App Store keywords | call notes,call recorder,business calls,transcribe,summary,follow up,meeting notes,AI assistant | 100 |
| Category | Business (primary), Productivity (secondary) | |
| Support / privacy URLs | https://dimts.vercel.app (support), https://dimts.vercel.app/privacy-and-your-data (privacy). Swap to dimts.app when it exists; the privacy-requests test asserts the contact. | |

## Full description (both stores)

Business calls are where promises get made, and where they get lost.

Dimts is an AI assistant for your business phone calls. It records the call after a short spoken notice to the other person, then turns it into notes you can use: a summary, what was agreed, and what to do next.

WHAT YOU GET

- Clear notes after every call. A short summary, the agreements and the next steps, with the exact moment each came up so you can check the recording.
- Money first. Prices, deadlines and amounts are pulled to the top, not buried in a transcript.
- Ask your calls anything. "What did we agree with Sam?" "Who still owes me an answer?" Ask answers from your own calls. Your questions are answered and then discarded.
- A briefing for your week. Open the app to see what needs your attention, starting with what you promised and what you were promised.
- Follow-ups you approve. Dimts drafts the reply or the calendar event. Nothing is sent or booked until you say so.
- You choose what is recorded. Pick, per caller, whether incoming calls are recorded, and set a default for everyone else.
- A people list that fills itself. Each person you speak with gets a page with your history together.
- Try it in a minute. Tap for a demo call and see real notes before you use it on a real conversation.

PRIVATE BY DESIGN

- Every recorded call starts with a spoken notice, so the other person always knows.
- Recordings, transcripts, summaries and notes are encrypted before they are stored, with a key unique to your account.
- Lock the app with Face ID, fingerprint or passcode. See every signed-in device and sign out everywhere.
- Delete a call, a contact or your whole account at any time in Settings. Download your data whenever you like.
- We do not sell your data, use it for advertising, or train AI models on your calls.
- You can see which providers process your calls on the Subprocessors page in the app.

GOOD TO KNOW

- Dimts is for adults (18+) and for lawful business use. You are responsible for recording lawfully where you and the other person are.
- Summaries and suggested next steps are written by AI and can be wrong. Check them before you rely on them.
- Dimts is not for emergency calls. For an emergency, use your phone's own dialler.
- An account and a mobile phone number are required.

## What's new (first release)

Welcome to Dimts. Record business calls with a spoken notice and get a summary, agreements and next steps in minutes.

## Review notes (App Review and Play review)

- Demo account: the in-app review demo sign-in (see `server/` review-demo account; not documented here on purpose).
- Purchases: none in the app. Plans are bought on the website; the app shows status only.
- Microphone: the app does not capture audio on the device. Calls are placed and recorded by the carrier, so Android `RECORD_AUDIO` is blocked in `app.json`.
- AI disclosure: Settings > Subprocessors lists the providers; the consent screen (`app/terms-accept.tsx`) names them before first use.
- Emergency notice and 18+ gate: shown on the consent screen.

## Still to do before submission (not copy)

- [ ] Screenshots: briefing, a call's notes with the timestamped agreements, Ask, the demo call, the people list. Phone sizes for both stores.
- [x] Apple privacy labels and Google Data Safety: drafted in `privacy-labels.md` from the code on 2026-10-31.
- [ ] iOS: follow `ios-release.md`.
- [ ] Decide the support URL and email (public contact is a Gmail until dimts.app exists).
- [ ] Rebuild the Android .aab from current `caller-mvp`. The 2026-10-11 build predates #59, #60, #61 and #63.
- [ ] Founder confirmation on the legal blockers in `PRIORITIES.md` P1 before any public store listing.
