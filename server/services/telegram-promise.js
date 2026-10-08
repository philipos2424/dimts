import { completeJson } from './llm.js';
import { query, queryOne } from '../db/pool.js';
import { minimeConfigured, minimePost } from './minime.js';

/**
 * "I'll send it to you on Telegram": when the owner promises that on a call and
 * has linked MiniMe, MiniMe sends it to the caller. Most calls never mention
 * Telegram, so a word check comes before any model spend.
 */
const TELEGRAM_WORDS = /tele?ga?ra?m|ቴሌግራም|ቴሌግራም|ቴሌ\s?ግራም|\btg\b/i;
export const mentionsTelegram = transcript => TELEGRAM_WORDS.test(transcript ?? '');

export const TELEGRAM_PROMPT = `Decide whether User promised, during this phone call, to send Caller
something on Telegram (a price list, photos, a location, an address, details,
a payment number, a document, "I'll text you on Telegram").
Return {promised, request, draft, evidence}.
promised is true only if User themself committed to send it on Telegram. Caller
promising to send something, or only mentioning Telegram, is false.
request: in a few words, what User will send ("cement price list", "shop location").
draft: the Telegram message from User to Caller that keeps the promise, using
only facts said in the call. Never invent prices, quantities, dates, links,
account numbers or addresses; if the content was not said, write a short
message that says what it is about and leave the details to the business.
Write the draft in the language the call was held in.
evidence: {source_lines: 1-3 transcript line numbers where User promised it,
confidence: number from 0 to 1}.
If promised is false, return empty strings and evidence {source_lines: [], confidence: 0}.`;

const MIN_CONFIDENCE = 0.75;

/** Validate the model's answer against the transcript; null when nothing should be sent. */
export function parseTelegramPromise(content, transcript) {
  const data = JSON.parse(content);
  if (!data || typeof data !== 'object' || data.promised !== true) return null;
  const text = (value, max) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);
  const request = text(data.request, 300);
  const draft = text(data.draft, 1500);
  if (!request || !draft) return null;
  const lines = transcript.split('\n');
  const refs = data.evidence?.source_lines;
  const confidence = data.evidence?.confidence;
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 3 ||
      refs.some(n => !Number.isInteger(n) || n < 1 || n > lines.length)) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || confidence > 1) return null;
  const quotes = refs.map(n => lines[n - 1]);
  // The promise has to be User's own words, and Telegram has to be in them.
  if (!quotes.some(q => /^User:/.test(q)) || !mentionsTelegram(quotes.join('\n'))) return null;
  return { request, draft, evidence: { quotes, confidence } };
}

export async function detectTelegramPromise(transcript, { signal } = {}) {
  const numbered = transcript.split('\n').map((line, i) => `[${i + 1}] ${line}`).join('\n');
  return parseTelegramPromise(await completeJson(TELEGRAM_PROMPT, numbered, {
    type: 'object', additionalProperties: false,
    properties: {
      promised: { type: 'boolean' }, request: { type: 'string' }, draft: { type: 'string' },
      evidence: { type: 'object', additionalProperties: false, properties: {
        source_lines: { type: 'array', items: { type: 'integer' } }, confidence: { type: 'number' },
      }, required: ['source_lines', 'confidence'] },
    }, required: ['promised', 'request', 'draft', 'evidence'],
  }, { signal }), transcript);
}

/**
 * After a call's notes are ready. Best-effort: a failure here never touches
 * the call itself, and each call is sent at most once (telegram_sends.call_id
 * is unique and is claimed before MiniMe is asked).
 */
export async function sendPromisedTelegram(callId, { signal } = {}) {
  if (!minimeConfigured()) return { status: 'skipped' };
  const call = await queryOne(`SELECT c.id, c.user_id, c.transcript, c.destination, c.status, u.language,
      k.display_name AS contact_name, l.auto_send
    FROM calls c
    JOIN users u ON u.id = c.user_id
    JOIN minime_links l ON l.user_id = c.user_id
    LEFT JOIN contacts k ON k.id = c.contact_id
    WHERE c.id=$1 AND c.status='ready' AND c.deleted_at IS NULL AND c.voicemail IS NOT TRUE`, [callId]);
  if (!call?.auto_send || !call.transcript || !/^\+\d{8,15}$/.test(call.destination ?? '')) return { status: 'skipped' };
  if (!mentionsTelegram(call.transcript)) return { status: 'skipped' };

  const promise = await detectTelegramPromise(call.transcript, { signal });
  if (!promise) return { status: 'skipped' };

  const claimed = await queryOne(`INSERT INTO telegram_sends(call_id,user_id,request,draft,evidence,status)
    VALUES($1,$2,$3,$4,$5,'sending') ON CONFLICT (call_id) DO NOTHING RETURNING id`,
  [call.id, call.user_id, promise.request, promise.draft, JSON.stringify(promise.evidence)]);
  if (!claimed) return { status: 'skipped' };

  let status = 'failed', error = null;
  try {
    const result = await minimePost({
      type: 'send', send_id: claimed.id, user_id: call.user_id, phone: call.destination,
      caller_name: call.contact_name ?? '', request: promise.request, draft: promise.draft,
      language: call.language === 'am' ? 'am' : 'en',
    }, { signal });
    if (['sent', 'waiting', 'failed'].includes(result?.status)) status = result.status;
    if (result?.error) error = String(result.error).slice(0, 200);
  } catch (err) {
    error = 'minime_unreachable';
    console.error('[telegram-promise] MiniMe request failed for call', call.id, err?.message);
  }
  await query(`UPDATE telegram_sends SET status=$2, error=$3, updated_at=now() WHERE id=$1`, [claimed.id, status, error]);
  return { status };
}
