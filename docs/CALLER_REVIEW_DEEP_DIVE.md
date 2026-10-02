# Dimts: review findings and corrective work

Research and implementation update: 2 October 2026.

The strongest product hypothesis is reliable recall of client commitments,
with evidence a person can check and export. Recording and summarizing alone
do not establish that a call was captured completely, or that a customer will pay.
The immediate priority is capture, retrieval and recovery before more autonomous
actions. This is an inference from qualitative evidence, not a measured ranking.

## Method and limits

This extends [the existing review research](CALL_RECORDING_REVIEW_RESEARCH.md),
which covers thirteen platform-specific recording-app listings plus Notta.
This pass reread selected current Cube ACR and iCall reviews, four Reddit
threads across Android and iOS, and TapeACall's retention/access guidance.
These are selected visible observations, not all reviews or a representative
sample. Searches intentionally included failures, so complaint frequency cannot
be estimated. Historical reports do not establish current-version defects.

Positive experiences, resolved issues and developer explanations are retained.
Repeated comments from one author are one observation. Store pages can show the
same review twice; iCall's duplicated real-estate review is not two customers.
Dates without a displayed year stay without a year. Developer promotions and
unverified legal/device claims in Reddit comments are not independent evidence.
No reviewers were contacted and no private recordings were collected.

## Evidence ledger

