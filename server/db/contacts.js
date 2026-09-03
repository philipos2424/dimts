import { normalizePhone } from '../lib/phone.js';
import { query, queryOne } from './pool.js';

const COLUMNS = 'id, user_id, phone, display_name, company, name_source, name_confidence';

/**
 * Get the contact for a number, creating a blank one on first contact.
 *
 * The DO UPDATE branch is a no-op write that exists only so the statement
 * returns the existing row rather than nothing on conflict.
 */
export async function findOrCreateContact(userId, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error(`Cannot create a contact for unusable phone "${phone}"`);
  }

  return queryOne(
    `INSERT INTO contacts (user_id, phone) VALUES ($1, $2)
       ON CONFLICT (user_id, phone) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING ${COLUMNS}`,
    [userId, normalized]
  );
}

/**
 * Write a model-extracted identity.
 *
 * The `name_source <> 'user'` guard is a second line of defence behind
 * shouldAdoptName: even a caller that skips the policy cannot clobber a name
 * the user typed.
 */
export async function adoptExtractedName(contactId, { name, company, confidence }) {
  await query(
    `UPDATE contacts
        SET display_name = $2,
            company = COALESCE($3, company),
            name_source = 'extracted',
            name_confidence = $4
      WHERE id = $1 AND name_source <> 'user'`,
    [contactId, name, company ?? null, confidence]
  );
}

export async function touchLastCall(contactId) {
  await query('UPDATE contacts SET last_call_at = now() WHERE id = $1', [contactId]);
}
