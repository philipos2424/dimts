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
export async function audit({ userId, action, targetType = null, targetId = null, req }) {
  try {
    await query(`INSERT INTO audit_events(user_id,action,target_type,target_id,ip_hash)
      VALUES($1,$2,$3,$4,$5)`, [userId ?? null, action, targetType, targetId == null ? null : String(targetId), ipHash(req)]);
  } catch (err) {
    console.error('[audit] write failed', action, err?.message);
  }
}
