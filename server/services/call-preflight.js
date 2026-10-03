import { providerRest } from '../lib/carrier.js';
import { config } from '../config.js';
import { HttpError } from '../lib/users.js';

// Trial restrictions apply to both dial-through legs. Check before reserving
// minutes or ringing the owner, rather than discovering rejection in <Dial>.
export async function checkCallDestination(userPhone, destination) {
  // Trial restrictions are a Twilio concept; Telnyx enforces its own outbound profile.
  if (config.carrier === 'telnyx') return;
  let account, verified;
  try {
    const client = providerRest({ timeout: 5000, autoRetry: false });
    account = await client.api.v2010.accounts(config.twilioAccountSid).fetch();
    if (account.status !== 'active' || !['Trial', 'Full'].includes(account.type)) {
      throw new Error('Provider account not ready');
    }
    if (account.type === 'Full') return;
    verified = await Promise.all([userPhone, destination].map(phoneNumber =>
      client.outgoingCallerIds.list({ phoneNumber, limit: 1 })
        .then(rows => rows.some(row => row.phoneNumber === phoneNumber))));
  } catch {
    throw new HttpError(503, 'call_preflight_unavailable', 'Unable to check the calling provider. No call was started.');
  }
  if (!verified[0]) throw new HttpError(403, 'handset_trial_number_required',
    'Your answering phone must be verified in the connected Twilio trial account before this call can start.');
  if (!verified[1]) throw new HttpError(403, 'destination_trial_number_required',
    'The other phone must be verified in the connected Twilio trial account. Add it under Verified Caller IDs, then try again. No call was started.');
}
