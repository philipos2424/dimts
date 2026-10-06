import { query } from '../db/pool.js';

/**
 * Best-effort warning to the owner's other signed-in devices. A stolen number
 * (SIM swap) signs in with a valid code; this is how the real owner finds out.
 */
export async function sendNewSignInNotification(userId, newSessionHash, deviceName) {
  try {
    const { rows } = await query(`SELECT d.push_token FROM notification_devices d JOIN sessions s ON s.token_hash=d.session_hash
      WHERE d.user_id=$1 AND NOT d.disabled AND s.expires_at>now() AND d.session_hash<>$2`, [userId, newSessionHash]);
    if (!rows.length) return;
    await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json',
        ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
      body: JSON.stringify(rows.map(row => ({ to: row.push_token, title: 'New sign-in to Dimts',
        body: `${deviceName || 'A new device'} signed in to your account. Not you? Open Settings › Signed-in devices and sign out everywhere.`,
        data: { type: 'new-sign-in' } }))) });
  } catch (err) {
    console.error('[sign-in-alert] push failed', err?.message);
  }
}
