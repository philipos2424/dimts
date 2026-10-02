import { recordingQualityError } from './recording-quality.js';

const SILENT = recordingQualityError({ audio_quality: { status: 'silent' } });
const ONE_VOICE = ['single_channel', 'missing_channel_signal']
  .map(status => recordingQualityError({ audio_quality: { status } }))
  .concat(recordingQualityError({ transcripts: [{ text: 'x' }] }));

/** What the Today card shows about the recording itself. */
export function captureState(call) {
  if (call.status === 'ready') return 'both';
  if (call.status === 'processing') return 'pending';
  if (!call.has_audio) return 'none';
  if (call.error === SILENT) return 'no_audio';
  if (ONE_VOICE.includes(call.error)) return 'one_voice';
  return 'unknown';
}

/** One thing to do next: a proposal waiting for approval first, then advice. */
export function nextStep(call) {
  const followups = call.followups ?? {};
  if (followups.meeting?.status === 'pending') return { kind: 'meeting', text: followups.meeting.title };
  if (followups.email?.status === 'pending') return { kind: 'email', text: followups.email.subject };
  const move = Array.isArray(call.next_moves) ? call.next_moves.find(m => typeof m === 'string' && m.trim()) : null;
  return move ? { kind: 'move', text: move } : null;
}

export function todayCard({ followups, next_moves, error, has_audio, agreements, conflicts, ...call }) {
  return {
    ...call,
    capture: captureState({ ...call, error, has_audio }),
    agreements: Array.isArray(agreements) ? agreements.slice(0, 3) : [],
    conflict_count: Array.isArray(conflicts) ? conflicts.length : 0,
    next_step: nextStep({ followups, next_moves }),
  };
}
