import { createHash, timingSafeEqual } from 'node:crypto';
import { isE164 } from './phone.js';
import { HttpError } from './users.js';

/**
 * App Store and Play reviewers cannot receive our SMS codes or answer our
 * calls. One fixed number and code sign them into a sample account instead.
 * Off unless both values are set; the number never reaches the carrier.
 */
export function reviewDemoPhone() {
  const phone = process.env.REVIEW_DEMO_PHONE?.trim();
  const code = process.env.REVIEW_DEMO_CODE?.trim();
  return isE164(phone) && /^\d{6,10}$/.test(code ?? '') ? phone : null;
}

export const isReviewDemo = phone => !!phone && phone === reviewDemoPhone();

export function checkReviewDemoCode(code) {
  const digest = value => createHash('sha256').update(String(value)).digest();
  return typeof code === 'string' && timingSafeEqual(digest(code), digest(process.env.REVIEW_DEMO_CODE.trim()));
}

/** Refuse anything that would make the carrier ring or text the demo number. */
export function refuseForReviewDemo(user) {
  if (isReviewDemo(user?.phone)) {
    throw new HttpError(403, 'review_demo', 'This is a sample account for app review, so it cannot use real phone lines.');
  }
}
