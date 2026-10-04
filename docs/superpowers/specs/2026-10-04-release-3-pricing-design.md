# Release 3: Pricing and payments

**Date:** 4 October 2026
**Status:** Built on branch `pricing`. Not live until Polar is set up (see "Going live").
**Source of truth for prices:** `server/lib/pricing.js`. Polar products are created from it by
`server/scripts/polar-setup.js`, so the app and the checkout cannot disagree.

## The problem pricing has to solve

A Dimts call has two phone legs. Dimts rings the owner, then the other person. What a
minute costs us depends on the country of each leg, and the spread is about 25 to 50 times:

| Leg rings | Carrier cost / min (approx.) |
|---|---|
| US, Canada | ~$0.006 |
| UK, EEA | ~$0.01–0.05 |
| Gulf | ~$0.10–0.30 |
| Ethiopia | ~$0.30–0.50 |

On top of that, AI costs about $0.01 a minute (recording, speech-to-text, summary). A flat
"minutes" plan is either too expensive for a New York user or loses money on every Addis
Ababa call. So pricing works **per leg**.

## The model

1. **Plans buy monthly minutes.** A minute counts against the plan when every leg rings a
   cheap country (US, Canada, UK, EEA).
2. **Expensive legs add a surcharge**, paid from prepaid **credits**, for each minute and
   each leg that rings the Gulf or Ethiopia. Inbound calls arrive on our US number, so only
   the owner's leg is priced.
3. **When plan minutes run out**, calls continue on credits at US$0.03 a minute.
4. **1 credit = US$0.01.** The app shows credits as money ("US$12.40"), never as points.
   Credits never expire.
