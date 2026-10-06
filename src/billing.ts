import { Platform } from 'react-native';
import type { Lang } from './i18n';
import type { Price } from './api';

/**
 * Purchases happen on the web through Polar. App Store and Play rules require
 * their own billing for digital purchases in most countries, so native builds
 * show plan and balance only, with no prices or buy buttons.
 */
export const canBuyHere = Platform.OS === 'web';

const locale = (lang: Lang) => (lang === 'am' ? 'am-ET' : undefined);

/** £16, €19, AED 69: whole amounts drop the cents. */
export function formatPrice({ amount, currency }: Price, lang: Lang = 'en') {
  const value = amount / 100;
  try {
    return new Intl.NumberFormat(locale(lang), { style: 'currency', currency: currency.toUpperCase(),
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency.toUpperCase()} ${value.toFixed(Number.isInteger(value) ? 0 : 2)}`;
  }
}

/** Credits are US cents; show them as dollars so the value is obvious anywhere. */
export const formatCredits = (cents: number, lang: Lang = 'en') => formatPrice({ amount: cents, currency: 'usd' }, lang).replace(/^\$/, 'US$');

export const COUNTRY_NAMES: Record<string, { en: string; am: string }> = {
  '971': { en: 'United Arab Emirates', am: 'የተባበሩት አረብ ኤምሬቶች' },
  '966': { en: 'Saudi Arabia', am: 'ሳዑዲ አረቢያ' },
  '974': { en: 'Qatar', am: 'ኳታር' },
  '973': { en: 'Bahrain', am: 'ባህሬን' },
  '965': { en: 'Kuwait', am: 'ኩዌት' },
  '968': { en: 'Oman', am: 'ኦማን' },
  '251': { en: 'Ethiopia', am: 'ኢትዮጵያ' },
};
