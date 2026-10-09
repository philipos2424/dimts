# Launch sprint, 7–10 October 2026

Source: [the growth and compliance strategy report](../../../reports/Dimts%20growth%20and%20compliance%20strategy.md)
(kept outside git, in the main checkout's `reports/`).

Goal: a Dimts app (iOS and Android) that professionals in the US, Canada and
the UK can try, trust and pay for, with failures we can see. The EU and Gulf
stay closed to marketing until counsel clears them.

Branch: `launch-sprint`, cut from production (`origin/caller-mvp@428f95e`)
with `security-hardening`, `efficiency` and `auto-business-number` merged.
Germany and Austria keep press-1 consent.

Decisions (7 October):
- Payments: Apple/Google in-app purchase through RevenueCat everywhere, plus a
  US-only link to Polar web checkout.
- The permanent free tier becomes a 21-day Pro trial that starts after the
  first real call, capped at about 100 minutes, with a business number.
  Afterwards the free plan keeps read-only access to past calls.
- PostHog for product analytics and Sentry for errors, both EU-hosted.

Owner: **C** = Claude (code), **F** = founder (accounts, money, contracts, stores).

## Day 1: see how the app works, stop silent failures

| # | Task | Owner | Done when |
|---|---|---|---|
| 1 | Walk through the whole app as a user: sign-in, onboarding, sample calls, notes, Ask, recap, plans, settings, deletion. Run it locally with the review sample account | C | Bug and friction list with screenshots |
| 2 | Finish the sprint branch, run every test, open one PR | C | Tests green, PR open |
| 3 | Sentry in app and server. Alerts on failed call processing. Telnyx low-balance alarm. Health check that tests database, carrier and AI | C | A forced failure produces an alert |
| 4 | Top up Telnyx. Create Sentry and PostHog accounts (EU) | F | Keys in Vercel and EAS |

## Day 2: compliance in the app

| # | Task | Owner | Done when |
|---|---|---|---|
| 5 | Consent screen naming the AI providers, with explicit permission (Apple 5.1.2(i)) | C | Shown before the first call; stored with a version |
| 6 | One LLM vendor (OpenAI, storage off). Diarization off for mono audio | C | Config and tests |
| 7 | Not-for-emergency notice. Age 18+. 12-month default retention. Correct privacy-policy legal basis and deletion claim. One subprocessor and region list | C | Docs and app text agree |
| 8 | Business numbers only for US and Canadian owners | C | Test |
| 9 | Sign-in screen without "Twilio". Birr and Addis keyterms only for +251 numbers | C | Test |
| 10 | Sign the OpenAI DPA and ElevenLabs zero retention | F | Signed copies filed |

## Day 3: money and conversion

| # | Task | Owner | Done when |
|---|---|---|---|
| 11 | Regional overage at or above cost. Caps on UK and EEA plan minutes | C | Pricing tests per region |
| 12 | RevenueCat in-app purchases (Pro and Business, monthly and yearly, credit packs). US-only link to Polar. Server entitlements from both | C | Sandbox purchase unlocks Pro |
| 13 | 21-day trial replacing the free tier; read-only archive after | C | Trial start, cap and expiry tested |
| 14 | PostHog funnel: signup, first routed call, first notes, Ask or recap, paywall view, paid | C | Events visible in PostHog |
| 15 | App Store Connect and Play Console products. RevenueCat account. Real $10 Polar purchase and refund | F | Products approved for sandbox |

## Day 4: growth and launch

| # | Task | Owner | Done when |
|---|---|---|---|
| 16 | Onboarding: what Dimts does, the sample account for everyone, a guided first real call, then the paywall | C | New user reaches notes on the sample in under a minute |
| 17 | "Sent with Dimts" line on shared recaps and drafts. Referral credits | C | Tested |
| 18 | App Store and Play listing copy for US and UK professionals | C | Copy in `docs/store/` |
| 19 | Rewrite `docs/CALL_RECORDING_REVIEW_RESEARCH.md` and the roadmap audience section | C | Merged |
| 20 | EAS builds for iOS and Android. Pre-release test on real phones. Production deploy only with founder approval | C/F | Real two-person call recorded with notes |

## Not in this sprint

These need counsel, carrier paperwork or native-speaker review:
EU customer DPA, EU/UK representative, DPIA; Gulf telecom licensing; UK and EU
local numbers; translated consent prompts; team seats; CRM sync; missed-call
answering.
