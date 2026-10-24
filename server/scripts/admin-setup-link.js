// Make a one-time operator setup link: a fresh secret, the value to put in
// ADMIN_SETUP_TOKEN, and the address to open. The link works once and expires.
// Nothing is stored or sent; the secret only exists in this output.
//   node server/scripts/admin-setup-link.js +14155550100        (valid for 24 hours)
//   node server/scripts/admin-setup-link.js +14155550100 2      (valid for 2 hours)
import { newSetupToken, SETUP_MAX_HOURS } from '../lib/admin-setup.js';

const [phone, hoursText] = process.argv.slice(2);
try {
  if (!phone || (hoursText !== undefined && !/^\d{1,3}(\.\d+)?$/.test(hoursText))) {
    throw new Error(`Usage: admin-setup-link.js <staff-phone-e164> [hours, at most ${SETUP_MAX_HOURS}]`);
  }
  const { secret, expiresAt, env } = newSetupToken(phone, { hours: hoursText === undefined ? 24 : Number(hoursText) });
  const site = (process.env.PUBLIC_BASE_URL || 'https://dimts.vercel.app').replace(/\/+$/, '');
  console.log(`1. In Vercel (Production) set, then redeploy:\n   ADMIN_SETUP_TOKEN=${env}\n`);
  console.log(`2. Open this before ${expiresAt.toISOString()} and press "Set up Face ID or fingerprint":\n   ${site}/admin/#setup=${secret}\n`);
  console.log('3. Once you are in, delete ADMIN_SETUP_TOKEN. The link cannot be used a second time either way.');
} catch (err) { console.error(err.message); process.exitCode = 1; }
