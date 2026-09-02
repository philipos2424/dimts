import express from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { defer } from '../lib/defer.js';
import { verifyTwilioSignature } from '../lib/twilio-signature.js';
import { currentMonth } from '../lib/users.js';
import { processRecording } from '../services/process-recording.js';

const { VoiceResponse } = twilio.twiml;

export const webhooksRouter = express.Router();
webhooksRouter.use(verifyTwilioSignature);

/**
 * Find the call a webhook refers to.
 *
 * Every callback URL carries ?callId= because the recording callback reports
 * the *parent* leg's CallSid, which makes SID matching alone fragile. The SID
 * lookup stays as a fallback for callbacks we did not construct.
 */
async function resolveCall({ callId, callSid }) {
  if (callId) {
    const byId = await queryOne('SELECT * FROM calls WHERE id = $1', [callId]);
    if (byId) return byId;
  }
  if (callSid) {
    return queryOne('SELECT * FROM calls WHERE twilio_call_sid = $1', [callSid]);
  }
  return undefined;
}

/** TwiML fetched when the user answers leg A: dial the destination, record both. */
webhooksRouter.post('/twiml/bridge', (req, res) => {
  const destination = req.query.dest ?? req.body?.dest;
  const callId = req.query.callId ?? req.body?.callId;
  const base = config.publicBaseUrl;

  const twiml = new VoiceResponse();

  if (!destination) {
    twiml.say('Sorry, no destination was provided for this call.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  twiml.pause({ length: 1 });

  const dial = twiml.dial({
    record: 'record-from-answer-dual',
    recordingStatusCallback: `${base}/webhooks/recording-ready?callId=${callId}`,
    recordingStatusCallbackMethod: 'POST',
    recordingStatusCallbackEvent: 'completed',
    action: `${base}/webhooks/dial-done?callId=${callId}`,
    method: 'POST',
    timeout: 30,
    timeLimit: 7200,
  });
  dial.number(destination);

  res.type('text/xml').send(twiml.toString());
});

/** Leg A lifecycle. Drives the status badge in Recents. */
webhooksRouter.post('/webhooks/call-status', async (req, res) => {
  const { CallStatus, CallSid } = req.body ?? {};
  const call = await resolveCall({ callId: req.query.callId, callSid: CallSid });

  if (call) {
    const mapped = { ringing: 'ringing', 'in-progress': 'in-progress' }[CallStatus];

    if (mapped) {
      await query('UPDATE calls SET status = $2 WHERE id = $1', [call.id, mapped]);
    } else if (
      ['busy', 'no-answer', 'failed', 'canceled'].includes(CallStatus) &&
      // A completed dial has already moved the row on; don't drag it back.
      ['initiating', 'ringing'].includes(call.status)
    ) {
      await query(
        `UPDATE calls SET status = 'failed', error = $2 WHERE id = $1`,
        [call.id, `Call ${CallStatus}`]
      );
    }
  }

  res.status(204).end();
});

/**
 * Leg B finished. The single source of truth for duration and billing —
 * RecordingDuration arrives separately and must not also increment minutes,
 * or every call is counted twice.
 */
webhooksRouter.post('/webhooks/dial-done', async (req, res) => {
  const { DialCallStatus, DialCallDuration, CallSid } = req.body ?? {};
  const call = await resolveCall({ callId: req.query.callId, callSid: CallSid });

  if (call) {
    const seconds = Number(DialCallDuration ?? 0) || 0;
    const connected = DialCallStatus === 'completed' && seconds > 0;

    // duration_sec IS NULL guards against a webhook retry double-billing.
    const updated = await queryOne(
      `UPDATE calls
          SET duration_sec = $2,
              status = CASE WHEN $3 THEN 'processing' ELSE 'failed' END,
              error = CASE WHEN $3 THEN error ELSE $4 END
        WHERE id = $1 AND duration_sec IS NULL
        RETURNING id, user_id`,
      [call.id, seconds, connected, `Dial ${DialCallStatus}`]
    );

    if (updated && connected) {
      await query(
        `INSERT INTO usage_minutes (user_id, month, minutes_used)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, month)
         DO UPDATE SET minutes_used = usage_minutes.minutes_used + EXCLUDED.minutes_used`,
        [updated.user_id, currentMonth(), seconds / 60]
      );
    }
  }

  const twiml = new VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

/**
 * Recording is ready. ACK immediately — Twilio gives up after ~15s and the
 * transcribe + summarize pipeline takes far longer than that.
 */
webhooksRouter.post('/webhooks/recording-ready', async (req, res) => {
  const { RecordingUrl, RecordingStatus, CallSid } = req.body ?? {};
  const call = await resolveCall({ callId: req.query.callId, callSid: CallSid });

  if (call && RecordingStatus === 'completed' && RecordingUrl) {
    await query(
      `UPDATE calls SET recording_url = $2, status = 'processing' WHERE id = $1`,
      [call.id, RecordingUrl]
    );
    defer(processRecording(call.id), `process:${call.id}`);
  }

  res.status(204).end();
});
