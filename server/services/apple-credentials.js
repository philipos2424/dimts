import { randomUUID } from 'node:crypto';
import * as database from '../db/pool.js';
import { HttpError } from '../lib/users.js';
import { openAppleToken, sealAppleToken } from '../lib/social-secrets.js';
import { revokeAppleToken, subjectHash } from './social-signin.js';

// One current refresh token per Apple grant. Pending sign-ups expire; linked
// grants stay encrypted until removal. The row survives local account erasure
// only while revocation is pending and is erased after Apple acknowledges it.
export async function rememberAppleCredential(identity) {
  const hash = subjectHash('apple', identity.subject);
  await database.withTransaction(async tx => {
    // Serialize with provider notifications, including when no credential row exists yet.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`apple:${hash}`]);
    const { rows: [row] } = await tx.query(`INSERT INTO apple_signin_credentials(subject_hash,encrypted_token,authorized_at,revoke_after)
      SELECT $1,$2,to_timestamp($3),CASE WHEN EXISTS(SELECT 1 FROM user_identities WHERE provider='apple' AND subject_hash=$1)
        THEN NULL ELSE now()+interval '40 minutes' END
      WHERE NOT EXISTS(SELECT 1 FROM apple_signin_events WHERE subject_hash=$1 AND event_time>=to_timestamp($3))
      ON CONFLICT(subject_hash) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,authorized_at=EXCLUDED.authorized_at,
        revoke_after=CASE WHEN apple_signin_credentials.revoke_after IS NULL THEN NULL ELSE EXCLUDED.revoke_after END
      WHERE (apple_signin_credentials.revoke_after IS NULL OR apple_signin_credentials.revoke_after>now())
        AND apple_signin_credentials.lease_id IS NULL RETURNING subject_hash`,
    [hash, sealAppleToken(identity.refreshToken, hash), identity.authorizedAt]);
    if (!row) throw new HttpError(409, 'apple_revocation_pending', 'Apple disconnection is still finishing. Start a fresh sign-in shortly.');
  });
}

export async function bindAppleCredential(tx, hash) {
  const { rows } = await tx.query(`UPDATE apple_signin_credentials SET revoke_after=NULL
    WHERE subject_hash=$1 AND (revoke_after IS NULL OR revoke_after>now()) AND lease_id IS NULL RETURNING subject_hash`, [hash]);
  if (!rows.length) throw new HttpError(400, 'expired_social_request');
}

export async function queueAppleRevocation(tx, userId) {
  await tx.query(`UPDATE apple_signin_credentials SET revoke_after=now(),next_attempt_at=now()
    WHERE subject_hash IN (SELECT subject_hash FROM user_identities WHERE provider='apple' AND user_id=$1)`, [userId]);
  await tx.query(`DELETE FROM social_signin_requests WHERE provider='apple' AND subject_hash IN
    (SELECT subject_hash FROM user_identities WHERE provider='apple' AND user_id=$1)`, [userId]);
}

export async function retryAppleRevocations({ limit = 5 } = {}) {
  let revoked = 0, pending = 0;
  await database.query("DELETE FROM apple_signin_events WHERE received_at<now()-interval '30 days'");
  for (let n = 0; n < limit; n++) {
    const lease = randomUUID();
    const row = await database.queryOne(`UPDATE apple_signin_credentials SET lease_id=$1,lease_until=now()+interval '2 minutes'
      WHERE subject_hash=(SELECT subject_hash FROM apple_signin_credentials
        WHERE revoke_after<=now() AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now())
        ORDER BY revoke_after LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [lease]);
    if (!row) break;
    try {
      await revokeAppleToken(openAppleToken(row.encrypted_token, row.subject_hash));
      await database.query('DELETE FROM apple_signin_credentials WHERE subject_hash=$1 AND lease_id=$2', [row.subject_hash, lease]);
      revoked++;
    } catch {
      await database.query(`UPDATE apple_signin_credentials SET attempts=attempts+1,lease_id=NULL,lease_until=NULL,
        next_attempt_at=now()+interval '5 minutes' WHERE subject_hash=$1 AND lease_id=$2`, [row.subject_hash, lease]);
      pending++;
      console.error('[apple-signin] Revocation pending; scheduled for retry.');
    }
  }
  return { revoked, pending };
}

export async function handleAppleRevocation(event) {
  if (!['consent-revoked', 'account-deleted', 'account-delete'].includes(event.type)) return;
  const hash = subjectHash('apple', event.sub);
  await database.withTransaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`apple:${hash}`]);
    const { rows: accepted } = await tx.query(`INSERT INTO apple_signin_events(notification_id,subject_hash,event_time)
      VALUES($1,$2,to_timestamp($3)) ON CONFLICT(notification_id) DO NOTHING RETURNING notification_id`,
    [event.notificationId, hash, event.event_time]);
    if (!accepted.length) return;
    const { rows } = await tx.query(`DELETE FROM apple_signin_credentials WHERE subject_hash=$1
      AND authorized_at<=to_timestamp($2) RETURNING subject_hash`, [hash, event.event_time]);
    // A delayed/replayed event must not unlink a newer authorization.
    if (!rows.length) return;
    await tx.query(`DELETE FROM sessions WHERE user_id IN
      (SELECT user_id FROM user_identities WHERE provider='apple' AND subject_hash=$1)`, [hash]);
    await tx.query("DELETE FROM user_identities WHERE provider='apple' AND subject_hash=$1", [hash]);
    await tx.query("DELETE FROM social_signin_requests WHERE provider='apple' AND subject_hash=$1", [hash]);
  });
}