5. **The dialer shows the price before the call connects** ("US$0.50 a minute from credits ·
   enough for 24 min"), and the server caps the call at what the user can pay for.

## Plans

| | Free | Pro | Business |
|---|---|---|---|
| Price (US$) | 0 | 19 / month, 190 / year | 49 / month, 490 / year |
| Minutes / month | 30 | 500 | 1,500 |
| AI notes, agreements, Ask | ✓ | ✓ | ✓ |
| Recaps, promises, memory check, business number, Google | | ✓ | ✓ |
| Live memory check (when it ships), priority support | | | ✓ |

- **Yearly = 10 months' price** (two months free, about 17% off).
- **Why $19, not the roadmap's ~$15:** a Pro user who calls only US numbers and uses all 500
  minutes costs about $11–13 in carrier plus AI, plus Polar's fee (~4% + $0.40). At $15 a
  heavy user loses money. $19 sits with Otter Pro ($16.99) and Fireflies Pro ($18). Those
  products only take notes; Dimts also places the call and includes the minutes.
- **Why Business at $49 with 1,500 minutes:** about 2.5 times Pro for 3 times the minutes is
  the "best value" anchor. A Business user who uses every minute on European mobiles costs
  more than $49. That is accepted because typical use is far below the cap, and release 4
  (in-app calling) halves the cost of the owner's leg. Review once there is real usage data.
- **Minutes reset on the 1st of each month (UTC)** on monthly and yearly plans alike.

## International

- **Currency:** prices are set by hand in USD, EUR, GBP, CAD, AED and SAR, rounded to look
  deliberate in each currency (£16, AED 69), not converted to the cent. Other countries pay
  USD. Checkout passes the same currency the app showed, so the price never changes between
  the two screens.
- **Tax:** Polar is the merchant of record. It adds VAT or GST or sales tax at checkout and
  remits it, so Dimts does not register for VAT in each EU country, the UK, the Gulf or the
  US states. The plan card says "Tax may be added at checkout".
- **Regional pricing:** Ethiopia gets `lite` prices (Pro $7, Business $19). The region
  comes from the **verified phone number**, not the IP address, so a VPN cannot unlock it.
  Credits cost the same everywhere because they pay real carrier costs, which also stops
  anyone buying cheap and reselling.
- **Language:** the Plans screen and the dialer price line are in English and Amharic.
- **App stores:** Apple and Google require their own billing for digital purchases in most
  countries. Purchases therefore happen on the web (dimts.app) through Polar. Native builds
  show the plan, minutes and credits but no prices and no buy buttons (`src/billing.ts`
  `canBuyHere`). Revisit when native apps ship: US storefronts now allow a link-out, the EU
  allows alternatives under the DMA, and everywhere else needs IAP.
- **Consumer law:** before the buy button, each plan states the price, the renewal interval,
  that it renews until cancelled, and how to cancel. Terms version `2026-10-04` adds plans,
  credits and refunds, including the EU/UK 14-day withdrawal right. Existing users accept
  them once in the app.

## Abuse and cost guards

- `GLOBAL_CALL_MINUTES_PER_MONTH` now caps only the **Free** plan's minutes, shared across
  all free users, as a guard against sign-up farms. Paid plans and credits are never held by
  it. `CALL_MINUTES_PER_MONTH` is gone; plan minutes replace it.
- `CALLS_PER_DAY`, the premium-number blocklist, the country allowlist and the single
  active call per user are unchanged.

## How it is built

- `calls` stores what the call may cost when it is reserved (`billing_tier`, `plan_seconds`,
  `surcharge_cents`, `overage_cents`), so a price change never reprices a call in progress.
- `finish-call.js` sets the real duration, trims plan seconds and debits credits in **one
  SQL statement**, so a carrier retry can never charge twice.
- `credit_ledger` is append-only, and its `source_key` makes every purchase, refund and call
  charge happen at most once. The balance is the sum of the ledger.
- `subscriptions` mirrors Polar. `users.tier` is the best live plan (`active`, `trialing`,
  or `past_due` while Polar retries the card). Older webhook deliveries never overwrite
  newer ones.
- `billing_events` records each webhook ID in the same transaction as its effect.
- Webhooks are verified with Standard Webhooks HMAC-SHA256 within a 5-minute window.
  `whsec_` secrets and Polar's older raw secrets are both accepted.
- Plan changes for current subscribers go through Polar's customer portal, which prorates.
  A second checkout would double-bill.
- Deleting an account revokes its Polar subscriptions first. If Polar cannot be reached, the
  deletion waits instead of leaving a live charge.
- All three new tables get the same Supabase RLS lock-down and backend-role grants as the
  rest of the schema.

API: `GET /api/billing`, `GET /api/billing/quote?to=`, `POST /api/billing/checkout`
`{item, interval}`, `POST /api/billing/portal`, `POST /webhooks/polar`.
App: `app/plans.tsx`, the dialer's `CallPrice`, and the Plan link in Settings.

## Going live (founder actions)

1. Create a Polar organization (sandbox first). Make an organization access token with
   `products:read/write`, `checkouts:write` and `customer_sessions:write`.
2. Run `node --env-file=../.env server/scripts/polar-setup.js` (add `--production` for
   live). It prints `POLAR_PRODUCTS`.
3. Add a webhook endpoint at `https://<domain>/webhooks/polar` for `order.paid`,
   `order.refunded` and `subscription.*`. Copy its `whsec_` secret.
4. Set `POLAR_SERVER`, `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` and `POLAR_PRODUCTS`
   in Vercel.
5. **Apply the schema to the production database** (the new columns and tables, plus the
   RLS and grants files) before deploying. The code expects them.
6. Raise `GLOBAL_CALL_MINUTES_PER_MONTH` to the free-tier budget you are willing to spend.
7. Reconcile `LEG_SURCHARGE_CENTS` against the Telnyx rate sheet. The current rates are
   set above Twilio's published mobile rates on purpose.
8. Sign Polar's DPA. Polar is already listed in `docs/legal/subprocessors.md`.

## Deliberately not done yet

- In-app purchases for the iOS and Android apps.
- An inbound call that finds no minutes and no credits is still refused. Sending it to
  voicemail instead would be kinder to a business line; that is the next change.
- Low-balance push notifications and auto top-up.
- Team seats.
