// Import an already-owned, already-routed number. Never buys or reroutes one.
// node --env-file=.env server/scripts/stock-number.js +14754053943
import { twilioClient } from '../lib/twilio-client.js';
import { config } from '../config.js';
import { isE164 } from '../lib/phone.js';
import { query, closeDatabase } from '../db/pool.js';

const [phone] = process.argv.slice(2);
try {
  if (!isE164(phone)) throw new Error('Usage: stock-number.js <owned-number-e164>');
  const voiceUrl = `${config.publicBaseUrl}/twiml/incoming`;
  if (new URL(voiceUrl).protocol !== 'https:') throw new Error('PUBLIC_BASE_URL requires HTTPS');
  const client = twilioClient({ timeout: 15_000 });
  const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: phone, limit: 1 });
  const number = numbers[0];
  if (!number || number.phoneNumber !== phone || !number.capabilities?.voice) throw new Error('Number is not voice-capable and owned by this Twilio account');
  if (number.voiceApplicationSid || number.voiceUrl !== voiceUrl || number.voiceMethod !== 'POST') {
    throw new Error('Configure this number to POST directly to the current /twiml/incoming URL before stocking it');
  }
  await query(`INSERT INTO agent_number_pool(phone,provider_sid,voice_url) VALUES($1,$2,$3)
    ON CONFLICT(phone) DO UPDATE SET provider_sid=EXCLUDED.provider_sid,
      voice_url=EXCLUDED.voice_url, enabled=true, checked_at=now()`, [phone, number.sid, voiceUrl]);
  console.log(`Stocked existing business number ${phone}. No number purchased or webhook changed.`);
} catch (err) { console.error(err.message); process.exitCode = 1; }
finally { await closeDatabase(); }
