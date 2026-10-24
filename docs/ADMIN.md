# Operator console (`/admin/`)

Written for the Dimts founder and anyone given staff access. Branch
`master-admin`, 7 October 2026.

## Turning it on

1. Apply `server/db/migrations/20261007_master_admin.sql` to production
   **before deploying** (audit reasons, passkey tables with row-level security
   and backend grants). It is additive and safe to run twice. Also apply
   `server/db/migrations/20261024_admin_setup_links.sql` (the permanent record
   of used setup links) before deploying the release that contains it.
2. Set `ADMIN_PHONES=+251…` (comma-separated E.164) in Vercel, Production.
3. Deploy.

## Signing in

- **First time, with no text or call (one-time setup link):**
  1. Run `node server/scripts/admin-setup-link.js <staff phone> [hours]`. It
     prints the value for `ADMIN_SETUP_TOKEN` (`<staff phone>:<secret>:<expiry>`)
     and the link. The link lasts 24 hours unless you say otherwise, and never
     more than 7 days.
  2. Set `ADMIN_SETUP_TOKEN` in Vercel (Production) and redeploy.
  3. Open `https://dimts.vercel.app/admin/#setup=<secret>` and press **Set up Face ID or fingerprint**.
  4. Delete `ADMIN_SETUP_TOKEN` in Vercel.

  How the link stays safe:
  - It works once. The use is a permanent row in `admin_setup_links`, saved in the same database transaction as the passkey: both happen or neither does, and two people holding the link cannot both succeed. Nothing relies on the audit log, which expires after a year.
  - It stops working at its expiry. A value with no expiry, or one more than 7 days away, is refused.
  - It only works for a number on `ADMIN_PHONES`.
  - The secret sits after `#`, so browsers never send it to the server or its logs, and the page clears it from the address bar.

  For a lost device, make a new link: each value is a new one-time link. Links used before `admin_setup_links` existed are recorded only in the audit log and stay refused while those entries last.
- **First time, the other way:** sign in to `https://dimts.vercel.app` with your
  staff number (one text or call code), open `/admin/` and press **Set up Face
  ID or fingerprint**.
- **After that:** open `/admin/` and press **Sign in with Face ID or
  fingerprint**. No code. The passkey syncs through iCloud Keychain or Google
  Password Manager, so it also works on your other devices signed in to the
  same account.
- Console sessions last 12 hours. **Sign out** ends the session in that browser.
- Removing a number from `ADMIN_PHONES` stops its passkeys working immediately.
- A passkey is bound to the site address (`PUBLIC_BASE_URL`, or
  `ADMIN_PASSKEY_ORIGIN` if set). Moving to a new domain needs new passkeys.

Anyone not on the list gets a plain 404 from the API. Passkey sign-in is
rate-limited per IP. Each challenge works once and expires in five minutes.
The server keeps only the passkey's public key.

## What the law allows here, and how the console keeps to it

| Rule | Where it comes from | How the console follows it |
|---|---|---|
| For call content Dimts is a **processor**: it may process it only on the customer's instructions | GDPR Art. 28(3)(a), UK GDPR, our terms ("Data processing") | No endpoint selects transcripts, summaries, recaps, notes, contact names, numbers called or audio. Sealed columns appear only in SQL tests that return true/false. Tests fail if call text or full numbers appear in a response. |
| Purpose limitation and transparency for measurement | Art. 5(1)(b), 6(1)(f), 13 | Measurement uses only account, usage and billing records, under legitimate interests. This is now stated in the privacy policy (`docs/legal/privacy-policy.md`, `src/legal.ts`). |
| Data minimisation | Art. 5(1)(c), 25 | Lists show masked numbers (`+44 ••• 0123`). Search takes an exact number, the last 4 digits or an account ID, never partial numbers, so it can't be used to enumerate customers. The full number needs a stated reason. |
| Accountability and staff access control | Art. 5(2), 32(1)(b), 32(4) | Allowlist, 12-hour sessions and rate limits. Every request is written to `audit_events` (`admin_*`). Opening an account, revealing a number or granting credits needs a reason from a fixed list and is shown to the customer in their activity log, with the reason. |
| Storage limitation of logs | Art. 5(1)(e), privacy policy ("kept for one year") | The daily retention job now deletes activity-log entries older than one year (`expireAuditEvents`). |
| Right of access | Art. 15 | The customer's data export includes staff access events and their reasons. |
| California | CCPA/CPRA §1798.100, .105, .140 | Same data limits. No sale or sharing; measurement is a business purpose. |

