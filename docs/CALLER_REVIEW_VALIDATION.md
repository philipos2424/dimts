# Caller pilot: tests derived from recording-app reviews

Prepared 1 October 2026. No live tests are marked passed in this document.
See [review evidence](CALL_RECORDING_REVIEW_RESEARCH.md) for sources and limits,
and [MVP status](MVP_STATUS.md) for implementation status.

## First milestone

In the app, choose **Open the first-call guide** from Recents or Settings.
The guide links to actual call results and recovery, and does not automatically
label a test as passed or initiate a call. The checks below still require real
participants and inspected audio on installed apps.

A new user routes a two-person call through Dimts, both participants agree to
recording, both voices can be played back, and a useful summary plus editable
next step is produced. The user can export their recording. Test this on both
an installed iPhone app and an installed Android app; a browser bundle or mock
provider response cannot substitute for either result.

Use consenting pilot participants and synthetic business details. Keep phone
numbers, names, audio, transcripts, provider credentials and session tokens out
of the results log. A random call ID is sufficient for investigation. Do not use
Dimts for emergency or irreplaceable conversations during this pilot.

## Test cases

Run applicable cases in both directions and on both platforms. Record exact
phone/OS/app versions, country, carrier, audio route and foreground/background
state. Repeat representative cases after an OS/app update and phone reboot.
Country/carrier results are scoped to that tested combination.

| ID | Scenario | Expected observable result |
| --- | --- | --- |
| R01 | New user follows onboarding and makes a two-person test call. | Understands routing, connects successfully, both agree; listens to both voices at the beginning, middle and end. |
| R02 | Each participant separately declines, then separately times out. | Call may connect unrecorded; no audio capture or AI notes are presented as recorded. Inspect provider records as well as UI. |
| R03 | Routed incoming call while app is open, backgrounded, locked and closed. | Routing remains functional; notification state is truthful and a tap opens only the signed-in owner's call. No claim of OS-native ringing without implementation. |
| R04 | Repeat with handset, speaker, earbuds and car Bluetooth. | Both voices remain intelligible; a file or two-channel metadata alone does not count as success. |
| R05 | Take another call or switch apps while editing a contact/proposal. | Saved edits survive; unsaved edits are preserved or their loss is clearly disclosed. No action uses stale edits. |
| R06 | First participant hangs up; repeat with second participant; include voicemail/busy/no-answer. | Provider legs and recording stop appropriately, final state settles and accounting reflects the actual outcome. |
| R07 | Long call reaches the configured duration limit. | Call ends at the allowed limit; partial/full available audio remains accessible, with any cutoff disclosed. |
| R08 | Delay the recording callback; replay it; lose the first callback. | No duplicate processing; missing audio becomes visible after the documented deadline; valid delayed/recovered audio can resume processing. |
| R09 | Supply silent, mono or one-sided test audio to the processing pipeline. | Visible uncertainty, saved available audio/text and no confident new AI notes from incomplete input. A quiet participant is not falsely declared absent. |
| R10 | Fail AI summary after transcription; retry; interrupt processing. | Audio/text remain; unchanged cached transcription is reused; stale workers do not overwrite newer output. |
| R11 | Seek backward/forward, replay, interrupt network and retry playback. | Audible playback at expected positions; recoverable errors and no permanent spinner. |
| R12 | Export MP3 and text on each platform; open the saved files outside Dimts. | Usable audio/UTF-8 notes; no provider secrets. Sharing is deliberate and temporary native files follow the documented policy. |
| R13 | Log out, change device, sign back in; then sign into another account. | Correct owner retains access; other owner cannot play/export or access old alerts/actions. |
| R14 | Conversation contains a corrected name, ambiguous “tomorrow,” rescheduled meeting and rejected email proposal. | User can inspect evidence, correct/reject drafts; no unwanted event/email is created. A Gmail draft is not a sent email. |
| R15 | Delete a call; interrupt provider removal; deliver a late callback. | Local content disappears, provider uncertainty stays visible, retry reconciles, and late events never resurrect content. Inspect provider account ownership before accepting absence. |
| R16 | Restore a backup containing a deleted call in an isolated environment. | Deletion records prevent resurrection before restored content becomes accessible. This policy/operation remains a release gap. |
| R17 | Repeatedly tap call/retry, then exhaust usage. | No duplicate paid calls or blind recording restarts; clear limit/error and consistent usage. |
| R18 | User attempts unsupported ordinary handset/WhatsApp recording. | Product states the limitation clearly; never implies recording occurred. |
| R19 | Before any paid offer, explain price and cancellation without coaching. | User can state interval, total charge, included telecom/AI usage, overage behavior and cancellation path. Billing must exist before testing a real subscription. |
| R20 | User cannot find a recording and requests help. | Can locate recovery/export and the actual support route; diagnostics omit content/secrets unless separately chosen. |

## Recording outcomes

Use one row per attempted scenario in a CSV or spreadsheet:

```csv
run_id,test_id,date_utc,platform,device_model,os_version,app_version,country,carrier,audio_route,app_state,direction,call_id,routing_outcome,capture_outcome,transcription_outcome,summary_outcome,action_outcome,playback_outcome,export_outcome,recovery_outcome,notes
```

For each stage use `pass`, `fail`, `unknown` or `not_applicable`. Unknown is not
a pass. Include only sanitized observations in notes. Keep any participant
feedback/contact details in a separate access-controlled research record.

Calculate separate results for routing, recording, transcription, summarization
and reviewed action execution. Recording success requires inspected intelligible
audio from both participants for the intended recorded interval. Count unrecorded
decline/timeout cases separately, not as failed recording attempts or successful
captures. Report counts and denominators, not one overall percentage that hides
failures. Report retry recovery separately from first-attempt success.

Proposed initial pilot: about 10 people and at least 100 deliberately varied
calls. This is a proposed sample, not statistical proof or an achieved result.
Investigate every silent failure, incorrect external action and cross-account
exposure before expanding. Describe supported combinations from observed tests.

## Learning whether the outcome is worth paying for

Interview 10–15 US consultants or service-business owners about their last
missed client-call detail, current workaround, time spent and consequence.
Observe them finding an agreement and preparing a follow-up from an actual
permitted example. Compare against their phone's built-in recording features.

After a successful guided call, measure whether they return during a week of
normal work, retrieve saved calls and accept/correct the proposed next steps.
Test a plainly priced paid pilot only after calculating telecom, transcription,
AI, storage and support cost. Example $15/$25 monthly offers from the research
document remain hypotheses, not configured subscriptions. Track actual purchase
and renewal separately from stated enthusiasm. Keep audio export accessible
under the disclosed retention policy if a user stops paying.

## Further review collection

Do not describe this study as all recording apps or all reviews. For a broader
manual pass, choose a documented mix of iOS/Android, call-bridge/on-device and
AI-assisted products, verified by app ID and developer. Record country/store,
retrieval date, review date, rating and whether a developer responded.

Where stores permit sorting, sample recent reviews across ratings before adding
failure-specific searches. Keep duplicate reviews, locale copies and updated
reviews as one observation; preserve updates that say an issue was resolved.
Separate customer reports, listing promises and reproduced Dimts defects.
Revisit the study after meaningful pilot results or platform changes; no
scheduled monitoring or automatic store scraping has been configured.
