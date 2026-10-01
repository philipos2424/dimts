export function callNotes(call) {
  const lines = ['Dimts call notes', `Call ID: ${call.id}`, `Date: ${new Date(call.created_at).toISOString()}`,
    `Contact: ${call.contact_name || call.destination}`, `Phone: ${call.destination}`,
    `Direction: ${call.direction}`, `Status: ${call.status}`,
    `Duration: ${call.duration_sec == null ? 'Not available' : `${call.duration_sec} seconds`}`,
    '', 'Transcripts and AI notes may contain errors. Check the recording before relying on names, dates or commitments.'];
  function section(title, text) { if (text) lines.push('', title, text); }
  section('Summary', call.summary);
  section('Key points', Array.isArray(call.key_points) ? call.key_points.map(p => `- ${p}`).join('\n') : '');
  section('Action items (AI suggestions; not proof of completed actions)', Array.isArray(call.action_items)
    ? call.action_items.map(a => `- ${a.task}${a.owner ? ` (owner: ${a.owner})` : ''}`).join('\n') : '');
  section('Suggested next steps', Array.isArray(call.next_moves) ? call.next_moves.map(p => `- ${p}`).join('\n') : '');
  section('Transcript', call.transcript || 'No transcript is available for this call.');
  if (call.status !== 'ready') lines.push('', 'These notes are incomplete: the call has not reached the ready state.');
  return lines.join('\n') + '\n';
}
