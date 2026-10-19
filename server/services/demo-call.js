import { randomUUID } from 'node:crypto';
import * as database from '../db/pool.js';
import { config } from '../config.js';
import { capture } from '../lib/analytics.js';
import { isAccountSid, providerRest } from '../lib/carrier.js';
import { canCall } from '../lib/destinations.js';
import { RECORDING_NOTICE } from '../lib/recording-consent.js';
import { refuseForReviewDemo } from '../lib/review-demo.js';
import { hasAcceptedTerms } from '../lib/terms.js';
import { HttpError } from '../lib/users.js';
import { captureCallFailure } from '../lib/sentry.js';
import { startCallRecording } from './start-recording.js';

/**
 * The onboarding demo: Dimts rings the owner and a recorded pretend client
 * talks to them, so they see notes from their own voice without finding a
 * second person. One leg, recorded in two channels: the owner is on the
 * inbound channel and the pretend client on the outbound one, which is the
 * same User/Caller layout as a real outgoing call. Never billed.
 */
export const DEMO_CALLS_PER_USER = 2;
const DEMO_MAX_SECONDS = 180;

// Each line is followed by a pause for the owner's answer. The app shows the
// same lines with a suggested reply, so this is the single copy of the script.
export const DEMO_SCRIPT = [
  { client: "Hi, this is Alex Morgan. Thanks for picking up. I'm calling about the quote you sent me last week.",
    reply: 'Hi Alex, thanks for calling.', pause: 4 },
  { client: 'Can you remind me of the total price, and what it includes?',
    reply: 'Say a price and what it covers, like "$2,400, materials and labour included."', pause: 8 },
  { client: 'Okay, that works for me. When could you start?',
    reply: 'Give a day, like "Next Monday."', pause: 5 },
  { client: 'Great. Could you email me the written quote by Friday, so I can sign it?',
    reply: 'Make a promise, like "Yes, I\'ll email it by Friday."', pause: 5 },
  { client: "Perfect. I'll pay the deposit as soon as I've signed. Thanks, talk soon. Goodbye.", reply: null, pause: 0 },
];

const limit = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

