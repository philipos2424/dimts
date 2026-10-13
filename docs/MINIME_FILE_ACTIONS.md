# Reviewed file requests through MiniMe

A finished call can contain several requests such as “Send the price list on
Telegram”. On the call screen, **Find file requests** prepares separate cards
with exact transcript quotes. The owner selects a file and Telegram customer
from the linked MiniMe business, edits the caption, reviews the selection and
approves the send. The response shows Telegram's message receipt, not a claim
that the recipient read or downloaded the file.

WhatsApp requests are visible but explicitly unavailable for sending. Automatic
post-call extraction and a cross-call Actions inbox are subsequent work.

## Safety and limitations

- Sending requires a currently linked MiniMe account, the current transcript
  and the reviewed action version. Approval binds the actual file bytes,
  filename, recipient/chat, linked business and caption.
- Recipient matching uses the exact international phone number. If no match
  exists, the caller must message the MiniMe business and share their number.
- Files must be enabled/ready and at most 20 MiB; the initial picker returns the
  most recent 100 documents. The preview URL expires after one minute and is
  not stored in the action record.
- MiniMe uses the business bot identity and one transport attempt. Duplicate
  approvals use the persisted execution ID. Lost responses are reconciled by
  querying MiniMe, never by submitting a new send automatically.
- If Telegram accepted a file but MiniMe crashed before saving the receipt,
  the result remains unresolved and requires operator investigation. This
  system does not promise exactly-once delivery across provider crashes.
- Unresolved sends block deletion and disconnection until checked. Resolved
  action content is included in account export and removed with call/account
  deletion. Dimts action payloads are encrypted with owner/action-bound context.

## Release order

Do not deploy this source before the migrations. Export/deletion reference the
new table even when the feature flag is off.

1. Confirm MiniMe has the original `059_dimts_link.sql` migration. Apply its
   `20261013_dimts_files.sql`, then deploy MiniMe's signed `/api/dimts/files` endpoint.
2. In Dimts, apply `20261008_minime_link.sql` if the original link is absent,
   then `20261013_file_actions.sql` using the established backend role.
3. Configure the existing matching MiniMe/Dimts shared secrets and base URLs,
   plus the normal Dimts encryption key. Deploy Dimts with
   `MINIME_FILE_ACTIONS=1` after the paired endpoint is ready.
4. Run an explicitly authorized real test with an owner-controlled recipient
   and file. Confirm the actual received file and matching Telegram message ID.

With `MINIME_FILE_ACTIONS=1`, legacy automatic Telegram promise sending is
suspended to prevent a parallel text send. Existing legacy receipts remain
visible. The original MiniMe text-send endpoint remains compatible.

## Validation on 13 October 2026

Based on current `caller-mvp@76be3f5`, including the original unmerged MiniMe
connection prerequisite. 531 backend tests passed, plus 10 client, 3 dependency
and 5 reminder tests. TypeScript and the Expo web export passed. No real files
or messages were sent. Dimts production schema inspection was denied by the
Supabase connector, so production migration state is still unverified.
