import { query, queryOne } from '../db/pool.js';
import { completeJson } from './llm.js';

const PROMPT = `You compare what was agreed on a business call with what the same
person agreed on earlier calls. A conflict is when the same subject has a
different value: a different price, quantity, date, time, amount or
deliverable. Rewording, added detail or a new topic is not a conflict.
Return JSON: {"conflicts": [{"new": "N1", "previous": "P2", "note": "one neutral sentence"}]}.
Use only the labels given. Never accuse anyone; describe the difference.
Return {"conflicts": []} when nothing conflicts.`;

const line = (label, a) => `${label}: ${a.subject} = ${a.value}${a.said_by ? ` (said by ${a.said_by})` : ''}`;

/**
 * Memory check, first version. Best-effort: a failure leaves the call ready
 * and unflagged. The model only ever sees labels; the server maps them back
 * to call ids it chose, so it cannot point at anyone else's calls.
 */
export async function checkConsistency(callId, { signal } = {}) {
  try {
    const call = await queryOne(`SELECT id,user_id,contact_id,agreements,created_at FROM calls
      WHERE id=$1 AND deleted_at IS NULL`, [callId]);
    const current = Array.isArray(call?.agreements) ? call.agreements : [];
    if (!call?.contact_id || !current.length) return [];
    const { rows } = await query(`SELECT id,created_at,agreements FROM calls
      WHERE user_id=$1 AND contact_id=$2 AND id<>$3 AND status='ready' AND deleted_at IS NULL
        AND created_at < $4 AND jsonb_typeof(agreements)='array' AND jsonb_array_length(agreements)>0
      ORDER BY created_at DESC LIMIT 5`, [call.user_id, call.contact_id, call.id, call.created_at]);
    const previous = [];
    for (const row of rows) for (const [index, agreement] of row.agreements.entries()) {
      if (previous.length < 20) previous.push({ call_id: row.id, index, agreement, date: row.created_at });
    }
    if (!previous.length) return [];
    const input = ['Earlier calls:', ...previous.map((p, i) => `${line(`P${i + 1}`, p.agreement)} on ${new Date(p.date).toISOString().slice(0, 10)}`),
      '', 'This call:', ...current.map((a, i) => line(`N${i + 1}`, a))].join('\n');
    const reply = JSON.parse(await completeJson(PROMPT, input, 'json', { signal }));
    const conflicts = [];
    for (const item of Array.isArray(reply?.conflicts) ? reply.conflicts : []) {
      const n = /^N(\d+)$/.exec(item?.new ?? '')?.[1], p = /^P(\d+)$/.exec(item?.previous ?? '')?.[1];
      const now = current[Number(n) - 1], before = previous[Number(p) - 1];
      if (!now || !before || typeof item.note !== 'string' || !item.note.trim()) continue;
      conflicts.push({ new_index: Number(n) - 1, previous_call_id: before.call_id, previous_index: before.index,
        note: item.note.trim().slice(0, 300) });
    }
    await query('UPDATE calls SET conflicts=$2 WHERE id=$1 AND deleted_at IS NULL', [call.id, JSON.stringify(conflicts)]);
    return conflicts;
  } catch (err) {
    console.error('[consistency] check failed for call', callId, err?.message);
    return [];
  }
}
