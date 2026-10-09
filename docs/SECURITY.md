# Security: how call data is protected

Written for the Dimts operator and anyone reviewing the system. Last updated
2026-10-06 (branch `security-hardening`).

## Threats and what answers each

| Threat | Protection |
|---|---|
| Database dump, leaked DB password, stolen backup, storage-provider staff | Call content and audio are encrypted before storage with per-user keys; master keys live only in the server environment |
| Someone else signs in with the owner's number (SIM swap, recycled number) | Signed-in devices list, push warning to other devices on every new sign-in, sign out one / others / everywhere |
| Someone holds the owner's unlocked phone | Optional app lock (Face ID, fingerprint, passcode); app-switcher cover |
| Another Dimts user | Every query is scoped by the session's user; ciphertext is bound to its owner, so a copied value cannot be opened as anyone else's |
| Tampered stored data | AES-GCM authentication: altered, truncated, reordered or moved content fails to open instead of being shown |
| AI providers keeping data | OpenAI/ElevenLabs API data is not used for training. Zero retention needs an agreement with each provider; `ELEVENLABS_ZERO_RETENTION=true` once ElevenLabs grants it |
| Spoofed client IPs evading sign-in limits | `trust proxy 1`; `proxy-addr` patched to 2.0.8 |

## Encryption at rest

- **Sealed columns:** `calls.transcript`, `calls.transcript_data`,
  `calls.summary`, `calls.recap`, `calls.followups`, `contacts.notes`, and
  the Gmail/Calendar draft snapshots `email_actions.email` and
  `calendar_actions.meeting`.
- **Not sealed (yet):** the short structured notes `agreements`,
  `action_items`, `next_moves` and `key_points`. Today, briefing and promise
  queries read them inside SQL. Contact names and phone numbers are also
  unsealed, because calls are routed by them.
- **Format:** `dmt1.<key id>.<table:column>.<user id>.<row id>.<payload>`,
  AES-256-GCM. Everything before the payload is the AAD.
- **Per-user key:** `HKDF-SHA256(master, "dimts-user-data-v1", user id)`.
- **Where decryption happens:** [server/db/pool.js](../server/db/pool.js)
  opens sealed values in every query result. Route code sees plaintext.
  Writes seal explicitly (`sealText` / `sealJson` in
  [server/lib/field-crypto.js](../server/lib/field-crypto.js)).
- **Audio:** new recordings are stored as `<user>/<call>.enc`.
  - Layout: a 12-byte header, then 64 KiB chunks, each
    `iv | ciphertext | tag`.
  - Each chunk is bound to its object key, its position and the chunk count.
  - Range requests decrypt only the chunks they cover, so the player can still
    seek.
  - Older `.mp3` objects keep working until they are migrated.
- **Search:** Ask ranks the owner's 300 most recent calls on the server. The
  database full-text index was dropped, because it kept every word in
  readable form.
- **Fail closed:** without `DATA_ENCRYPTION_KEYS`, Vercel production refuses
  to write call content (`VERCEL_ENV=production`), and `validateDeployment`
  refuses to start elsewhere.

### Keys

- `DATA_ENCRYPTION_KEYS="k2:<base64>,k1:<base64>"`. The first key encrypts;
  every listed key can still decrypt.
- **Generate:**
  `node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"`.
- **Store:** Vercel env (Production only) **and** a password-manager entry.
  Never store the key in the database, in git or in chat. Losing every copy
  makes the data it sealed unreadable.
- **Rotate:**
  1. Prepend a new key.
  2. Deploy.
  3. Run `node --env-file=../.env scripts/encrypt-existing.js` until it
     reports 0.
  4. Remove the old key.

### Going live (in order)

1. Generate `DATA_ENCRYPTION_KEYS` and a 32+ character `AUDIT_SALT`. Set both
   in Vercel Production and save the key in the password manager.
2. Apply [server/db/migrations/20261006_security_hardening.sql](../server/db/migrations/20261006_security_hardening.sql)
   to the production database.
3. Deploy.
4. With production env values locally:
   1. Run `scripts/encrypt-existing.js --dry-run`.
   2. Run it without `--dry-run`, repeating until nothing is left. It also
      moves plain `.mp3` recordings to encrypted `.enc` objects, verifies each
      copy and removes the plain one.
5. Ship a new app build (EAS). The lock needs `expo-local-authentication`,
   which is a native module, so an over-the-air update won't carry it.

### Backups

Supabase backups contain the database as it was, so they also hold rows that
were deleted later. Those rows are sealed, and the keys are not in the backup.
Rows written before step 4 above remain readable in backups taken before the
migration, until those backups expire. Check the backup retention period of
the project's plan, record it here, and state it in the privacy policy.

## Founder-account checklist (no code; highest real-world risk)

Every one of these accounts can read or redirect customer calls:

- Supabase, Vercel, Telnyx, ElevenLabs, OpenAI/Ollama, Polar, Expo and GitHub,
  plus the email accounts behind them.

For each:

- [ ] Two-factor login with an authenticator app or security key, never SMS.
- [ ] Recovery codes saved in the password manager.
- [ ] API keys limited to what the server needs; delete unused ones (old
      Twilio, the second Telnyx account).
- [ ] Remove `SKIP_TWILIO_SIGNATURE_CHECK` from Vercel.
- [ ] Ask OpenAI and ElevenLabs for zero data retention, then set
      `ELEVENLABS_ZERO_RETENTION=true`.

## Breach response runbook

1. **Contain (first hour).**
   - Rotate whichever credentials could be involved: database password,
     Supabase secret key, carrier and AI keys.
   - Revoke every session: `DELETE FROM sessions;`.
   - If `DATA_ENCRYPTION_KEYS` may have leaked, add a new first key, deploy and
     run `encrypt-existing.js`.
2. **Assess.**
   - Work out what was reachable, for whom and when. Sources: Supabase logs,
     Vercel logs, and the `audit_events` table.
   - Sealed columns are safe unless the keys leaked too.
3. **Notify.**
   - EU/UK: the supervisory authority within 72 hours of becoming aware
     (GDPR Art. 33).
   - Affected users without undue delay when the risk to them is high
     (Art. 34).
   - Business customers (we are their processor) without undue delay.
   - US states and Canada have their own breach-notification rules; check each
     affected user's location.
4. **Record** what happened, the decisions made and the fixes, even if no
   notification was required.
