// Buy one business number into the pool, the same way an empty-pool claim does,
// and show how the carrier has it routed. Spends money: about $1 a month per number.
// node --env-file=.env server/scripts/buy-number.js +14155550100   (area code / country taken from this phone)
import { config } from '../config.js';
import { isE164 } from '../lib/phone.js';
import { telnyxRequest } from '../lib/telnyx-rest.js';
import { buyPoolNumber } from '../services/provision-number.js';
import { incomingVoiceUrl } from '../db/claim-number.js';
import { closeDatabase } from '../db/pool.js';

const [ownerPhone = '+12125550100'] = process.argv.slice(2);
try {
  if (!isE164(ownerPhone)) throw new Error('Usage: buy-number.js [phone-e164-to-match]');
  const voiceUrl = incomingVoiceUrl();
  if (!voiceUrl) throw new Error('PUBLIC_BASE_URL must be the HTTPS production origin');
  const phone = await buyPoolNumber({ userId: 'operator', ownerPhone, voiceUrl });
  if (!phone) throw new Error('Nothing bought (NUMBER_AUTOBUY is off)');
  console.log(`Bought ${phone} into the pool, routed to ${voiceUrl}`);
  if (config.carrier === 'telnyx') {
    const [number] = await telnyxRequest('GET', `/phone_numbers?filter[phone_number]=${encodeURIComponent(phone)}`, { timeout: 15_000 });
    console.log(`Telnyx status: ${number?.status}; on the Dimts TeXML app: ${number?.connectionId === config.telnyxTexmlAppId}`);
  }
} catch (err) { console.error(err.message); process.exitCode = 1; }
finally { await closeDatabase(); }
