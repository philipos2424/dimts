import express from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { defer } from '../lib/defer.js';
import { verifyTwilioSignature } from '../lib/twilio-signature.js';
import { currentMonth } from '../lib/users.js';
import { finishCall } from '../db/finish-call.js';
import { processRecording } from '../services/process-recording.js';
import { askRecordingConsent, dialCall } from '../lib/recording-consent.js';
import { beginAgreedRecording } from '../db/start-recording.js';

const { VoiceResponse } = twilio.twiml;

/**
 * Two routers rather than one mounted at '/', because a router-level guard
 * mounted at the root also runs for paths the router does not handle - which
 * made every unmatched URL answer 403 instead of 404.
 */
export const twimlRouter = express.Router();
export const webhooksRouter = express.Router();

twimlRouter.use(verifyTwilioSignature);
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
    if (byId) {
      if (!callSid || (byId.twilio_call_sid && byId.twilio_call_sid !== callSid)) return undefined;
      return byId;
    }
  }
  if (callSid) {
    return queryOne('SELECT * FROM calls WHERE twilio_call_sid = $1', [callSid]);
  }
  return undefined;
}

/** TwiML fetched when the user answers leg A: dial the destination, record both. */
twimlRouter.post('/bridge', async (req, res) => {
  const callId = req.query.callId ?? req.body?.callId;
  const call = await resolveCall({ callId, callSid: req.body?.CallSid });
  const destination = call?.direction === 'outbound' ? call.destination : null;
  const base = config.publicBaseUrl;

  const twiml = new VoiceResponse();

  if (!destination) {
    twiml.say('Sorry, no destination was provided for this call.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  if (call.record_enabled !== false) askRecordingConsent(twiml, `${base}/twiml/accept?callId=${call.id}`);
  else dialCall(twiml, call);

  res.type('text/xml').send(twiml.toString());
});

twimlRouter.post('/accept', async (req, res) => {
  const call = await resolveCall({ callId: req.query.callId, callSid: req.body?.CallSid });
  const twiml = new VoiceResponse();
  if (!call || call.duration_sec != null) twiml.hangup();
  else {
    const accepted = req.body?.Digits === '1' && call.record_enabled !== false;
    const chosen = await queryOne(`UPDATE calls SET parent_consent_choice=$2,
      parent_consent_at=CASE WHEN $2='accepted' THEN now() ELSE NULL END,
      record_enabled=record_enabled AND $2='accepted',twilio_call_sid=COALESCE(twilio_call_sid,$3)
      WHERE id=$1 AND parent_consent_choice IS NULL RETURNING *`, [call.id, accepted ? 'accepted' : 'declined', req.body.CallSid]);
    const current = chosen ?? await queryOne('SELECT * FROM calls WHERE id = $1', [call.id]);
    if (current?.record_enabled === false) twiml.say('Connecting without recording.');
    if (current) dialCall(twiml, current); else twiml.hangup();
  }
  res.type('text/xml').send(twiml.toString());
});

// Runs on the dialled party's leg before Twilio bridges the two people.
twimlRouter.post('/party-consent', async (req, res) => {
  const twiml = new VoiceResponse();
  if (!req.body?.CallSid) { twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }
  const call = await queryOne(`UPDATE calls SET child_call_sid=$2 WHERE id=$1 AND duration_sec IS NULL
    AND (child_call_sid IS NULL OR child_call_sid=$2) RETURNING *`, [req.query.callId, req.body.CallSid]);
  if (!call) twiml.hangup();
  else if (call.record_enabled === false) twiml.say('This call is not being recorded. Connecting.');
  else if (!call.parent_consent_at) twiml.hangup();
  else if (req.query.choice === '1') {
    const choice = req.body.Digits === '1' ? 'accepted' : 'declined';
    const chosen = await queryOne(`UPDATE calls SET child_consent_choice=$3,
      child_consent_at=CASE WHEN $3='accepted' THEN now() ELSE NULL END,
      record_enabled=record_enabled AND $3='accepted'
      WHERE id=$1 AND child_call_sid=$2 AND child_consent_choice IS NULL RETURNING *`, [call.id, req.body.CallSid, choice]);
    const current = chosen ?? await queryOne('SELECT * FROM calls WHERE id = $1', [call.id]);
    if (current.record_enabled === false) twiml.say('Connecting without recording.');
    else {
      const recording = await beginAgreedRecording(call.id, req.body.CallSid);
      twiml.say(recording.record_enabled === false ? 'Recording is unavailable. Connecting without recording.' : 'Recording agreed. Connecting.');
    }
  } else if (call.child_consent_choice) {
    await beginAgreedRecording(call.id, req.body.CallSid);
  } else {
    askRecordingConsent(twiml, `${config.publicBaseUrl}/twiml/party-consent?callId=${call.id}&choice=1`);
  }
  res.type('text/xml').send(twiml.toString());
});

/** Leg A lifecycle. Drives the status badge in Recents. */
webhooksRouter.post('/call-status', async (req, res) => {
  const { CallStatus, CallSid } = req.body ?? {};
  const call = await resolveCall({ callId: req.query.callId, callSid: CallSid });

  if (call) {
    const mapped = { ringing: 'ringing', 'in-progress': 'in-progress' }[CallStatus];

    if (mapped) {
      await query(`UPDATE calls SET status = $2 WHERE id = $1
        AND status IN ('initiating', 'ringing')`, [call.id, mapped]);
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
twimlRouter.post('/dial-done', async (req, res) => {
  const { DialCallStatus, DialCallDuration, CallSid } = req.body ?? {};
  const call = await resolveCall({ callId: req.query.callId, callSid: CallSid });

  if (call) {
    await finishCall(call, Number(DialCallDuration ?? 0), DialCallStatus, currentMonth());
  }

  const twiml = new VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

/**
 * Recording is ready. ACK immediately — Twilio gives up after ~15s and the
 * transcribe + summarize pipeline takes far longer than that.
 */
webhooksRouter.post('/recording-ready', async (req, res) => {
  const { RecordingUrl, RecordingStatus, CallSid } = req.body ?? {};
  const call = await resolveCall({ callId: req.query.callId, callSid: CallSid });

  if (call && call.record_enabled !== false && call.parent_consent_at && call.child_consent_at && RecordingStatus === 'completed' && RecordingUrl) {
    if (call.recording_start_status && (!/^RE[a-f0-9]{32}$/i.test(req.body.RecordingSid ?? '') ||
      (call.recording_sid && call.recording_sid !== req.body.RecordingSid))) return res.status(204).end();
    const accepted = await queryOne(
      `UPDATE calls SET recording_url = $2, status = 'processing', error=NULL,
        recording_sid=COALESCE(recording_sid,$3),recording_start_status='started'
       WHERE id = $1 AND recording_url IS NULL AND status <> 'ready'
         AND record_enabled AND parent_consent_at IS NOT NULL AND child_consent_at IS NOT NULL
         AND (recording_sid IS NULL OR recording_sid=$3)
       RETURNING id`,
      [call.id, RecordingUrl, req.body.RecordingSid ?? null]
    );
    if (accepted) defer(processRecording(call.id), `process:${call.id}`);
  }

  res.status(204).end();
});
