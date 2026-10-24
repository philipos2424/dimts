import { isE164, normalizePhone } from '../lib/phone.js';
import { queryOne } from './pool.js';

/**
 * The inbound call path's first database read: which user publishes this
 * number? Returns undefined rather than throwing, because an inbound call to
 * an unclaimed number is a routing mistake, not a server error.
 */
export async function findUserByAgentNumber(agentNumber) {
  const normalized = normalizePhone(agentNumber);
  if (!normalized) return undefined;

  return queryOne(
    `SELECT id, phone, agent_number, terms_version, incoming_recording FROM users WHERE agent_number = $1 AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM agent_number_pool p WHERE p.phone=$1 AND p.available_after > now())`,
    [normalized]
  );
}

/**
 * Operator-driven provisioning. Self-serve number purchase is deferred until
 * the validation cohort proves the product; assigning by hand is enough for
 * a handful of users and avoids a Twilio purchase flow we may not keep.
 */
export async function assignAgentNumber(userPhone, agentNumber) {
  const user = normalizePhone(userPhone);
  const agent = normalizePhone(agentNumber);

  if (!user) throw new Error(`User phone must be E.164, got "${userPhone}"`);
  if (!agent) throw new Error(`Agent number must be E.164, got "${agentNumber}"`);

  return queryOne(
    `WITH pooled AS (SELECT available_after FROM agent_number_pool WHERE phone=$2 FOR UPDATE)
     INSERT INTO users (phone, agent_number) SELECT $1, $2
       WHERE NOT EXISTS (SELECT 1 FROM pooled WHERE available_after > now())
       ON CONFLICT (phone) DO UPDATE SET agent_number = EXCLUDED.agent_number
     RETURNING id, phone, agent_number`,
    [user, agent]
  );
}

export { isE164 };
