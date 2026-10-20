import * as database from '../db/pool.js';
import { finishCall } from '../db/finish-call.js';
import { reserveCallInTransaction } from '../db/reserve-call.js';
import { HttpError, currentMonth } from '../lib/users.js';
import { audit } from '../lib/audit.js';
import { defer } from '../lib/defer.js';
import { sendIncomingNotification } from './notifications.js';

/** How long a call may ring before it counts as missed. */
export const RING_SECONDS = 45;
const LIVE = ['ringing', 'connecting', 'connected'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const query = (sql, params) => database.query(sql, params);
const queryOne = (sql, params) => database.queryOne(sql, params);
const notFound = () => new HttpError(404, 'app_call_not_found');

/**
 * Create the app_calls row and both people's call rows in ONE transaction, so
 * a busy, over-budget or over-limit person on either side leaves nothing
 * behind and the error reaches the caller (who falls back to the phone path).
 * The caller's row uses the client's idempotency key; retrying returns the
 * same app call.
 */
export async function startAppCall(caller, callee, requestKey) {
  const made = await database.withTransaction(async tx => {
    // The same global lock reserveCall takes, so a retry sees the first attempt.
    await tx.query('SELECT id FROM call_budget_lock WHERE id=1 FOR UPDATE');
    const existing = (await tx.query('SELECT id, route, app_call_id FROM calls WHERE user_id=$1 AND request_key=$2', [caller.id, requestKey])).rows[0];
    if (existing) {
      const app = existing.app_call_id && (await tx.query('SELECT id, callee_id FROM app_calls WHERE id=$1', [existing.app_call_id])).rows[0];
      if (existing.route !== 'app' || !app || app.callee_id !== callee.id) throw new HttpError(409, 'request_key_reused', 'Use a new request key for a different call.');
      return { appCallId: app.id, callId: existing.id, created: false };
    }
    const appCallId = (await tx.query('INSERT INTO app_calls(caller_id,callee_id) VALUES($1,$2) RETURNING id', [caller.id, callee.id])).rows[0].id;
    const callerRow = (await reserveCallInTransaction(tx, caller, callee.phone, true, requestKey, { route: 'app', appCallId })).call;
    const calleeRow = (await reserveCallInTransaction(tx, callee, caller.phone, true, `appcall-${appCallId}`, { route: 'app', appCallId, direction: 'inbound' })).call;
    await tx.query('UPDATE app_calls SET caller_call_id=$2, callee_call_id=$3 WHERE id=$1', [appCallId, callerRow.id, calleeRow.id]);
    return { appCallId, callId: callerRow.id, calleeCallId: calleeRow.id, created: true };
  });
  if (made.created) {
    await audit({ userId: caller.id, action: 'app_call_started', targetType: 'app_call', targetId: made.appCallId });
    defer(sendIncomingNotification(made.calleeCallId), `app-call-push:${made.appCallId}`);
  }
  return { appCallId: made.appCallId, callId: made.callId };
}

async function participant(user, id) {
  if (!UUID.test(String(id))) throw notFound();
  const app = await queryOne('SELECT * FROM app_calls WHERE id=$1 AND (caller_id=$2 OR callee_id=$2)', [id, user.id]);
  if (!app) throw notFound();
  return { app, role: app.caller_id === user.id ? 'caller' : 'callee' };
}

/** Finish both people's rows of a call nobody talked on: no minutes, no charge. */
async function closeUnconnected(app, reason, callerError) {
  for (const id of [app.callee_call_id, app.caller_call_id]) {
    const call = id && await queryOne('SELECT * FROM calls WHERE id=$1', [id]);
    if (call) await finishCall(call, 0, reason, currentMonth());
  }
  if (app.caller_call_id) await query("UPDATE calls SET error=$2 WHERE id=$1 AND status='failed' AND duration_sec=0", [app.caller_call_id, callerError]);
}

/**
 * Time out rings nobody answered. Cheaper than a cron: run on the reads that
 * could show the outcome (like reapStaleCalls for phone calls).
 */
export async function expireRingingAppCalls(userId) {
  const { rows } = await query(`UPDATE app_calls SET status='missed', ended_at=now()
    WHERE status='ringing' AND created_at < now() - make_interval(secs => $2) AND (caller_id=$1 OR callee_id=$1) RETURNING *`, [userId, RING_SECONDS]);
  for (const app of rows) await closeUnconnected(app, 'no-answer', 'No answer');
}

export async function answerAppCall(user, id) {
  await expireRingingAppCalls(user.id);
  const { app, role } = await participant(user, id);
  if (role !== 'callee') throw new HttpError(403, 'not_callee', 'Only the person being called can answer.');
  const answered = await queryOne("UPDATE app_calls SET status='connecting', answered_at=now() WHERE id=$1 AND status='ringing' RETURNING status", [app.id]);
  if (!answered) throw new HttpError(409, 'call_not_ringing', 'This call is no longer ringing.');
  await query("UPDATE calls SET status='in-progress' WHERE id IN ($1,$2) AND duration_sec IS NULL", [app.caller_call_id, app.callee_call_id]);
  return { status: answered.status };
}

export async function declineAppCall(user, id) {
  await expireRingingAppCalls(user.id);
  const { app, role } = await participant(user, id);
  if (role !== 'callee') throw new HttpError(403, 'not_callee', 'Only the person being called can decline.');
  const declined = await queryOne("UPDATE app_calls SET status='declined', ended_at=now() WHERE id=$1 AND status='ringing' RETURNING *", [app.id]);
  if (!declined) throw new HttpError(409, 'call_not_ringing', 'This call is no longer ringing.');
  await closeUnconnected(declined, 'declined', 'Declined');
  return { status: declined.status };
}

/**
 * This person's client showed the recording notice. That is what the OTHER
 * person's row needs, so the timestamp goes on the peer's row; once both rows
 * have it the call is 'connected'. Safe to repeat.
 */
export async function reportConnected(user, id) {
  const { app, role } = await participant(user, id);
  if (!['connecting', 'connected'].includes(app.status)) throw new HttpError(409, 'call_not_active', 'This call is not in progress.');
  const peerCall = role === 'caller' ? app.callee_call_id : app.caller_call_id;
  await query(`UPDATE calls SET other_party_notice_issued_at=COALESCE(other_party_notice_issued_at, now())
    WHERE id=$1 AND duration_sec IS NULL`, [peerCall]);
  const { n } = await queryOne('SELECT count(*)::int AS n FROM calls WHERE id IN ($1,$2) AND other_party_notice_issued_at IS NOT NULL',
    [app.caller_call_id, app.callee_call_id]);
  if (n === 2) await query("UPDATE app_calls SET status='connected' WHERE id=$1 AND status='connecting'", [app.id]);
  return { status: (await queryOne('SELECT status FROM app_calls WHERE id=$1', [app.id])).status };
}

/**
 * End the call for both people. Each row is finished with the reported length
 * capped by what the server measured between answer and end; a call nobody
 * answered bills nothing. Repeats are harmless: finishCall claims a row once.
 */
export async function endAppCall(user, id, reportedSeconds) {
  const { app } = await participant(user, id);
  const ended = await queryOne(`UPDATE app_calls SET status='ended', ended_at=now()
    WHERE id=$1 AND status IN ('ringing','connecting','connected') RETURNING id`, [app.id]);
  if (ended) {
    await query("INSERT INTO app_call_signals(app_call_id,from_user,kind) VALUES($1,$2,'bye')", [app.id, user.id]);
    await audit({ userId: user.id, action: 'app_call_ended', targetType: 'app_call', targetId: app.id });
  }
  const current = await queryOne(`SELECT *, CASE WHEN answered_at IS NULL OR ended_at IS NULL THEN 0
    ELSE GREATEST(0, floor(extract(epoch FROM ended_at - answered_at)))::int END AS measured_sec FROM app_calls WHERE id=$1`, [app.id]);
  if (current.status === 'ended') {
    const answered = current.answered_at != null;
    const seconds = answered ? Math.max(0, Math.min(reportedSeconds, current.measured_sec)) : 0;
    for (const callId of [current.caller_call_id, current.callee_call_id]) {
      const call = await queryOne('SELECT * FROM calls WHERE id=$1', [callId]);
      if (call) await finishCall(call, seconds, answered ? 'completed' : 'canceled', currentMonth());
    }
  }
  return { status: current.status };
}

export async function getAppCallStatus(user, id) {
  await expireRingingAppCalls(user.id);
  const { app, role } = await participant(user, id);
  const bye = await queryOne("SELECT 1 AS found FROM app_call_signals WHERE app_call_id=$1 AND from_user<>$2 AND kind='bye' LIMIT 1", [app.id, user.id]);
  return { status: app.status, role, peerEnded: !!bye };
}

/** The signed-in person's ringing app call, for a foreground app. */
export async function incomingAppCall(user) {
  await expireRingingAppCalls(user.id);
  const row = await queryOne(`SELECT a.id, a.callee_call_id, a.created_at, u.phone, k.display_name
    FROM app_calls a JOIN users u ON u.id=a.caller_id JOIN calls c ON c.id=a.callee_call_id LEFT JOIN contacts k ON k.id=c.contact_id
    WHERE a.callee_id=$1 AND a.status='ringing' ORDER BY a.created_at DESC LIMIT 1`, [user.id]);
  return { appCall: row ? { appCallId: row.id, callId: row.callee_call_id, from: row.phone, fromName: row.display_name ?? null, createdAt: row.created_at } : null };
}

/** Whether this person is on a call that may use relay credentials. */
export async function hasLiveAppCall(user) {
  await expireRingingAppCalls(user.id);
  const row = await queryOne("SELECT 1 AS live FROM app_calls WHERE status IN ('ringing','connecting','connected') AND (caller_id=$1 OR callee_id=$1) LIMIT 1", [user.id]);
  return !!row;
}

export async function addSignal(user, id, kind, payload) {
  await expireRingingAppCalls(user.id);
  const { app } = await participant(user, id);
  if (!LIVE.includes(app.status)) throw new HttpError(409, 'call_over', 'This call has ended.');
  const row = await queryOne('INSERT INTO app_call_signals(app_call_id,from_user,kind,payload) VALUES($1,$2,$3,$4) RETURNING id::float8 AS id',
    [app.id, user.id, kind, JSON.stringify(payload)]);
  return { id: row.id };
}

/** What the OTHER person sent, oldest first, at most 50 after the cursor. */
export async function listSignals(user, id, after) {
  const { app } = await participant(user, id);
  const { rows } = await query(`SELECT id::float8 AS id, kind, payload, created_at FROM app_call_signals
    WHERE app_call_id=$1 AND from_user<>$2 AND id>$3 ORDER BY id LIMIT 50`, [app.id, user.id, after]);
  return { signals: rows.map(r => ({ id: r.id, kind: r.kind, payload: r.payload, createdAt: r.created_at })) };
}
