# Dimts Privacy Policy

> **DRAFT. Requires review by a qualified lawyer before the EU launch.**
> The app shows this text from `src/legal.ts`. Keep the two in sync.
> Version `2026-10-07` (matches `TERMS_VERSION`).

## Who we are
Dimts is an AI assistant for business phone calls. For your account data,
Dimts is the **controller**. For the people you speak with, **you** are the
controller: you decide to record them and need a lawful basis for it, and
Dimts processes their data only on your instructions as your **processor**.

## What we collect
- Your phone number and account settings.
- Calls you make or receive through your Dimts number: recordings,
  transcripts and AI notes.
- Contacts Dimts creates from those calls (phone number, and a name and
  company taken from the conversation).
- Only if you connect them: limited Google Calendar and Gmail access, used
  to create drafts and events that you approve.
- Security records: an activity log of sign-ins, exports and deletions, and
  a salted hash of the IP address. The raw IP address is not stored.

## Why we use it
- To record calls with a notice to the other person, then transcribe and
  summarize them.
- To suggest next steps for you to approve.
- To keep your account secure.
- To run and improve Dimts: we measure how the service is used from account,
  usage and billing records (sign-ups, numbers of calls and minutes, plans,
  payments), never from what is said on calls.

**Legal bases:**
- **Contract**, for providing the service to you.
- **Legitimate interests**, for security logs and for measuring how the
  service is used.
- For the people you call, **you** choose the basis as controller: usually
  your **legitimate interest** in an accurate record of business calls, or
  their **consent** where local law requires it (Dimts asks every person to
  press 1 on calls to or from Germany, Austria and the Gulf).

We do not sell your data or use it for advertising. We do not train AI models
on your calls, and we do not identify people by their voice. Questions you ask about your calls are answered and then
discarded; we do not store them.
Our transcription and AI providers process call audio and transcripts only to return a result to us and may not use them to train their models. Unless a zero-retention agreement is in place, they may keep them for a limited period (typically up to 30 days) to detect abuse, then delete them.

## Recording notice
Every recorded call begins with: *"This call is recorded and summarized by
Dimts AI."* The other person can end the call if they do not want to be recorded.
Where the law asks for explicit agreement (Germany, Austria and the Gulf
states), both people press 1 before recording starts, and the call is not
recorded if either declines.

## Where your data lives
- **EU:** account data, notes and call audio are stored in Supabase
  (Ireland). The application runs on Vercel in Frankfurt.
- **United States:** calls are connected by Telnyx and transcribed and
  summarized by AI providers that process data in the US. These transfers
  use Standard Contractual Clauses.
- **Outside the EU:** if you live outside the EU (for example in Ethiopia,
  the Gulf or North America), your data is transferred to the EU and the US
  to provide the service.

See the [list of subprocessors](subprocessors.md).

## How long we keep it
For 12 months, unless you choose another period in Settings (3, 6 or 24
months, or until you delete them), after which calls are deleted
automatically. You can delete a
call, a contact or your whole account in Settings. Deleted recordings are
removed from our storage and from our call provider. Encrypted database
backups expire on their own schedule; deleted content in them cannot be read
without keys held outside the database.
Activity-log entries are kept for one year and contain no call content.

## Your rights
- **Access and portability:** Settings → Your data → Download my data.
- **Correction:** edit contact names and notes in the app.
- **Erasure:** delete a call, a contact or your account in the app.
- **People you have called:** they can ask for deletion at
  `dimts.app/privacy-request`. You are notified and must act within 30 days.
- **Complaints:** contact `privacy@dimts.app` or your local data protection authority.

## Security
- Encryption in transit (TLS).
- Call recordings, transcripts, summaries, drafts and contact notes are
  encrypted before they are stored, with a key unique to your account
  (AES-256-GCM). The master keys are kept outside the database, so a copy of
  the database or its backups alone does not reveal any conversation.
  Short structured notes (agreements, next steps) are protected by the
  storage provider's disk encryption only.
- Private storage that only our server can read, per-account access control
  and rate limiting.
- An optional app lock (Face ID, fingerprint or passcode) that also hides
  calls in the app switcher.
- A list of every signed-in device, a warning when a new device signs in,
  and one tap to sign out everywhere.
- A user-visible activity log.
- Staff access: our support tools do not show calls, transcripts, notes or
  contacts. Staff see account, usage and billing details only to help you,
  fix a billing problem or investigate abuse; each time is logged with the
  reason and appears in your activity log.

## Contact
`privacy@dimts.app`
