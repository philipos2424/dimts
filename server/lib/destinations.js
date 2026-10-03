/**
 * Where Dimts may send sign-in codes and place calls. An allowlist, not a
 * blocklist: toll fraud and SMS pumping target countries a service forgot to
 * switch off, so anything not listed here is refused before Twilio is asked.
 * Keep the carrier's own geo permissions just as narrow; this is the layer we
 * control and test.
 */
import { isE164 } from './phone.js';

// Launch countries for signup (roadmap, 2 October 2026).
const NANP = ['1']; // US and Canada; non-US/CA NANP area codes are excluded below.
const UK = ['44'];
const EEA = [
  '43', '32', '359', '385', '357', '420', '45', '372', '358', '33', '49', '30', '36', '353', '39',
  '371', '370', '352', '356', '31', '48', '351', '40', '421', '386', '34', '46', // EU 27
  '354', '423', '47', // Iceland, Liechtenstein, Norway
];
const GULF = ['971', '966', '974', '973', '965', '968'];

const SIGNUP = [...NANP, ...UK, ...EEA, ...GULF];
// Ethiopia is a call destination, paid from credits, but not a signup market.
const CALLS = [...SIGNUP, '251'];

// NANP area codes outside the US and Canada. Caribbean numbers dial like
// domestic ones but bill internationally, which makes them the classic
// toll-fraud target. US territories (PR, USVI, Guam, NMI, AS) stay allowed.
const NANP_FOREIGN = new Set([
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721',
  '758', '767', '784', '809', '829', '849', '868', '869', '876',
]);

// Premium-rate and revenue-share ranges inside allowed countries.
const PREMIUM = [
  '1900', '1976',
  '449', '4470', '4487', '447624', // UK: 09 premium, 070 personal, 087 revenue share, Isle of Man mobile
  '49900', '49137', // Germany
  '3389', // France 089x
  '39899', '39892', // Italy
  '34803', '34806', '34807', '34905', // Spain
];

function countryCode(number, allowed) {
  const digits = number.slice(1);
  // Calling codes are prefix-free, so at most one entry can match.
  return allowed.find(code => digits.startsWith(code)) ?? null;
}

function permitted(number, allowed) {
  if (!isE164(number)) return false;
  const code = countryCode(number, allowed);
  if (!code) return false;
  if (code === '1' && (number.length !== 12 || NANP_FOREIGN.has(number.slice(2, 5)))) return false;
  return !PREMIUM.some(prefix => number.slice(1).startsWith(prefix));
}

/** Whether a number may sign up and receive a verification code. */
export const canSignUp = number => permitted(number, SIGNUP);

/** Whether a number may be rung, as the owner's handset or as the other party. */
export const canCall = number => permitted(number, CALLS);

/** Calling code of an allowed signup number, for per-country send limits. */
export const signupCountryCode = number => (canSignUp(number) ? countryCode(number, SIGNUP) : null);

/**
 * Whether recording a call with this number needs every person's explicit
 * consent rather than a notice. UAE and Saudi law are described as requiring
 * prior consent from all parties, with criminal penalties; the other Gulf
 * states are treated the same until counsel says otherwise.
 */
export const requiresExplicitConsent = number => isE164(number) && GULF.some(code => number.slice(1).startsWith(code));
