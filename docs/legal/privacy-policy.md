# Dimts Privacy Policy

> **DRAFT. Requires review by a qualified lawyer before the EU launch.**
> The app shows this text from `src/legal.ts`. Keep the two in sync.
> Version `2026-10-02` (matches `TERMS_VERSION`).

## Who we are
Dimts is an AI assistant for business phone calls. For your account data,
Dimts is the **controller**. For the people you speak with, **you** are the
controller, and Dimts processes their data on your instructions as your
**processor**.

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

**Legal bases:**
- **Contract**, for providing the service to you.
- **Legitimate interests**, for security logs.
- **Your instructions as controller**, for the people you call.

We do not sell your data or use it for advertising. We do not train AI models
on your calls. Questions you ask about your calls are answered and then
discarded; we do not store them.

## Recording notice
Every recorded call begins with: *"This call is recorded and summarized by
Dimts AI."* The other person can end the call if they do not want to be recorded.

## Where your data lives
- **EU:** account data, notes and call audio are stored in Supabase
  (Ireland). The application runs on Vercel in Frankfurt.
- **United States:** calls are connected by Telnyx and transcribed and
  summarized by AI providers that process data in the US. These transfers
  use Standard Contractual Clauses.

See the [list of subprocessors](subprocessors.md).

## How long we keep it
Until you delete it, or for the period you choose in Settings (3, 6, 12 or
24 months), after which calls are deleted automatically. You can delete a
call, a contact or your whole account in Settings. Deleted recordings are
removed from our storage and from our call provider.
Activity-log entries are kept for one year and contain no call content.

## Your rights
- **Access and portability:** Settings → Your data → Download my data.
- **Correction:** edit contact names and notes in the app.
- **Erasure:** delete a call, a contact or your account in the app.
- **People you have called:** they can ask for deletion at
  `dimts.app/privacy-request`. You are notified and must act within 30 days.
- **Complaints:** contact `privacy@dimts.app` or your local data protection authority.

## Security
- Encryption in transit (TLS) and at rest (AES-256).
- Per-account access control and rate limiting.
- Private storage that only our server can read.
- A user-visible activity log.

## Contact
`privacy@dimts.app`
