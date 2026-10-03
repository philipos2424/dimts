// Find or create everything Dimts needs in a Telnyx account, then print the
// non-secret values to put in Vercel. Safe to run again: it reuses resources
// named "Dimts" and never buys a number or prints the API key.
// Usage (from the repo root, with TELNYX_API_KEY in .env):
//   node --env-file=.env server/scripts/telnyx-setup.js [--base-url=https://dimts.vercel.app]
process.env.CARRIER = 'telnyx';
const { telnyxRequest } = await import('../lib/telnyx-rest.js');

const NAME = 'Dimts';
const baseUrl = (process.argv.find(a => a.startsWith('--base-url='))?.split('=')[1] || 'https://dimts.vercel.app').replace(/\/+$/, '');
// Launch countries (US, CA, UK, EU/EEA, Gulf) plus Ethiopia as a destination.
const COUNTRIES = ['US', 'CA', 'GB', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'AE', 'SA', 'QA', 'BH', 'KW', 'OM', 'ET'];

const list = async path => { const data = await telnyxRequest('GET', path, { timeout: 20_000 }); return Array.isArray(data) ? data : []; };
const step = (label, value) => console.log(`  ${label.padEnd(28)} ${value}`);

try {
  if (!process.env.TELNYX_API_KEY) throw new Error('Add TELNYX_API_KEY to .env first (never paste it in chat).');
  console.log(`Setting up Telnyx for ${baseUrl}\n`);

  const users = await list('/organizations/users');
  const accountSid = users.length === 1 ? users[0].id : null;
  step('Account', accountSid ?? `not found (${users.length} users) — copy "User ID" from Account Settings`);

  let profile = (await list('/outbound_voice_profiles?page[size]=250')).find(p => p.name === NAME);
  if (!profile) {
    profile = await telnyxRequest('POST', '/outbound_voice_profiles', { json: {
      name: NAME, traffic_type: 'conversational', service_plan: 'global', enabled: true,
      whitelisted_destinations: COUNTRIES, daily_spend_limit_enabled: true, daily_spend_limit: '20.00',
    } });
    step('Outbound voice profile', `created (${COUNTRIES.length} countries, $20/day limit)`);
  } else step('Outbound voice profile', 'already exists, left unchanged');

  const appSettings = {
    friendly_name: NAME, active: true,
    voice_url: `${baseUrl}/twiml/incoming`, voice_method: 'post',
    status_callback: `${baseUrl}/webhooks/call-status`, status_callback_method: 'post',
    outbound: { outbound_voice_profile_id: profile.id },
  };
  let app = (await list('/texml_applications?page[size]=250')).find(a => a.friendlyName === NAME);
  if (app) { app = await telnyxRequest('PATCH', `/texml_applications/${app.id}`, { json: appSettings }); step('TeXML application', 'updated URLs'); }
  else { app = await telnyxRequest('POST', '/texml_applications', { json: appSettings }); step('TeXML application', 'created'); }

  const numbers = await list('/phone_numbers?page[size]=50');
  const ours = numbers.filter(n => n.connectionId === app.id);
  const free = numbers.filter(n => !n.connectionId);
  let number = ours[0]?.phoneNumber ?? null;
  if (!number && free.length === 1) {
    await telnyxRequest('PATCH', `/phone_numbers/${free[0].id}`, { json: { connection_id: app.id } });
    number = free[0].phoneNumber;
    step('Number', `${number} assigned to the Dimts application`);
  } else if (number) step('Number', `${number} (already assigned)`);
  else if (!numbers.length) step('Number', 'none — buy a voice number in the portal, then run this again');
  else step('Number', `not assigned: ${numbers.map(n => `${n.phoneNumber}${n.connectionId ? ' (in use elsewhere)' : ''}`).join(', ')}`);

  let verify = (await list('/verify_profiles?page[size]=250')).find(v => v.name === NAME);
  if (!verify) {
    const channel = { app_name: NAME, code_length: 6, whitelisted_destinations: COUNTRIES, default_verification_timeout_secs: 300 };
    verify = await telnyxRequest('POST', '/verify_profiles', { json: {
      name: NAME, language: 'en-US', sms: { ...channel, alpha_sender: NAME }, call: channel,
      daily_spend_limit_enabled: true, daily_spend_limit: 20,
    } });
    step('Verify profile', 'created (SMS + voice call, $20/day limit)');
  } else step('Verify profile', 'already exists, left unchanged');

  console.log('\nAdd these in Vercel (Production and Preview):\n');
  step('CARRIER', 'telnyx');
  step('TELNYX_ACCOUNT_SID', accountSid ?? '<User ID from Account Settings>');
  step('TELNYX_TEXML_APP_ID', app.id);
  step('TELNYX_VERIFY_PROFILE_ID', verify.id);
  step('TELNYX_NUMBER', number ?? '<your number, once assigned>');
  step('TELNYX_PUBLIC_KEY', 'portal → Account → Keys & Credentials → Public Key');
  step('TELNYX_API_KEY', '(already added)');
} catch (err) {
  console.error(`\nSetup stopped: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`);
  process.exitCode = 1;
}
