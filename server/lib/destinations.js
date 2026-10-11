/**
 * Where Dimts may send sign-in codes and place calls. An allowlist, not a
 * blocklist: toll fraud and SMS pumping target countries a service forgot to
 * switch off, so anything not listed here is refused before Twilio is asked.
 * Keep the carrier's own geo permissions just as narrow; this is the layer we
 * control and test.
 */
import { isE164 } from './phone.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

// Launch countries for signup. Ethiopia joined on 4 October 2026: Ethiopian
// businesses are core customers, not only people the diaspora calls.
const NANP = ['1']; // US and Canada; non-US/CA NANP area codes are excluded below.
const UK = ['44'];
const EEA = [
  '43', '32', '359', '385', '357', '420', '45', '372', '358', '33', '49', '30', '36', '353', '39',
  '371', '370', '352', '356', '31', '48', '351', '40', '421', '386', '34', '46', // EU 27
  '354', '423', '47', // Iceland, Liechtenstein, Norway
];
const GULF = ['971', '966', '974', '973', '965', '968'];

const ETHIOPIA = ['251'];

const SIGNUP = [...NANP, ...UK, ...EEA, ...GULF, ...ETHIOPIA];
const CALLS = [...SIGNUP];

// NANP area codes outside the US and Canada. Caribbean numbers dial like
// domestic ones but bill internationally, which makes them the classic
// toll-fraud target. US territories (PR, USVI, Guam, NMI, AS) stay allowed.
const NANP_FOREIGN = new Set([
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721',
  '758', '767', '784', '809', '829', '849', '868', '869', '876',
]);

// NANPA non-geographic services (including reserved expansion ranges), Canadian
// special services, and local 976 pay-per-call exchanges. US territories remain
// ordinary destinations. https://www.nanpa.com/index.php/numbering/5xx-nxx-codes
const NANP_SPECIAL = /^(?:456|500|52[1-9]|53[238]|54[2-579]|55[23468]|56[69]|57[78]|58[89]|6(?:00|22|33|44|55|66|77|88|99)|700|710|8(?:00|22|33|44|55|66|77|88)|900|911|976)/;
const ORDINARY_TYPES = new Set(['FIXED_LINE', 'MOBILE', 'FIXED_LINE_OR_MOBILE']);
// Full (max, not min) metadata supplies fixed/mobile ranges for EVERY country.
// Unknown, premium, shared-cost, toll-free, personal, pager, VoIP and other
// service types fail closed. Keep the pinned dependency's plans up to date.
// National administrations publish plans at https://www.itu.int/ITU-T/inr/nnp/
// UK 070/076/084/087/09: https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbering-data
// AT 090x/093x: https://www.rtr.at/TKP/service/rufnummernsuche/RufnummernsucheWeb931.de.html
// IE 15xx: https://www.comreg.ie/advice-information/premium-rate/about-premium-rate-services/

function countryCode(number, allowed) {
  const digits = number.slice(1);
  // Calling codes are prefix-free, so at most one entry can match.
  return allowed.find(code => digits.startsWith(code)) ?? null;
}

function permitted(number, allowed) {
  if (!isE164(number)) return false;
  const code = countryCode(number, allowed);
  if (!code) return false;
  if (code === '1') {
    const national = number.slice(2);
    return /^[2-9]\d{2}[2-9]\d{6}$/.test(national)
      && !NANP_FOREIGN.has(national.slice(0, 3)) && !NANP_SPECIAL.test(national)
      && !/^(?:900|950|958|959|976|[2-9]11)/.test(national.slice(3))
      && !['5551212', '5554334'].includes(national.slice(3));
  }
  // Preserve the existing Isle of Man exclusion; 07624 is classified mobile.
  if (number.startsWith('+447624')) return false;
  const parsed = parsePhoneNumberFromString(number);
  // Reject normalization (e.g. an international number with a domestic trunk 0).
  return parsed?.number === number && ORDINARY_TYPES.has(parsed.getType());
}

/** Whether a number may sign up and receive a verification code. */
export const canSignUp = number => permitted(number, SIGNUP);

/** Whether a number may be rung, as the owner's handset or as the other party. */
export const canCall = number => permitted(number, CALLS);

/** Calling code of an allowed signup number, for per-country send limits. */
export const signupCountryCode = number => (canSignUp(number) ? countryCode(number, SIGNUP) : null);

/** Calling code of a callable number, for pricing each call leg; null otherwise. */
export const callingCode = number => (canCall(number) ? countryCode(number, CALLS) : null);

// Germany (StGB §201) and Austria (StGB §120) make recording a private
// conversation without consent a crime; carrying on after a notice may not
// count as consent there, so these calls ask both people too.
const EXPLICIT_CONSENT = [...GULF, '49', '43'];

/**
 * Whether recording a call with this number needs every person's explicit
 * consent rather than a notice. UAE and Saudi law are described as requiring
 * prior consent from all parties, with criminal penalties; the other Gulf
 * states are treated the same until counsel says otherwise.
 */
export const requiresExplicitConsent = number => isE164(number) && EXPLICIT_CONSENT.some(code => number.slice(1).startsWith(code));
