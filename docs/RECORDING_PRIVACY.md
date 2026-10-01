# Recording retention and deletion

Current MVP policy: call recordings and notes remain until their signed-in owner
deletes the finished call. No automatic age-based purge is implemented. Settings
explains this policy and shows the most recent 100 removal requests.

## User controls

Open a finished call, export any copy you want to keep, then choose **Delete
recording and notes** and **Confirm deletion**. The confirmation describes the
scope before the irreversible request. Active calls cannot be deleted. Pending
or uncertain Google actions must be resolved first so deletion does not hide an
external action that may already have occurred.

The call's transcript, raw transcription response, audio URL, summary, action
suggestions, follow-up drafts and review events are removed from active Dimts
records. Phone/destination/contact links are cleared. Google action snapshots
are cleared; minimal action receipts remain. The call disappears from the normal
history, audio and note exports return not found, and processing ownership is
invalidated. Signed recording callbacks and late startup receipts cannot restore
content; newly learned recording references instead schedule provider removal.

The call detail becomes a removal-status page. The same status is available in
Settings under **Recording privacy**. Refresh or retry provider removal there.
A one-minute cooldown and atomic lease prevent duplicate deletion workers.
Retries check provider state before another removal. A timeout or interrupted
receipt write is not presented as confirmed deletion. Multiple unknown-SID
recordings, ownership mismatch and unfinished provider recordings require
investigation; the service does not guess which resource to delete.

## What remains

- Call ID, owner/account linkage, creation/completion/deletion times, usage and
  budget/idempotency records, consent evidence and provider call/recording
  references remain for accounting, callback suppression and deletion recovery.
- Contact records remain, including names extracted earlier. Deleting this call
  does not delete the separate contact.
- Previously created Google events/Gmail drafts and downloaded/shared copies
  remain in their respective apps or destinations. This control does not revoke
  shared copies or erase already executed external actions.
- Provider records and system backups have their own retention. This feature
  does not claim to wipe old database pages, operator backups, AI-provider logs
  or externally stored recordings. Before deployment, the operator must define
  backup expiry and ensure restoring a backup cannot restore deleted content.
  No deployment backup policy has been verified yet.

## Twilio receipt semantics

The server validates account, parent call and recording SID before removal.
New call reservations retain the original Twilio account. Deletion keeps this
account after scrubbing content. For older calls without an account stamp, the
server can recover it from a canonical, validated Twilio recording URL before
removing that URL. It never assigns today's account to an unknown legacy call.
An account conflict, missing evidence or changed configuration leaves provider
removal unconfirmed and exposes an operator-directed message. Previously
deleted legacy rows without either reference need operator investigation.
No provider request is made when the original account cannot be verified against
the configured account; absence in a different account is not deletion proof.
Only completed recordings are deleted. A follow-up metadata read must show
`deleted` or return not found before the job records confirmation. Already
deleted metadata is a valid receipt and does not cause a second DELETE.

Twilio retains recording metadata for 40 days after deletion. Its support
documentation says removal of the recording file from all systems can take up
to 30 days. Confirmation therefore means the media is unavailable through the
recording API; it is not an instant all-systems erasure claim.
See [Twilio Recording API](https://www.twilio.com/docs/voice/api/recording#delete-a-recording)
and [Twilio recording deletion details](https://help.twilio.com/articles/360002588893).

## Verification

SQL/HTTP and provider-mock tests cover owner/session/confirmation checks, local
scrubbing and hidden history/exports, retained accounting, unrecorded calls,
unresolved external actions, provider uncertainty, retry cooldown and concurrent
claims, deleted metadata, interrupted deletion responses and receipt storage,
late startup/callbacks, changed recording references and stale processing writes.
The initial deletion implementation passed 206 backend tests and TypeScript
and web/Android/iOS bundle checks. The account-association update adds regression
coverage for changed configuration, unverified legacy references and retaining
the legacy account through local scrubbing. See `MVP_STATUS.md` for later checks.
All tests use test data and mocked providers. No real customer recording was
deleted during development. Live provider deletion, rendered UI confirmation,
physical-device behavior and operator backup handling remain release checks.
