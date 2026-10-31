# iOS release: free companion app

**Decision (2026-10-31):** the first iOS release has no in-app purchase. It ships under App Store guideline **3.1.3(f), free stand-alone apps**: a free app that works alongside a paid web tool (Apple's own examples include VoIP) needs no in-app purchase, as long as the app has no purchasing and no calls to action to buy outside it. Plans and credits are bought on the web. RevenueCat/IAP stays parked until there is a reason to sell inside the app.

## What the code already does

- `canBuyHere` (`src/billing.ts`) is false on iOS and Android, so the native apps never show prices, buy buttons, a checkout or portal link, or the "buy at dimts.app" line.
- Since 2026-10-31 the native copy has no "Choose a plan", "See plans" or "add credits" prompts. Server errors about minutes or credits get neutral wording on native (`publicErrorMessage` in `src/api.ts`).
- The app keeps showing the plan, minutes, credits and calling rates. That is account status, not a call to buy.
- Account deletion is in the app (Settings), which guideline 5.1.1(v) requires.
- Sign in with Apple is not required while phone-number sign-in is the only way in (guideline 4.8). Revisit when #54 (Google sign-in) ships.
- `ios.config.usesNonExemptEncryption: false` answers the export-compliance question.
- `supportsTablet: false`, so no iPad screenshots are needed.

## Founder steps (about 1 hour, plus review time)

1. **Check the developer account type.** An individual account shows your personal name as the seller. If Dimts will have a company (P1-4), enroll or migrate as an organization first. Moving an app to another account later is possible but slow.
2. **App Store Connect › Apps › +:** platform iOS, name `Dimts: AI Call Notes`, bundle ID `com.philipos24.dimts`, SKU `dimts-ios`, language English (U.S.).
3. **Build:** `eas build -p ios --profile production` from an up-to-date `caller-mvp`. The first run is interactive: sign in with your Apple ID and let EAS create the distribution certificate, the provisioning profile and the **push notification key** (say yes; notifications need it).
4. **Upload:** `eas submit -p ios --latest`. The build appears in TestFlight in 10–30 minutes. Install it on your iPhone through TestFlight.
5. **Smoke test on the iPhone:** sign in, make one real call, check that the notes arrive, delete a test call, and open Settings › Plan (it should show status only, with no prices).
6. **Fill in the listing:** copy from `listing.md`; privacy answers from `privacy-labels.md`; privacy URL https://dimts.vercel.app/privacy-and-your-data; support URL https://dimts.vercel.app; age rating questionnaire (answer honestly, the app is 18+ by terms); screenshots at 6.9" (1320 × 2868), 3 to 10 of them.
7. **App Review Information:** sign-in details for the review-demo account (enter them in App Store Connect, never in the repo), plus these notes:

   > Dimts is a free companion to a paid web service (guideline 3.1.3(f)). The app contains no purchasing and no links or prompts to buy; plans are managed on our website. Calls are placed and recorded by our carrier, not the device microphone; every recorded call begins with a spoken recording notice to the other person. AI providers are named on the consent screen and in Settings › Subprocessors. Emergency calls are not supported; the app says so and points to the phone's dialler.

8. **Submit for review.** Choose manual release, so you decide when it goes live.

## Risks

- **A reviewer may still ask for in-app purchase.** The answer is to quote 3.1.3(f) in the Resolution Center. If Apple insists, the fallback is RevenueCat + IAP (parked, roughly a week of work, and it needs the legal entity).
- **Legal blockers still apply.** Don't make the app public in a store before the P1 items in `PRIORITIES.md` (Polar's answer, the entity, DPAs) are settled. TestFlight is fine now.
