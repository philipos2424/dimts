# Call recording reviews → Dimts product decisions

Research date: 1 October 2026. Audience: US first; international availability
must be validated separately for routing, language, carrier and pricing.

## Scope and confidence

This is a qualitative sample of publicly visible App Store and Google Play
reviews across seven call-recording apps and one adjacent transcription app.
It is not every app, every review, a random sample, or a measured failure rate.
Searches included failure-related terms, so this sample intentionally surfaces
problems and cannot establish how often they happen. Positive reviews were also
read to identify what users value. Store pages repeat the same review and vary
by locale/cache; duplicates are not independent evidence.

Dates below are the dates printed by the store. Where Apple omits the year,
the year is not inferred. Older reviews identify historical failure modes,
not proof that today's version still has the same bug. Complaints are user
reports, not independently reproduced defects. Developer responses and feature
descriptions are distinguished from reviews. No unsupported accusations of
fraud, surveillance or illegality are accepted as facts.

## Evidence sample

| App and source | Selected review evidence | Lesson for Dimts |
| --- | --- | --- |
| [TapeACall — App Store](https://apps.apple.com/us/app/tapeacall-call-recorder/id573751328) | justsomehumblefeedback, 16 June 2020: recordings shared with clients were valuable; iOS changes sometimes disrupted recording. Bellacuda, 6 June 2018: conference-bridge buzzing and difficulty finding support. The current developer listing separately states a three-way-calling requirement. | Preserve access and export; test after OS updates; explain supported call routes. These historical complaints do not establish current defects. |
| [iCall — App Store reviews](https://apps.apple.com/us/app/call-recorder-icall/id1447098963?see-all=reviews) | jmiff348, 2 September 2023: manual call merging delayed capture and playback seeking failed. Georgelynne, 27 June 2024, and Victor.Lugo, 6 July 2024: recordings stopped early, downloads failed and support was hard to reach. | Do not advertise effortless recording of every phone call. Show actual recording state, preserve partial audio, make playback navigable and provide a real recovery route. |
| [Cube ACR — Google Play](https://play.google.com/store/apps/details?id=com.catalinagroup.callrecorder) | J Ostvalde, 6 May 2026: discovered important calls contained only their own voice. Sasmit Chatterjee, 1 June 2024: recordings stopped without notification. Parash Deka, 2 September 2021: repeated connector configuration and missing caller identification. The listing itself suggests audio-source changes or speaker mode if only one voice is captured. | Validate both audio channels before trust is established. A recording request or elapsed timer is not proof of usable audio. Display exact caller number and distinguish configuration from successful capture. |
| [ACR Phone — Google Play](https://play.google.com/store/apps/details?hl=en-US&id=com.nll.cb) | Matthew “Matt S”, 2 July 2026: disliked losing automatic spam blocking. Quang, 20 October 2024: another incoming call erased notes being written; the developer said a fix would follow. The listing separately warns that Android 10+ recordings can be silent, excluding SIP/older versions. | Do not replace a user's trusted dialer without proving the whole experience. Save edits durably and test interruptions; disclose supported routing before signup. |
| [Talker ACR — Google Play](https://play.google.com/store/apps/details/Call_Recorder_Talker_ACR?hl=en&id=com.talker.acr) | Neil Buck, 8 April 2024: Bluetooth use broke recording. A M, 27 January 2022: valued recovery after the phone died, but car Bluetooth captured one side. Simply, Nikki J, 10 February 2024: recordings played silence and caller identity became unknown. | Test handset, speaker, earbuds and car Bluetooth separately. Keep partial recordings. Avoid inferring recording success from file existence alone. These are historical reports. |
| [Call Recorder – Auto Recording, m24apps — Google Play](https://play.google.com/store/apps/details?id=com.m24apps.acr) | BAS BASS, 30 April 2022: important calls were missing and uncertainty about migrating old recordings made switching difficult. | Recordings belong to the user: provide export and a clear retention policy. Historical evidence supports testing portability, not a current failure-rate claim. |
| [Automatic Call Recorder – ACR, Vastor — Google Play](https://play.google.com/store/apps/details?id=com.call.recorder.automatic.recording) | Noel Ndebele, 19 March 2026: could not record incoming or outgoing calls. Lipi Raha, 21 February 2026: no sound. Abrar Hussain, 12 May 2026: ads worked while recording did not. | Prove the essential function with a guided test before asking someone to pay. Avoid interruptions during important calls. |
| [Notta — App Store reviews](https://apps.apple.com/us/app/notta-transcribe-voice-to-text/id1480649572?see-all=reviews) — adjacent transcription product | aeli1980, 1 April, year not shown: interrupted multi-speaker recordings. pengufen, 27 December 2025: surprised by per-recording limits and an export paywall. Sidequestgremlin, 27 May 2025: speaker identification and troubleshooting problems. M3OW MFS, 7 August, year not shown: valued focusing on interviews and structured summaries. | Explain limits before capture, preserve audio independently of AI success, label speakers and offer useful summaries. Do not market this adjacent product as a direct phone-call recorder. |

## What this means for the business

My inference: the strongest initial proposition is reliable memory and reviewed
follow-through for people who frequently speak with clients. An independent
consultant or service-business owner is a better starting hypothesis than
everyone who owns a phone. The reviews support a need for reliable capture and
retrieval; they do not prove demand for autonomous calendar/contact/email actions
or a specific subscription price.

First promise to test: “After a client call, check what was agreed and prepare
the next step without writing notes during the conversation.” Keep the original
audio available when AI fails. Show proposals as editable drafts with supporting
transcript evidence. Never turn an uncertain name, date or commitment into a
confident external action.

## Changes made and existing protections

| Failure mode | Dimts response | Current evidence / remaining limit |
| --- | --- | --- |
| Unsupported expectations | Onboarding now explains that only calls routed through Dimts or initiated here are captured; ordinary handset/WhatsApp calls are not automatically captured. | Included in successful web export; physical-device comprehension still needs testing. |
| Consent choices misleading | Dial starts unrecorded. Provider recording starts only after both saved agreements. Decline/no response connects without recording. | SQL/HTTP/provider-mock tests; carrier timing still needs a real call. |
| False “recording active” | In-call label requires both agreements and a confirmed provider startup response; uncertain startup is shown separately. | Code and TypeScript checked. A startup receipt still does not establish complete, audible capture. |
| Missing audio spins forever | Newly completed calls record completion time. After ten minutes without audio, authenticated list/detail reads surface a failure and call ID. Refresh checks for delayed audio; a valid later callback clears the error and resumes processing. | SQL isolation/long-call tests and callback recovery test. This does not retrieve lost audio or automatically poll Twilio. Legacy rows without completion time are excluded. |
| Wrong speaker/unsafe AI actions | Existing chronological stereo transcript handling, evidence-backed proposals, explicit review, immutable action snapshots and uncertain-result reconciliation. | Automated tests exist; real audio accents, interruptions, dates and live Google actions remain unverified. |
| Surprise repeated charges | Existing call reservations, request idempotency, duration caps and shared usage ceilings. | Automated tests exist. These are backend limits, not a complete customer pricing/subscription/cancellation experience. |

## Prioritized remaining improvements

1. **Capture confidence before payment.** Guided two-person test: both play back
   and confirm their voices; test each supported carrier/device/audio route.
   Add missing/silent-channel detection that flags uncertainty instead of
   manufacturing a transcript. Start with routed telephone calls only.
   The local Whisper worker now checks decoded channel signal using 200 ms
   windows and a conservative near-silence floor. Silent channels skip model
   inference. The pipeline preserves partial text/audio but withholds new AI
   notes and identification for silent, mono or one-sided signal and incomplete
   channel transcripts. Follow-up generation requires ready status both before
   spending and when saving. Decoded waveform, worker HTTP and SQL tests cover
   these outcomes. Signal presence does not prove speech, clarity or complete
   capture; a quiet participant may trigger the warning. Legacy single-channel
   provider transcripts have no waveform assessment. Physical call validation
   and rollout to the running worker remain required.
2. **Recover and preserve.** Read-only provider recovery is now implemented for
   finished calls with both agreements. It fetches a known SID directly or
   searches the parent call, verifies account/call ownership and accepts one
   completed, nonempty dual-channel receipt. Atomic cooldown/storage guards
   prevent concurrent duplicate recovery; tests cover a callback winning the
   race, database failure, provider error and missing/ambiguous results. No new
   recording or phone call is created. Live provider recovery is still unverified,
   and metadata does not prove both people are audible. Remaining: partial audio,
   physical-device export checks, retention/deletion including provider copies,
   and restore checks. Never require reinstalling to troubleshoot access.
   Owner-confirmed deletion is now implemented, including local content removal,
   provider removal receipts, retry/cooldown and a Settings history. Tombstones
   retain accounting/consent/provider references; contacts, external Google
   actions and exported copies remain. Late callbacks and startup receipts
   schedule removal rather than restoring notes. SQL/HTTP/provider-mock tests
   cover races and interrupted receipts. Retention is until owner deletion;
   automatic expiry, live removal, rendered UI and backup handling remain
   unverified. See `RECORDING_PRIVACY.md` for the exact scope and provider limits.
   Processing now also checkpoints the transcript before asking for a summary.
   A failed summary can resume without paying for another transcription of the
   same recording. Leases renew between stages; expired jobs become visible
   retryable failures, and stale workers cannot overwrite newer notes or identify
   contacts after losing their final write. SQL/HTTP tests cover these cases.
   Legacy queued jobs receive a fresh observation deadline instead of timing out
   based on when the call began. Real interruption tests remain unverified.
3. **Accessible playback.** The player now has 15-second skip controls, explicit
   replay, loading/failure feedback and reload. Browser audio is fetched with
   bearer authentication into a private blob; the blob URL is revoked on unmount.
   Native streaming keeps bearer headers; the server preserves validated partial
   responses for seeking and handles stream interruptions. HTTP tests cover
   unauthorized access, provider absence and interrupted-stream recovery.
   Call detail now also exposes text-note and MP3 export. Web downloads the
   authenticated bytes; native writes temporary cache files and opens the OS
   file-sharing sheet. Notes preserve speaker text, mark AI suggestions and
   omit provider metadata. Export isolation/expiry/incomplete-call HTTP tests
   pass. Native temporary files are pruned on the next export after one hour;
   external saved/shared copies remain under the user's control.
   Still verify actual rendered playback, downloaded files and native share
   sheets on iPhone/Android, and add transcript timestamps.
4. **Clear cost and account ownership.** Show the actual included minutes,
   per-call limits, overage behavior, trial end and renewal cost before charging.
   Bind purchases to the signed-in account; expose cancellation and restore.
   No billing integration is claimed complete.
5. **Useful help.** A reachable support route, call ID, sanitized diagnostics
   and clear recovery steps. Never include recordings, transcripts or credentials
   in diagnostic exports by default. The current call ID aids operator support;
   it is not a staffed support service.
6. **Trusted follow-through.** Correct transcript/name/date errors, retain user
   edits through interruptions, and let users inspect the sentence behind a
   suggested action. Real OAuth and carrier tests remain release requirements.

## Validation before a broad launch

These are proposed gates, not achieved metrics:

- Interview 10–15 US consultants/service-business owners about their last
  missed detail, present workaround, call volume and actual consequences.
  Observe a workflow; avoid asking only whether they “like the idea.”
- Run a consent-based pilot with about 10 people and at least 100 deliberately
  varied routed calls: inbound/outbound, both decline/timeout paths, earbuds,
  Bluetooth, long calls, busy/no-answer, app closed and delayed callbacks.
  Report capture failures separately from transcription/action failures.
- Require no silent capture failures in that test: every missing recording must
  have a visible outcome and investigation path. One hundred calls cannot prove
  reliability at scale; continue monitoring after launch.
- Independently inspect whether names, numbers, commitments and times are
  correct. No unreviewed external actions. Preserve original audio and show
  uncertainty when only one party is audible.
- Test two explicit paid offers only after the first successful call. Example
  hypotheses: $15 and $25 per month with plainly stated included usage; first
  calculate telecom, transcription, model, storage and support cost. These are
  experiments, not a proven price or approved launch plan.
- Measure actual purchase/renewal, weekly repeated use, recordings retrieved,
  accepted/corrected suggestions and support burden. If people will not pay,
  learn which outcome was not valuable before adding more features.
- Expand to another country only after separate carrier, audio/language,
  customer-demand and cost tests. US reviews do not validate international fit.

## Release check for the current recording changes

Automated: 167 server tests passed; TypeScript check and Expo web export passed.
Includes completion-based audio expiry, owner isolation and late callback recovery.

Still unverified: live recording startup during the second-party whisper,
full two-channel audibility, provider callback timing and real phone UI states.
Test both callers accepting; each declining; each timing out; disabled recording;
definite startup refusal; uncertain startup; callback replay; wrong SID; delayed
audio; and a long call whose recording arrives within ten minutes of completion.
These code changes do not establish a complete or deployed caller MVP.
