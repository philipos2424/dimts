# Dimts roadmap: international launch

**Date:** 2 October 2026
**Status:** Decided. Each release gets its own spec, then a plan, then the build.
**Base:** branch `caller-mvp` (`e4200b2`). The `master` branch is a month older and should not be used.

---

## Product in one sentence

Dimts is an AI that sits on your business phone line. It records every call
with a clear notice, tells you what was agreed, drafts the next step for you to
approve, and remembers what people promised you, including when they later say
something different.

## Who it is for

International launch to three groups at once, all held to one standard:

1. **Europe and the UK.** Full GDPR applies.
2. **US and Canada.** Phone numbers are easy to get, so this is where launch starts.
3. **Diaspora businesses** (Ethiopian/Habesha and others) in the US, Europe and
   the Gulf who call clients and suppliers across borders.

**Launch countries for signup:** US, Canada, UK, EU/EEA, and the Gulf (UAE,
Saudi Arabia, Qatar, Bahrain, Kuwait, Oman).
**Ethiopia is not a signup market at launch.** Calls there cost about $1/min,
Twilio cannot issue Ethiopian numbers, and local card payment is hard.
Ethiopia stays a **call destination**, paid from prepaid credits, and
**Amharic stays fully supported.**

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Privacy standard | GDPR-level protection for every user, everywhere | One rule is simpler than per-region rules, and Europe never becomes a special case |
| Recording consent | **One rule: `notice`.** The owner accepts once at signup. The other person hears "This call is recorded and summarized by Dimts AI" before every recorded call. Nobody presses keys. | Legal in nearly every launch market, nothing to configure, and it removes the two-keypress friction that the review research flagged |
| Retention | Kept until the user deletes it. Export and delete must be easy and must actually work. | User choice. This is defensible under GDPR's storage-limitation rule only if the user has real control |
| Audio location | Copied off Twilio (US) into private EU storage, then deleted from Twilio | Data stays in the EU, there is one place to secure and delete, and storage is cheaper |
| Server location | Vercel functions in Frankfurt (`fra1`). Database already in Zurich. | EU residency |
| App structure | Three tabs: **Today**, **Call**, **Ask** | Feels like an assistant reporting back (option A) |
| Brand | **Highland**: forest green `#13392a`, coffee-gold `#c8922e`, warm white `#fbfaf6`, Fraunces + Inter, ድምፅ in the wordmark | Elegant and distinctive. The violet-on-dark look is generic AI styling, and cream-and-ink reads like Anthropic |
| Payments | **Polar** (merchant of record, handles VAT and sales tax). Plans + prepaid credits. | Polar pays out to Ethiopia, the UK, US, UAE and others. Credits cover the 25× spread in call costs between countries |
| Memory check | First version: briefing before the call and contradiction flags after it. Second version: a live alert during the call, either a whisper heard only by the owner or a silent card, chosen automatically (option C) | The first version delivers most of the value at no running cost. The live version needs in-app calling's audio stream |

## Releases

### Release 1: Trust foundation
GDPR, security and data location. Detailed in
`2026-10-02-release-1-trust-foundation-design.md`.

### Release 2: AI-first redesign
- Today / Call / Ask, in the Highland brand with light and dark modes.
- Call cards showing "✓ both voices" or "⚠ only your voice", the specific
  agreements (names, numbers, dates), and one drafted next step with **Approve**.
- Agreements carry timestamps; tapping one plays that moment.
- One-tap fix for an AI-assigned name.
- **Ask:** questions in plain language across all calls. Every answer cites a
  call and a timestamp.
- **Memory check, first version:** a briefing before the call ("Last time: 500/unit…")
  and contradiction flags after it ("⚠ said 450; on 3 Oct agreed 500"), with both clips.
- **Recap to the other person:** after the call, one tap sends "here's what we
  agreed" by email, SMS or share sheet.
- **Promises tracker:** "You promised" / "They promised", with reminders.
- **Summaries in the user's language**, whatever language the call was in.
- The Contacts and Notes tabs go away. People open from cards, and Settings
  sits behind the avatar.

Lessons from the reviews that this release must meet:
- Never present one-sided or silent audio as a success.
- Keep the audio when AI processing fails.
- Use specific facts, not generic summaries.
- Make names easy to fix.
- Never ask for a rating before the user has had value.
- Make support reachable.

### Release 3: Payments (Polar)
- Plans:
  - **Free:** 30 min, AI notes.
  - **Pro, about $15/month:** 500 min to low-cost countries, plus recaps, promises and memory check.
  - **Business, about $39/month:** 1,500 min, plus the live memory check when it ships.
- **Credits** for expensive destinations, Ethiopia included. The dialer shows the
  per-minute price before connecting.
- Lower prices in lower-income countries, using Polar's per-country pricing.
- Signup limited to launch countries.
- Polar webhooks verified by signature. Cancel and manage the plan in the app.
- Before any charge, show the renewal interval, total price, included minutes
  and how to cancel.

### Release 4: Cheaper calls + live AI
- **In-app calling** with the Twilio Voice SDK: the owner's leg goes over the
  internet (about $0.004/min), roughly halving international costs. The swap
  happens in `server/services/originate.js`.
- **Dimts-to-Dimts calls** over the internet at near-zero cost.
- **Live memory check**: streaming transcription and a check against stored
  agreements, delivered as a whisper or a card. It needs an always-on
  WebSocket service (Fly.io or Railway), because Vercel functions cannot
  hold call streams.
- **Telnyx vs Twilio** price and quality comparison.
- **AI answers missed calls**, takes a message, and adds a Today card.

## Cost model (published prices, approximate, 10-minute call)

| | Today (two phone legs) | With in-app calling |
|---|---|---|
| US ↔ US | ~$0.25 | ~$0.20 |
| Ethiopia user | ~$9.80 | ~$5.00 |
| Transcription + AI | ~$0.07 | ~$0.04 |

## Not decided yet (owner actions outside the code)

- **Twilio:** upgrade off the trial, or verify test destinations, before any real recording test.
- **Speech-to-text:** set an ElevenLabs key in Vercel.
- **Data-processing agreements:** sign them with Twilio, ElevenLabs, OpenAI, Supabase, Vercel and Polar.
- **Legal review:** have a lawyer review the privacy policy and terms before the EU launch.
