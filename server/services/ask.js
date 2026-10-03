import { query } from '../db/pool.js';
import { transcriptTurns } from '../lib/transcript-turns.js';
import { completeJson } from './llm.js';

const MAX_CALLS = 8, MAX_LINES = 120;
const SEARCH = `to_tsvector('simple', coalesce(summary,'') || ' ' || coalesce(transcript,''))`;
const COLUMNS = `c.id, c.created_at, c.direction, c.duration_sec, c.transcript, c.transcript_data, c.recording_url,
  c.transcript_recording_url, c.deleted_at, c.agreements, k.display_name AS contact_name`;
const READY = `c.user_id=$1 AND c.status='ready' AND c.deleted_at IS NULL AND c.transcript IS NOT NULL`;

const PROMPT = `You answer questions about the user's own business phone calls.
Use only the call excerpts given. Each call starts with a label like C1 and
each transcript line has its number in brackets. Answer in one to three short
sentences in the language of the question. Every fact must be cited.
Return JSON: {"answer": "...", "citations": [{"call": "C1", "line": 12}]}.
If the excerpts do not contain the answer, return {"answer": "", "citations": []}.
Earlier turns, when given, only explain what a follow-up question refers to;
they are not evidence. Cite the excerpts.`;

async function retrieve(userId, question) {
  const picked = new Map();
  const add = rows => { for (const row of rows) if (picked.size < MAX_CALLS && !picked.has(row.id)) picked.set(row.id, row); };
  add((await query(`SELECT ${COLUMNS} FROM calls c LEFT JOIN contacts k ON k.id=c.contact_id
    WHERE ${READY} AND ${SEARCH} @@ websearch_to_tsquery('simple', $2)
    ORDER BY ts_rank(${SEARCH}, websearch_to_tsquery('simple', $2)) DESC, c.created_at DESC LIMIT 6`, [userId, question])).rows);
  add((await query(`SELECT ${COLUMNS} FROM calls c JOIN contacts k ON k.id=c.contact_id
    WHERE ${READY} AND length(k.display_name) >= 2 AND position(lower(k.display_name) IN lower($2)) > 0
    ORDER BY c.created_at DESC LIMIT 3`, [userId, question])).rows);
  if (picked.size < 3) add((await query(`SELECT ${COLUMNS} FROM calls c LEFT JOIN contacts k ON k.id=c.contact_id
    WHERE ${READY} ORDER BY c.created_at DESC LIMIT 3`, [userId])).rows);
  return [...picked.values()];
}

// Lines that mention the question's words come first, then lines behind an
// agreement, then the opening of the call. Original numbers are kept.
function excerpt(call, question) {
  const lines = call.transcript.split('\n');
  const words = [...new Set(question.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(w => w.length >= 3))];
  const chosen = new Set();
  const take = i => { if (chosen.size < MAX_LINES && i >= 0 && i < lines.length) chosen.add(i); };
  lines.forEach((line, i) => { if (words.some(w => line.toLowerCase().includes(w))) take(i); });
  for (const agreement of Array.isArray(call.agreements) ? call.agreements : []) take((agreement?.line ?? 0) - 1);
  for (let i = 0; i < lines.length && chosen.size < MAX_LINES; i++) take(i);
  return { lines, sent: [...chosen].sort((a, b) => a - b) };
}

export async function answerQuestion(userId, question, history = []) {
  // A follow-up ("and the delivery date?") is searched together with the
  // question it follows, so the same calls come back.
  const searchText = [history.at(-1)?.question, question].filter(Boolean).join(' ');
  const calls = await retrieve(userId, searchText);
  if (!calls.length) return { answer: null, grounded: false, citations: [] };
  const sections = calls.map((call, i) => ({ label: `C${i + 1}`, call, ...excerpt(call, searchText) }));
  const earlier = history.flatMap(t => [`Q: ${t.question}`, `A: ${t.answer}`]);
  const input = [...(earlier.length ? ['Earlier in this conversation:', ...earlier, ''] : []),
    `Question: ${question}`, '', ...sections.flatMap(s => [
    `${s.label} | ${s.call.contact_name ?? 'Unknown caller'} | ${new Date(s.call.created_at).toISOString().slice(0, 10)} | ${s.call.direction}`,
    ...s.sent.map(i => `[${i + 1}] ${s.lines[i]}`), '',
  ])].join('\n');
  const reply = JSON.parse(await completeJson(PROMPT, input));
  const citations = [];
  for (const cite of Array.isArray(reply?.citations) ? reply.citations : []) {
    const section = sections.find(s => s.label === cite?.call);
    const line = Number(cite?.line);
    if (!section || !Number.isInteger(line) || !section.sent.includes(line - 1)) continue;
    if (citations.some(c => c.call_id === section.call.id && c.line === line)) continue;
    const turns = transcriptTurns(section.call);
    const timed = turns.length === section.lines.length;
    citations.push({ call_id: section.call.id, contact_name: section.call.contact_name ?? null,
      created_at: section.call.created_at, line, quote: section.lines[line - 1],
      start: timed && Number.isFinite(turns[line - 1].start) ? turns[line - 1].start : null });
  }
  const answer = typeof reply?.answer === 'string' ? reply.answer.trim().slice(0, 1000) : '';
  if (!citations.length || !answer) return { answer: null, grounded: false, citations: [] };
  return { answer, grounded: true, citations };
}
