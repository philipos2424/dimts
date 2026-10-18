# Telnyx setup

Dimts runs on Twilio or Telnyx. `CARRIER=telnyx` switches calls, recordings
and sign-in codes to Telnyx; every other setting stays the same.

## In the Telnyx portal (Mission Control)

1. **Account**: complete identity/business verification and add a payment
   method. Unverified accounts cannot call internationally.
2. **Number**: buy one voice-enabled number (US for launch).
3. **TeXML Application** (Voice → Programmable Voice → TeXML Applications):
   - Voice URL: `https://dimts.vercel.app/twiml/incoming`, method **POST**
   - Status callback: `https://dimts.vercel.app/webhooks/call-status`, method **POST**
   - Assign the number to this application.
   - Attach an Outbound Voice Profile that allows only the launch countries
     and Ethiopia.
4. **Verify Profile** (Identity → Verify): enable **SMS** and **Call**;
   allowed destinations: launch countries and Ethiopia.
5. **API key** (Account → Keys & Credentials → API Keys): create one.
6. **Public key** (Account → Keys & Credentials → Public Key): copy it.
7. **Account ID**: Account → Account Settings ("User ID"). TeXML calls it the
   AccountSid; it is a UUID.

## In Vercel (Production and Preview)

| Variable | Value |
|---|---|
| `CARRIER` | `telnyx` |
| `TELNYX_API_KEY` | API key (sensitive) |
| `TELNYX_ACCOUNT_SID` | account/user ID (UUID) |
| `TELNYX_TEXML_APP_ID` | TeXML application ID |
| `TELNYX_VERIFY_PROFILE_ID` | Verify profile ID |
| `TELNYX_PUBLIC_KEY` | public key (base64) |
| `TELNYX_NUMBER` | the number, E.164 |

Redeploy after setting them.

Business numbers for incoming calls are bought automatically: when a Pro or
Business owner has no number (right after their subscription webhook, or when
they tap "Get my business number") and the pool is empty, Dimts orders a local
number in their country, attaches it to the TeXML application and assigns it.
The API key needs number-ordering permission and the account needs a balance.

| Variable | Default | Meaning |
|---|---|---|
| `NUMBER_COUNTRIES` | `US` | ISO countries to buy in (`US,CA,GB,IE,DE,FR,NL,ES,IT,SE` supported). Owners get a number in their own country, or none. US and CA need no paperwork. |
| `NUMBER_REQUIREMENT_GROUPS` | empty | `GB=<id>,DE=<id>`: the approved Telnyx requirement group (address/ID) per non-+1 country. A listed country without one is skipped, so no order waits on paperwork after a customer was given the number. Create groups in Mission Control > Numbers > Requirement groups. |
| `NUMBER_AUTOBUY_DAILY_MAX` | `20` | Purchases allowed per day across all accounts (each account: 2 an hour). |
| `NUMBER_AUTOBUY` | on | `off` stops purchases; claims then use only hand-stocked numbers. |

To add a number you already own instead, stock it by hand:
`node --env-file=.env server/scripts/stock-number.js +1XXXXXXXXXX`.

## How Telnyx differs (already handled in code)

- Webhooks are signed with Ed25519 over `timestamp|raw body`
  (`telnyx-signature-ed25519`, `telnyx-timestamp`), checked with a 5-minute
  replay window.
- Call SIDs look like `v3:…`; recording and account SIDs are UUIDs.
- Creating a call may not return its SID; the first webhook supplies it.
- Recording links are short-lived; downloads fetch a fresh link by SID.
- The dialled leg's instructions may only hold `<Gather>`/`<Hangup>`, and an
  empty `<Gather>` does not call back. Notice calls therefore record through
  `<Dial record="record-from-answer-dual">`; the two people are connected only
  after the notice. Consent prompts redirect on silence instead of hanging up.
- Calls cannot be listed by parent, so ending a call fetches the dialled leg
  by the stored `child_call_sid`.

## Before real users

Test on real phones: an outbound call, an incoming call, a missed call with
voicemail, a Gulf-number call (both press 1), SMS and voice-call sign-in codes,
playback and deletion of a recording.
