/**
 * Assign an agent number to a user.
 *
 *   node --env-file=../.env scripts/assign-number.js +14155550000 +14155551111
 *
 * The Twilio number's Voice webhook must separately be pointed at
 * $PUBLIC_BASE_URL/twiml/incoming (POST) in the Twilio console.
 */
import { assignAgentNumber } from '../db/agent-numbers.js';

const [userPhone, agentNumber] = process.argv.slice(2);

if (!userPhone || !agentNumber) {
  console.error('Usage: assign-number.js <user-phone-e164> <agent-number-e164>');
  process.exit(1);
}

try {
  const user = await assignAgentNumber(userPhone, agentNumber);
  console.log(`Assigned ${user.agent_number} to ${user.phone} (${user.id})`);
  console.log(
    `Now set that number's Voice webhook to ${process.env.PUBLIC_BASE_URL}/twiml/incoming`
  );
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
