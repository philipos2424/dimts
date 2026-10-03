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

Redeploy after setting them. Then stock the number for incoming calls:
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
