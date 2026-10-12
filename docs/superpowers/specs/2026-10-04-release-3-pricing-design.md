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
| Ethiopia | **$0.336 measured** (Telnyx bill, 4 Oct 2026) |

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

## Retention and cost control (added 4 October 2026)

**Measured margin on Ethiopia.** Telnyx bills $0.3361 a minute for an Ethiopian leg,
plus $0.002 call control and $0.002 recording, about $0.34 in total. The 50¢ surcharge
less Polar's fee of about 12% on credit packs leaves about $0.10 a minute: positive, but
thin. Do not lower it.

- **Business numbers come with Pro and Business.** Each number costs about $1 a month
  whether or not it rings. Free accounts get a "See plans" link instead of a number. When a
  paid plan ends, the number stays for **30 days** (`users.number_release_at`), shown on
  the Plan screen and next to the number. Paying again cancels the release. After 30 days
  the daily cron releases it to the back of the pool queue. Numbers that Free accounts held
  before this change are left alone.
- **Incoming calls are never refused for money.** When the owner has no minutes and no
  credits, the caller hears the recording notice and can leave a message of up to 2
  minutes. That call is recorded as missed with voicemail and costs the owner nothing. The
  owner gets one push a day explaining why. If the owner has not accepted the terms, the
  call is still turned away, because we cannot record without consent.
- **Warnings come before a call fails, not after.** Pushes are sent at 80% and 100% of
  plan minutes (once each per month) and when bought credits fall below US$2 (once per
  purchase). Tapping one opens Plan. The push carries only a type; the app decides where
  to go.
- **Unit economics from real bills.**
  - `calls.est_cost_micros` stores our estimate for each finished call.
  - `provider_costs` stores what Telnyx actually billed, per day, record type and country.
    The daily `/api/cron/retention` run copies it from Telnyx detail records, skipping
    today and the oldest day because they may be partial.
  - `payments` stores every Polar order (plans and credits) with tax and refunds.
  - `node --env-file=../.env server/scripts/unit-economics.js 2026-10 [--sync]` prints
    revenue, Polar fees, the carrier bill by country, estimated AI cost, numbers held, and
    gross profit.
  - Fixed platform costs are not included.

## Deliberately not done yet

- In-app purchases for the iOS and Android apps.
- Auto top-up (Polar one-time purchases cannot charge a saved card off-session).
- An in-app cancel screen (pause or downgrade, plus one "why" question) before Polar's portal.
- Team seats.

## Pricing v3 (12 October 2026): from $20, with price anchoring

Founder decision: plans start at $20, and the plans screen uses price anchoring.

| | Monthly | Yearly (10 months' price) | Shown on the yearly toggle |
|---|---|---|---|
| Pro (500 min) | $20 · €20 · £16 · C$28 · AED/SAR 75 | $200 | $16.67/mo, "billed $200 a year, save $40" |
| Business (1,500 min) | $50 · €50 · £40 · C$70 · AED 185 · SAR 190 | $500 | $41.67/mo, "save $100" |

- **Round numbers.** $20 and $50 read as deliberate. They also leave room for $19.99 in-app tiers.
- **One price list everywhere.** The Ethiopia `lite` discount ($7/$19) is retired. At $7, card fees took about
  14% and the minutes cost more than the plan. Ethiopian numbers can still sign up and buy, at the standard
  price. Old `_lite` product keys still parse, so any past webhook or order is still understood.
- **Anchoring, kept honest:**
  - Business is listed first, so Pro is judged against $50.
  - Yearly is selected by default and shows its monthly equivalent and the saving against this plan's
    own monthly price.
  - Monthly shows a per-day figure.
  - There are no invented "was" prices or strike-throughs (EU price-reduction rules), and the renewal
    line always states the amount billed.
- **Polar.** `scripts/polar-setup.js` now archives any tagged product whose prices no longer match this
  table (and the retired regional ones) and creates replacements, then prints the new `POLAR_PRODUCTS`.
  Archived products take no new purchases. Existing subscribers keep their price.
- **Margins.** US Pro at full use costs about $14 against $20. Every earlier conclusion holds, with about
  $1 more margin per Pro user.
