# App Store and Google Play review

Reviewers cannot receive our sign-in texts or answer our calls. The review
account gives them a fixed number and code and a filled-in sample account.

## Switch it on

1. Pick a fictional number in the 555-01xx range, e.g. `+15555550100`, and a
   new random 6–10 digit code. Do not reuse the code anywhere else.
2. In Vercel (Production), set `REVIEW_DEMO_PHONE` and `REVIEW_DEMO_CODE`, then
   redeploy. Both must be set; with either missing the number is ordinary.
3. Sign in on a phone with the number and code. You should see six calls,
   three contacts, and a price flag on the latest call with Dave Brennan.

Every sign-in with the review number resets the account to the same sample
data. Deleted calls, edited contacts, and even a deleted account come back on
the next sign-in. The review number never reaches Telnyx or Twilio: no texts,
no calls, no business number, no caller-ID check.

To switch it off after approval, delete both settings and redeploy. Keep it
on during later reviews; each update is reviewed again.

## What the reviewer sees

A renovation contractor's last ten days:

- A tile supplier quotes $6.50 a square foot; a week later the invoice says
  $7.10, and Dimts flags the difference against the earlier quote.
- A homeowner accepts an $18,400 kitchen quote, then moves the start date and
  adds lighting. Dimts flags the moved date.
- A property manager leaves a voicemail; the follow-up call books a walkthrough.
- Open promises in both directions, ready for Ask questions such as "What did
  Dave quote me for the tile?"

Tapping Call files a short sample call marked "Sample call from the app
review account" instead of dialing.

## Notes to paste into App Store Connect and Play Console

App Store Connect: App Review Information → Sign-in required → user name is
the number, password is the code; paste the text below into Notes.
Play Console: App content → App access → "All or some functionality is
restricted" → add the same instructions.

> **Sign-in:** enter the phone number **+1 555 555 0100** and tap Continue. No
> text message is sent. Enter the code **[CODE]**. The account is filled with
> sample calls and resets on every sign-in.
>
> **What Dimts does:** Dimts places business calls through our phone network,
> plays a recording notice to the other person ("This call is recorded and
> summarized by Dimts AI"), and then shows a summary, the agreements made, open
> promises and drafted follow-ups. The Ask tab answers questions across past
> calls.
>
> **Calls in the review account:** the review number is fictional, so tapping
> Call creates a sample call instead of ringing a phone. On a real account the
> app rings the user's own phone and connects the other person.
>
> **Recording and permissions:** the app does not use the microphone and does
> not record calls on the device. Recording happens on our server-side phone
> connection, only for calls placed through Dimts, after the audible notice.
> Audio is stored in the EU and is not used to train AI models.
>
> **Purchases:** subscriptions are sold on our website. The app shows the
> current plan only. [In the US storefront, a link to the website is shown.]
>
> **Account deletion:** Settings → Your data → Delete my account.
