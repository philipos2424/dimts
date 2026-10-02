const KINDS = new Set(['price', 'quantity', 'date', 'time', 'amount', 'deliverable', 'other']);
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Turn the model's agreements into facts the server can stand behind: every
 * agreement must cite real transcript lines, the quote is the server's own
 * copy of that line, and timing comes only from turns that reproduce the
 * transcript exactly.
 */
export function resolveAgreements(raw, transcript, turns) {
  if (!Array.isArray(raw) || typeof transcript !== 'string') return [];
  const lines = transcript.split('\n');
  const timed = Array.isArray(turns) && turns.length === lines.length &&
    turns.every((turn, i) => `${turn.speaker}: ${turn.text}` === lines[i]);
  const result = [];
  for (const item of raw) {
    if (result.length === 12) break;
    if (!item || typeof item !== 'object') continue;
    const refs = item.source_lines;
    if (!Array.isArray(refs) || !refs.length || refs.some(n => !Number.isInteger(n) || n < 1 || n > lines.length)) continue;
    const subject = clip(item.subject, 200), value = clip(item.value, 200);
    if (!subject || !value) continue;
    const line = refs[0];
    const start = timed && Number.isFinite(turns[line - 1].start) ? turns[line - 1].start : null;
    result.push({
      kind: KINDS.has(item.kind) ? item.kind : 'other',
      subject, value,
      said_by: item.said_by === 'User' || item.said_by === 'Caller' ? item.said_by : null,
      quote: lines[line - 1], line, start,
    });
  }
  return result;
}