| Source | Observed experience | Product implication and limits |
| --- | --- | --- |
| [Cube ACR, Google Play](https://play.google.com/store/apps/details?id=com.catalinagroup.callrecorder) | David Beroff, 13 July 2026, reports successful tests followed by an important missed recording. Stephanie Curley, 2 July 2026, values setup guidance and reports success with speakerphone. The developer says payment does not change capture quality. A separate positive review values post-call keep/delete and backup. | Repeated tests must cover ordinary operating conditions. A paid tier must never imply that unreliable capture becomes reliable. Successful reports also show value in simple retrieval and retention controls. These are reports, not verified device behavior. |
| [iCall, App Store reviews](https://apps.apple.com/us/app/call-recorder-icall/id1447098963?see-all=reviews) | Victor.Lugo, 6 July 2024, reports recordings stopping early and difficulty reaching support, while praising recordings/transcripts when they worked. Stevens Paula5, 25 September, year not displayed, describes reviewing many real-estate calls by name/date and requests tags or notes. | Separate reliability from feature satisfaction. Call IDs should be available for playback, export and AI issues as well as missing recordings. Client-call recall is a segment hypothesis; one positive review does not validate a market or price. Tags/bookmarks remain a gap. |
| [Android: call recorder app needed](https://www.reddit.com/r/androidapps/comments/1sjyx2a/call_recorder_app_needed/) | The original poster repeats a one-sided Cube recording complaint. Replies include reported Bluetooth trouble, successful captures on other phones, and an eventual successful setup. | Dedupe the poster's complaint. Test headset routes and setup comprehension separately. The thread does not establish universal Bluetooth failure or the legality of unannounced recording. Dimts uses server-routed capture; its real headset performance still needs testing. |
| [Android: interview capture](https://www.reddit.com/r/androidapps/comments/1c730lb/need_to_record_a_phone_call_but_nothing_works/) | An interview researcher initially reports silent or one-sided recordings, then edits the post to say a helper setup worked. A separate commenter reports headset trouble but successful capture without it. | Preserve the successful resolution. The job is a playable, transcribable interview, not merely an installed recorder. Test both voices and exports before an important conversation. Do not copy rooting or permission workarounds into our onboarding. |
| [Android: recording cannot play or export](https://www.reddit.com/r/AndroidQuestions/comments/1h3svt5/problem_with_call_recorder_app/) | A 1 December 2024 report describes previously successful use followed by failed playback and sharing through several destinations; copying files to a computer yielded no audible sound. Support had not replied. | A file's presence and an export button are insufficient. Open the saved audio outside Dimts. A silent source cannot be repaired by downloading or summarizing it. The poster's proposed technical explanation is unverified. |
| [iOS: inaccessible audio/transcript](https://www.reddit.com/r/ios/comments/1fuq98p/call_recording_cant_access_audio_or_transcript/) | A reporter's 2 October 2024 post describes an hour-long recording that appears in Notes but will not open. Replies include similar failures and a separate report of good audio despite missing transcription. | Display capture, playback and AI stages separately. Preserve usable audio when AI fails. This concerns historical iOS behavior and does not prove current Apple call recording is unreliable. |
| [TapeACall subscription access guidance](https://support.tapeacall.com/hc/en-us/articles/38733299123860-Will-I-lose-my-recordings-if-I-cancel-my-subscription) | Official guidance dated 25 June 2025 says access ends after subscription expiry, may be restored by resubscribing subject to retention, and recommends backups. Account deletion permanently removes recordings. | This is provider policy, not a customer complaint. Dimts should explain retention and make portability easy before offering subscriptions. Expiry does not necessarily mean immediate deletion. Dimts currently has no implemented subscription entitlement policy. |

## Fixes and protections mapped to the evidence

| Priority / failure | Dimts response | Verification and remaining limits |
| --- | --- | --- |
| P0: silent, one-sided or missed audio looks successful | Existing dual-channel server capture, guarded audio/transcription processing, missing-receipt timeout and recovery. | SQL/provider-mock checks cover state and recovery. Actual beginning/middle/end audibility, headset routes and background/locked phones remain unverified. Dual channels are not proof of intelligible speech. |
| P0: summary failure destroys the useful original | Existing checkpointed transcription, stage retry and authenticated audio/text export. | Automated recovery and retry checks pass. A real downloaded MP3/text file must be opened on each platform. No claim that missing source audio is recoverable. |
| P0: confusing signup or call rejection | **Changed this pass:** known error codes become actionable messages; arbitrary server/provider bodies and raw HTTP JSON are never shown. English dialer errors now expose those next steps while preserving HTTP status and the request key behavior. | Five tests exercise the actual client module, including timeouts, invalid codes, rate limits, non-JSON/secret-bearing server errors and rejection status. Detailed new messages are English; the dialer retains its existing translated fallback in Amharic. |
| P1: support cannot identify playback/export/AI failures | **Changed this pass:** selectable call ID appears on every nondeleted call detail, including calls whose notes are ready. | TypeScript and platform exports validate the change. This supplies an identifier, not a staffed support operation. A real support contact and response expectations still need implementation. |
| P1: excessive acceptance friction | **Changed this pass:** operator-configured owner-only mode asks the account owner in either direction and announces recording to the other participant, without asking that participant to press a button. Default remains all-party. | Real-SQL and HTTP/provider-mock tests cover both directions, notice-before-start, wrong-leg rejection, refusal/timeout, replay and recovery. No live owner-only call is claimed. Legal scope must be reviewed before enabling. |
| P1: different consent checks disagree during recovery | **Changed this pass:** one policy predicate drives atomic recording start/receipt/recovery and the API's authorization flag; UI no longer assumes two timestamps imply every policy. | Exhaustive combinations compare JavaScript authorization with real SQL. New call reservations snapshot mode/scope; retry retains the original policy. No fictitious timestamp is written for the non-owner. |
| Before charging: surprise renewals, AI upsells or lost access | Existing usage caps and exports. Proposed simple monthly allowance with stated telecom, storage and AI limits. | Billing, cancellation, restore purchase, retained-file access entitlements and customer willingness to pay are **not implemented or validated**. Review prices are not current pricing evidence. |
| Later: hard to find an important moment | Existing timed transcript navigation and evidence-backed editable follow-up proposals. | Real timestamp accuracy and Google receipts remain unverified. Tags, bookmarks, personal call annotations and unsaved-edit preservation are still product gaps. |

## Owner-only policy and worldwide use

The user means the **Dimts account owner**, whether making or receiving a call.
Outbound: ask the owner, play the other participant a notice, then start capture
after Twilio requests the post-notice callback. Inbound: play the incoming caller
a notice before dialling, then ask the owner on the answered mobile leg.
Decline or silence at the owner's prompt connects without recording or AI notes.

The outbound notice uses `Say` followed by an empty one-second `Gather` with
`actionOnEmptyResult`, not `Redirect`: [Twilio's Number documentation](https://www.twilio.com/docs/voice/twiml/number)
restricts the pre-connection verbs. This passive timeout asks for no agreement
and saves no external-party consent. Carrier execution still needs a live test.

Configuration is server-only: `RECORDING_CONSENT_MODE=owner_only` requires a
nonempty `RECORDING_OWNER_ONLY_APPROVED_SCOPE`. This scope is an operator audit
record, **not** geolocation, enforcement, or legal certification. Do not use it
as a global permission switch. A general deployment with participants anywhere
keeps `all_parties`; ordinary users cannot change the server policy per call.
The notice timestamp records issuance, not consent or proof it was heard.

Owner-only acceptance cannot be promised for every country/state. For example,
[California Penal Code §632.7](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=632.7.)
requires all parties' consent for the covered cellular/telephone communications.
An announcement is not universally a substitute for consent. Number prefixes
do not establish where participants physically are. No worldwide legal survey
or Ethiopian jurisdiction assessment has been completed here. Other privacy,
transcription and storage requirements also remain jurisdiction-specific.

## Market validation before expanding features

Start with one customer group: independent consultants or small service-business
owners who repeatedly discuss quotes, appointments and commitments with clients.
Keep interviews/reporting as an adjacent need, not a second simultaneous launch.
The promise to test: after a call, find what was agreed and prepare the next step
without taking notes during the conversation. The original audio stays usable
when AI fails; proposed actions require review.

Recruit ten people in one reviewed geography. Ask about their last actual missed
commitment, current workaround, call frequency and cost of the problem. Have them
use the routed pilot on routine, consenting conversations for two weeks. Track
routing, capture, playback, transcript, summary and action outcomes separately;
measure repeat use and correction burden rather than generated-summary counts.
Record reliability per tested carrier/phone combination, not a worldwide claim.

Only after successful capture and export, offer a concrete paid pilot with stated
minutes/AI/storage and collect actual purchases or explicit purchase commitments.
Compare against their current phone's built-in features. Review enthusiasm or
free signups alone do not establish willingness to pay. Use
[the pilot checklist](CALLER_REVIEW_VALIDATION.md) for physical acceptance; no
scenario is marked passed merely because unit tests or bundle exports succeeded.
