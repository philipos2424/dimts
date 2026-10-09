// Give an account any number of monthly minutes, replacing its plan's (or
// trial's) allowance, or remove the grant. For the founder's own phones and
// the people they choose; granted minutes are not limited by the free pool.
//   node --env-file=.env server/scripts/grant-minutes.js +14155550100 1000
//   node --env-file=.env server/scripts/grant-minutes.js +14155550100 off
import { isE164 } from '../lib/phone.js';
import { closeDatabase, queryOne } from '../db/pool.js';
import { audit } from '../lib/audit.js';

const [phone, amount] = process.argv.slice(2);
try {
  if (!isE164(phone ?? '') || !(amount === 'off' || /^\d{1,6}$/.test(amount ?? ''))) {
    throw new Error('Usage: grant-minutes.js <phone-e164> <minutes-per-month | off>');
  }
  const minutes = amount === 'off' ? null : Number(amount);
  const user = await queryOne(`UPDATE users SET minutes_override=$2 WHERE phone=$1 AND deleted_at IS NULL
    RETURNING id, tier, minutes_override`, [phone, minutes]);
  if (!user) throw new Error(`No account for ${phone}. Sign in on the app first, then run this again.`);
  await audit({ userId: user.id, action: 'minutes_granted', targetType: 'minutes', targetId: String(minutes ?? 'off') });
  console.log(minutes == null
    ? `${phone}: grant removed; back to the ${user.tier} plan's minutes.`
    : `${phone}: ${minutes} minutes a month (plan ${user.tier}). Used minutes this month still count.`);
} catch (err) { console.error(err.message); process.exitCode = 1; }
finally { await closeDatabase(); }
