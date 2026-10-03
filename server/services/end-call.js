import { isCallSid, providerRest } from '../lib/carrier.js';
import { config } from '../config.js';
import { finishCall } from '../db/finish-call.js';
import { currentMonth } from '../lib/users.js';

const TERMINAL = new Set(['completed', 'failed', 'busy', 'no-answer', 'canceled']);
const ACTIVE = new Set(['queued', 'ringing', 'in-progress']);
function clientFor(call) {
  if (!isCallSid(call.twilio_call_sid) ||
      call.twilio_account_sid !== config.providerAccountSid) throw new Error('Invalid provider call ownership');
  return providerRest({ timeout: 5000, autoRetry: false });
}

// Telnyx cannot list calls by parent, so the dialled leg is the one Dimts
// recorded when that leg fetched its consent instructions.
async function dialledLegs(client, call) {
  if (config.carrier !== 'telnyx') return client.calls.list({ parentCallSid: call.twilio_call_sid, limit: 2 });
  if (!isCallSid(call.child_call_sid)) return [];
  const child = await client.calls(call.child_call_sid).fetch();
  return [{ ...child, parentCallSid: call.twilio_call_sid }];
}

export async function reconcileCall(call, { stop = false } = {}) {
  if (!call.twilio_call_sid) return { ended: false };
  const client = clientFor(call);
  const sid = call.twilio_call_sid;
  let parent = await client.calls(sid).fetch();
  if (stop && ACTIVE.has(parent.status)) {
    try { await client.calls(sid).update({ status: parent.status === 'in-progress' ? 'completed' : 'canceled' }); }
    catch (error) {
      // A natural hangup can race with this request. Only a provider-confirmed
      // terminal state makes an update error safe to ignore.
      parent = await client.calls(sid).fetch();
      if (!TERMINAL.has(parent.status)) throw error;
    }
    parent = await client.calls(sid).fetch();
  }
  if (!TERMINAL.has(parent.status)) return { ended: false };
  let children = await dialledLegs(client, call);
  if (children.length > 1 || children.some(child => child.parentCallSid !== sid)) throw new Error('Ambiguous provider call legs');
  if (stop) {
    for (const child of children) {
      if (ACTIVE.has(child.status)) await client.calls(child.sid).update({ status: child.status === 'in-progress' ? 'completed' : 'canceled' });
    }
    children = await dialledLegs(client, call);
  }
  if (children.length > 1 || children.some(child => child.parentCallSid !== sid)) throw new Error('Ambiguous provider call legs');
  if (children.some(child => !TERMINAL.has(child.status))) return { ended: false };
  const child = children[0];
  const duration = child?.status === 'completed' ? Number(child.duration) : 0;
  if (!Number.isSafeInteger(duration) || duration < 0) throw new Error('Invalid provider duration');
  // Child duration is the connected conversation. Parent duration includes
  // ringing/prompts and must not be substituted for the dial-done receipt.
  await finishCall(call, duration, child?.status ?? parent.status, currentMonth());
  return { ended: true };
}
