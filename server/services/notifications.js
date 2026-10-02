import { query } from '../db/pool.js';

const SEND = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS = 'https://exp.host/--/api/v2/push/getReceipts';
const headers = () => ({ 'Content-Type': 'application/json',
  ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) });
const validTicket = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const validPushToken = token => typeof token === 'string' && /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,200}\]$/.test(token);

export async function sendIncomingNotification(callId) {
  await query(`INSERT INTO call_notifications(call_id,device_id,user_id)
    SELECT c.id,d.id,c.user_id FROM calls c JOIN notification_devices d ON d.user_id=c.user_id
      JOIN sessions s ON s.token_hash=d.session_hash
    WHERE c.id=$1 AND c.direction='inbound' AND c.deleted_at IS NULL AND c.duration_sec IS NULL
      AND c.created_at>now()-interval '2 minutes'
      AND c.status IN ('ringing','in-progress') AND NOT d.disabled AND s.expires_at>now()
    ON CONFLICT(call_id,device_id) DO NOTHING`, [callId]);
  const { rows: jobs } = await query(`UPDATE call_notifications n SET status='sending',updated_at=now()
    FROM calls c,notification_devices d,sessions s
    WHERE n.call_id=$1 AND n.status='pending' AND c.id=n.call_id AND c.deleted_at IS NULL
      AND c.created_at>now()-interval '2 minutes'
      AND c.duration_sec IS NULL AND c.status IN ('ringing','in-progress') AND c.user_id=n.user_id
      AND d.id=n.device_id AND d.user_id=n.user_id AND NOT d.disabled AND s.token_hash=d.session_hash AND s.expires_at>now()
    RETURNING n.id,n.call_id,n.device_id,n.user_id,d.push_token,d.session_hash`, [callId]);
  if (!jobs.length) return;
  let tickets;
  try {
    const response = await fetch(SEND, { method: 'POST', headers: headers(),
      body: JSON.stringify(jobs.map(job => ({ to: job.push_token, title: 'Dimts incoming call',
        body: 'Open Dimts to see your caller briefing.', data: { type: 'incoming-call', callId: job.call_id },
        sound: 'default', channelId: 'incoming-calls', priority: 'high', ttl: 60 }))),
      signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Push service unavailable');
    tickets = (await response.json()).data;
    if (!Array.isArray(tickets) || tickets.length !== jobs.length) throw new Error('Invalid ticket batch');
  } catch {
    for (const job of jobs) await query(`UPDATE call_notifications SET status='unknown',error_code='send_unconfirmed',updated_at=now()
      WHERE id=$1 AND status='sending'`, [job.id]);
    return;
  }
  for (const [index,job] of jobs.entries()) {
    const ticket = tickets[index];
    const accepted = ticket?.status === 'ok' && validTicket(ticket.id);
    const invalidDevice = ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered';
    await query(`UPDATE call_notifications SET status=$2,ticket_id=$3,error_code=$4,updated_at=now()
      WHERE id=$1 AND status='sending'`, [job.id, accepted ? 'accepted' : 'failed', accepted ? ticket.id : null,
      accepted ? null : invalidDevice ? 'device_not_registered' : 'push_rejected']);
    if (invalidDevice) await query(`UPDATE notification_devices SET disabled=true WHERE id=$1 AND user_id=$2 AND session_hash=$3`,
      [job.device_id,job.user_id,job.session_hash]);
  }
}

// A receipt means Expo handed the message to APNs/FCM, not that the phone
// displayed it. No automatic re-send follows an uncertain outcome.
export async function checkPushReceipts(userId) {
  await query(`UPDATE call_notifications SET status='failed',error_code='alert_expired',updated_at=now()
    WHERE user_id=$1 AND status='pending' AND created_at<now()-interval '2 minutes'`, [userId]);
  await query(`UPDATE call_notifications SET status='unknown',error_code='send_interrupted',updated_at=now()
    WHERE user_id=$1 AND status='sending' AND updated_at<now()-interval '2 minutes'`, [userId]);
  await query(`UPDATE call_notifications SET status='unknown',error_code='receipt_expired',updated_at=now()
    WHERE user_id=$1 AND status='accepted' AND created_at<now()-interval '24 hours'`, [userId]);
  const { rows: jobs } = await query(`SELECT n.*,d.session_hash FROM call_notifications n
    JOIN notification_devices d ON d.id=n.device_id AND d.user_id=n.user_id
    WHERE n.user_id=$1 AND n.status='accepted' AND n.created_at<now()-interval '15 minutes'
      AND n.updated_at<now()-interval '1 minute' ORDER BY n.created_at DESC LIMIT 100`, [userId]);
  if (!jobs.length) return;
  let receipts;
  try {
    const response = await fetch(RECEIPTS, { method: 'POST',headers:headers(),
      body:JSON.stringify({ids:jobs.map(job=>job.ticket_id).filter(validTicket)}),signal:AbortSignal.timeout(5000) });
    if (!response.ok) return;
    receipts=(await response.json()).data;
    if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) return;
  } catch { return; }
  for (const job of jobs) {
    const receipt=receipts[job.ticket_id];
    if (!['ok','error'].includes(receipt?.status)) continue;
    const invalidDevice=receipt.status==='error'&&receipt.details?.error==='DeviceNotRegistered';
    await query(`UPDATE call_notifications SET status=$2,error_code=$3,updated_at=now()
      WHERE id=$1 AND user_id=$4 AND status='accepted'`, [job.id,receipt.status==='ok'?'provider_handoff':'failed',
      receipt.status==='ok'?null:invalidDevice?'device_not_registered':'receipt_error',userId]);
    if (invalidDevice) await query(`UPDATE notification_devices SET disabled=true WHERE id=$1 AND user_id=$2 AND session_hash=$3`,
      [job.device_id,userId,job.session_hash]);
  }
}

/** Best-effort nudge: someone asked this business to delete their call data. */
export async function sendPrivacyRequestNotification(userId) {
  try {
    const { rows } = await query(`SELECT d.push_token FROM notification_devices d JOIN sessions s ON s.token_hash=d.session_hash
      WHERE d.user_id=$1 AND NOT d.disabled AND s.expires_at>now()`, [userId]);
    if (!rows.length) return;
    await fetch(SEND, { method: 'POST', headers: headers(), signal: AbortSignal.timeout(5000),
      body: JSON.stringify(rows.map(row => ({ to: row.push_token, title: 'Privacy request',
        body: 'Someone asked for their call data to be deleted. Review it in Dimts within 30 days.',
        data: { type: 'privacy-request' } }))) });
  } catch (err) {
    console.error('[notifications] privacy request push failed', err?.message);
  }
}
