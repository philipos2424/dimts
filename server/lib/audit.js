import { createHash } from 'node:crypto';
import { query } from '../db/pool.js';

// Addresses are personal data: store only a salted hash, enough to spot reuse.
export function ipHash(req) {
  if (!req?.ip) return null;
  return createHash('sha256').update(`${process.env.AUDIT_SALT || 'dimts-audit'}:${req.ip}`).digest('hex');
}

/**
 * Record who did what to which data. Never throws: an audit write failing
 * must not undo or block the action it describes.
 */
export async function audit({ userId, action, targetType = null, targetId = null, reason = null, req }) {
  try {
    const values = [userId ?? null, action, targetType, targetId == null ? null : String(targetId), ipHash(req)];
    // Only staff actions carry a reason (one of ACCESS_REASONS in lib/admin.js), never free text.
    await query(reason == null
      ? `INSERT INTO audit_events(user_id,action,target_type,target_id,ip_hash) VALUES($1,$2,$3,$4,$5)`
      : `INSERT INTO audit_events(user_id,action,target_type,target_id,ip_hash,reason) VALUES($1,$2,$3,$4,$5,$6)`,
    reason == null ? values : [...values, reason]);
  } catch (err) {
    console.error('[audit] write failed', action, err?.message);
  }
}
