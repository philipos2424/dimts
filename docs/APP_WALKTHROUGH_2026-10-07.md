# App walkthrough, 7 October 2026

The `launch-sprint` branch (production plus encryption at rest, efficiency and
auto-business-number) run locally with the App Store review sample account, at
iPhone size (390×844). No real calls, texts or AI calls. Server tests: 460 of
460 pass.

## What works well

- **Call notes.** "What was agreed" quotes the exact words behind each price
  and date. "Differs from before" puts the earlier quote next to the new one
  ($6.50 quoted, $7.10 invoiced). This is the product; lead marketing with it.
- **This week** on the Ask tab: money, dates and contradictions on one card.
- **Calls list:** each card shows the key money and dates, a warning and the next step.
- **Consent:** the notice text is shown before sign-up and again before the first call.

## Must fix before launch

| # | Finding | Where | Sprint task |
|---|---|---|---|
| 1 | `dimts.app` is not registered. The Plans page sends buyers there; the privacy policy gives `privacy@dimts.app`, which cannot receive mail | `app/plans.tsx`, `src/legal.ts`, `docs/legal/privacy-policy.md` | Founder buys the domain ($9.99, then $15/yr) |
| 2 | No way to buy anywhere in the app. Plans says "buy at dimts.app". Outside the US, pointing iOS users to outside payment breaks Apple rule 3.1.1 | `app/plans.tsx` | 12 |
| 3 | The "Before your first call" screen does not name the AI providers (Apple 5.1.2(i)) | `app/terms-accept.tsx` | 5 |
| 4 | Settings loads Google and devices before the sign-in is restored. Both get 401 and show "Could not load…" / "Unable to load your devices" with no retry | `app/settings.tsx` | 2 |
| 5 | Ask shows "Looking through your calls…" for up to 3 minutes when the AI is slow or down. No timeout, no message | `server/services/llm.js`, Ask screen | 3 |
| 6 | The `production` EAS build profile does not set `EXPO_PUBLIC_API_BASE_URL`. Unless it is set in the EAS dashboard, store builds call `/api` on no host | `eas.json` | 20 |
| 7 | Health check returns `ok` without testing the database, carrier or AI | `/health` | 3 |

## Positioning and polish

- Sign-in tells users not to use "a Twilio … number". Customers don't know
  Twilio, and calls now run on Telnyx.
- The first screen is a phone-number box. Nothing says what Dimts does before
  asking for a number.
- Amharic wordmark ድምፅ next to the logo on every screen; languages are English
  and Amharic only.
- The avatar shows "00" (the last digits of the phone number).
- Ask suggestions sit under the input bar on a phone-height screen.
- Dates mix formats: "Oct 5, 2026" and "9/27/2026" on the same screen.
- Call screen shows "Refresh Gmail draft status" and "Refresh booking status"
  when Google is not connected.
- Dialer is keypad only: no contacts or recent numbers.
- Settings is one long page; plan and minutes sit at the very bottom.
- Retention defaults to "Until I delete" (plan: 12 months).
- The plan card shows "Credits: US$0" without a way to add any.
- App name is lowercase "dimts"; iPad not supported.
- Screen readers hear only the name on each call card, not the money or dates.

## Not tested here

A real two-person call, incoming calls to a business number, push
notifications, Google connections, the share sheet, Polar checkout, and the
native iOS and Android builds. These need real phones (sprint task 20).