/** Ring the owner for a demo. Throws HttpError when the account cannot have one. */
export async function createDemoCall(user) {
  refuseForReviewDemo(user);
  if (!hasAcceptedTerms(user)) throw new HttpError(409, 'terms_required', 'Accept the terms to place recorded calls.');
  if (!canCall(user.phone)) throw new HttpError(403, 'handset_not_supported', 'Dimts cannot ring your phone number in this country.');
  if (new URL(config.publicBaseUrl).protocol !== 'https:') throw new HttpError(503, 'callbacks_unavailable');
  const account = config.providerAccountSid;
  if (!isAccountSid(account)) throw new Error(`Invalid ${config.carrier === 'telnyx' ? 'TELNYX' : 'TWILIO'}_ACCOUNT_SID`);
  const from = user.agent_number || config.twilioNumber;

  const call = await database.withTransaction(async db => {
    // The same lock as real calls, so a demo and a call cannot start together.
    await db.query('SELECT id FROM call_budget_lock WHERE id=1 FOR UPDATE');
    const active = (await db.query(`SELECT id FROM calls WHERE user_id=$1
      AND status IN ('initiating','ringing','in-progress') LIMIT 1`, [user.id])).rows[0];
    if (active) throw new HttpError(409, 'call_in_progress', 'Finish your current call before starting another.');
    // Deleted demos still count: deleting one must not buy another phone call.
    const { used, today } = (await db.query(`SELECT count(*) FILTER (WHERE user_id=$1)::int AS used,
        count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS today
      FROM calls WHERE demo`, [user.id])).rows[0];
    if (used >= DEMO_CALLS_PER_USER) throw new HttpError(429, 'demo_limit', 'You have used your demo calls. Make a real call to see notes from your own conversation.');
    if (today >= limit('DEMO_CALLS_PER_DAY', 100)) throw new HttpError(429, 'demo_busy', 'Demo calls are busy today. Try again tomorrow, or make a real call.');
    return (await db.query(`INSERT INTO calls(user_id,user_phone,destination,contact_id,record_enabled,request_key,max_duration_sec,
        status,direction,agent_number,twilio_account_sid,consent_mode,parent_consent_at,billing_tier,plan_seconds,budget_released,demo)
      VALUES($1,$2,$3,NULL,true,$4,$5,'initiating','outbound',$6,$7,'notice',now(),'demo',0,true,true) RETURNING *`,
    [user.id, user.phone, from, `demo-${randomUUID()}`, DEMO_MAX_SECONDS, user.agent_number ?? null, account])).rows[0];
  });

  try {
    const base = config.publicBaseUrl;
    const created = await providerRest({ timeout: 15_000, autoRetry: false }).calls.create({
      to: user.phone, from,
      url: `${base}/twiml/demo?callId=${call.id}`,
      ...(config.carrier === 'telnyx' ? { urlMethod: 'POST' } : { method: 'POST' }),
      statusCallback: `${base}/webhooks/call-status?callId=${call.id}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });
    if (created?.sid) await database.query('UPDATE calls SET twilio_call_sid=$2 WHERE id=$1', [call.id, created.sid]);
  } catch (err) {
    captureCallFailure(err, { callId: call.id, userId: user.id, stage: 'originate' });
    await database.query(`UPDATE calls SET status='failed', error=$2 WHERE id=$1`,
      [call.id, 'The demo call could not be placed. Try again shortly.']);
    throw new HttpError(502, 'demo_call_failed', 'The demo call could not be placed. Try again shortly.');
  }
  capture(user.id, 'demo_call_started');
  return { callId: call.id, status: call.status, script: DEMO_SCRIPT.map(({ client, reply }) => ({ client, reply })) };
}

/** What the owner hears on answering: who is calling, then the recording notice. */
export function demoGreeting(twiml, call) {
  twiml.say('Hi, this is Dimts with your demo call. A pretend client will talk to you next. Answer as if it were a real call.');
  twiml.say(RECORDING_NOTICE);
  twiml.redirect({ method: 'POST' }, `${config.publicBaseUrl}/twiml/demo-script?callId=${call.id}`);
}

export function demoScript(twiml) {
  for (const line of DEMO_SCRIPT) {
    twiml.say(line.client);
    if (line.pause) twiml.pause({ length: line.pause });
  }
  twiml.hangup();
}

/**
 * Start recording once the notice has played. The conditional update makes a
 * repeated request a no-op, so one demo never gets a second recorder.
 */
export async function startDemoRecording(callId, callSid) {
  const call = await database.queryOne(`UPDATE calls SET recording_start_status='pending',
      other_party_notice_issued_at=COALESCE(other_party_notice_issued_at,now())
    WHERE id=$1 AND demo AND twilio_call_sid=$2 AND recording_start_status IS NULL AND duration_sec IS NULL
      AND deleted_at IS NULL RETURNING *`, [callId, callSid]);
  if (!call) return null;
  try {
    const sid = await startCallRecording(call);
    return database.queryOne(`UPDATE calls SET recording_start_status='started', recording_sid=$2
      WHERE id=$1 AND recording_start_status='pending' RETURNING *`, [callId, sid]);
  } catch (err) {
    captureCallFailure(err, { callId, userId: call.user_id, stage: 'recording_start' });
    const definite = [400, 401, 403, 404, 422].includes(err.status);
    // A timeout may have started a recording. Never issue a second create.
    await database.query(`UPDATE calls SET recording_start_status=$2,
        record_enabled=CASE WHEN $3 THEN false ELSE record_enabled END
      WHERE id=$1 AND recording_start_status='pending'`, [callId, definite ? 'failed' : 'unknown', definite]);
    return definite ? null : call;
  }
}