Do not add call content, contacts or numbers called to this console. A
customer who needs help with a specific call can share it from the app.

## Pages

Built around four operator questions: is it healthy, what changed, where is
the bottleneck, and what should someone do now. The period picker (7, 30 or
90 days) drives Today, Growth's funnel and Operations.

- **Today** (opens first, refreshes every minute). An overall status, then a
  *Needs attention* list (failing checks first, each with what to do), then
  *What changed*: eight key numbers against the previous period, with
  direction and "better/worse" in words. Then live service health:
  - Database and Telnyx balance (warning below `TELNYX_LOW_BALANCE_USD`, default $20; failing below $5).
  - AI keys, calls stuck making notes for 15+ minutes, our call failures in 24 hours.
  - Free business numbers, and a roll-up of the Compliance checks.
- **Growth.** Customers and activity, a strict sign-up funnel (each step
  counts only people who passed every step before; the biggest drop is named),
  sign-ups, plans, markets, weekly retention cohorts, feature adoption.
- **Revenue.** MRR, paying customers, churn, gross margin, credit liability,
  payments, plans, carrier cost by country.
- **Operations.**
  - Call outcomes, our failures and unanswered calls per day.
  - *Why calls failed*, grouped into fixed categories. The stored error text
    is never shown, because it can quote what a provider received.
  - Outcomes by country called (country code only), queues, the number pool
    and its cost, and press-1 consent.
- **Customers.** Search and open an account with a reason. Reveal the full
  number or grant goodwill credits (at most 5,000 credits, or $50, per grant;
  20 grants per staff member per day).
- **Compliance.** Live checks of our legal promises, each with its source and
  what to do when it fails.
- **Access log.** Every staff request: who, when, which account and why.

**"Our failures" vs "unanswered":** busy, no-answer and cancelled calls are the
other person's choice and count as *unanswered*. Every other failure is ours to
fix.

## Measurement definitions

The App Store review account (`REVIEW_DEMO_PHONE`) is excluded throughout.

- **Active accounts:** not deleted. **Market:** from the calling code of the
  verified number (US/Canada, UK, EU/EEA, Gulf, Ethiopia).
- **Connected call:** `duration_sec > 0` or a voicemail was left.
- **Monthly / weekly / daily active (called):** accounts with a connected call
  in the last 30 / 7 / 1 days. **Opened the app:** session `last_seen_at` in
  the window (written at most every 10 minutes).
- **Activation:** of accounts created 7–90 days ago, the share with a
  connected call within 7 days of sign-up. Includes the median time to first call.
- **Trial → paid:** of trials that have ended, the share now on Pro or Business.
- **Paying customers / MRR:** subscriptions that are `active`, `trialing` or
  `past_due`, valued at the **US list price** of their product (yearly ÷ 12).
  Local-currency revenue is in the payments table.
- **Churn (30 days):** subscriptions that became canceled, unpaid, revoked or
  expired in 30 days ÷ (paying now + those).
- **Gross margin (USD, 30d):** USD payments after tax and refunds, minus the
  Telnyx bill (or our per-call estimate before the bill syncs). Polar fees and
  fixed costs are not included; `scripts/unit-economics.js` includes Polar fees.
- **Cohorts:** accounts by sign-up week (Monday, UTC); cell *Wk* = share with
  a connected call in week *k* after the start of their sign-up week.
- **Credits outstanding:** the sum of the ledger for live accounts. Prepaid
  credits are a liability until used.

## Compliance checks

| Check | Fails when |
|---|---|
| Deletion requests from people who were recorded | unresolved after 30 days (warning from day 23) |
| Calls past retention | still stored 2+ days after the owner's period |
| Deletion backlog | a call deleted 1+ day ago still has audio at the carrier or in storage |
| Archive backlog | recordings 1+ day old still only at the carrier (EU residency) |
| Recording authorization | a stored recording lacks the notice or press-1 consent its mode requires (same SQL as the live gate in `lib/recording-policy.js`) |
| Encryption | a transcript, summary or contact note is not sealed (`dmt1.` prefix) |
| Activity-log retention | entries older than one year exist |
| Terms, staff reveals | for information |

Outside the code (DPAs, counsel questions, lawyer review): see
`docs/legal/dpa-checklist.md`.
