import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { finishSocialSignIn, type SocialFinish, type SocialProvider, startSocialSignIn } from './api';

// Sign in with Google, Apple, Telegram or ChatGPT. The provider page opens in
// a browser; the server sends back a one-time ticket that only this app can
// redeem, because redeeming it needs the verifier made here.

export const PROVIDER_LABELS: Record<SocialProvider, string> = {
  apple: 'Apple', google: 'Google', telegram: 'Telegram', chatgpt: 'ChatGPT',
};
const WEB_VERIFIER = 'dimts_social_verifier';
const NATIVE_VERIFIER = 'dimts.social.verifier';
let nativeSignInActive = false;

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
async function pkcePair() {
  const verifier = hex(Crypto.getRandomBytes(32));
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 });
  return { verifier, challenge: digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
}

function failure(code: string) {
  return new Error(code === 'cancelled' ? 'Sign-in was cancelled.' : 'Sign-in did not complete. Try again or use your phone number.');
}

/** Resolves null when the person closes the browser. On web the page navigates away instead. */
export async function socialSignIn(provider: SocialProvider): Promise<SocialFinish | null> {
  const { verifier, challenge } = await pkcePair();
  if (Platform.OS === 'web') {
    const { url } = await startSocialSignIn(provider, challenge, `${window.location.origin}/onboarding`);
    try { window.sessionStorage.setItem(WEB_VERIFIER, verifier); }
    catch { throw new Error('Your browser could not save this sign-in. Enable site storage or use your phone number.'); }
    window.location.assign(url);
    return new Promise<null>(() => {});
  }
  const returnTo = Linking.createURL('onboarding');
  const { url } = await startSocialSignIn(provider, challenge, returnTo);
  await SecureStore.setItemAsync(NATIVE_VERIFIER, JSON.stringify({ verifier, createdAt: Date.now() }));
  nativeSignInActive = true;
  try {
    const result = await WebBrowser.openAuthSessionAsync(url, returnTo);
    if (result.type !== 'success') return null;
    return await finishNativeCallback(result.url, verifier);
  } finally {
    nativeSignInActive = false;
    await SecureStore.deleteItemAsync(NATIVE_VERIFIER);
  }
}

async function finishNativeCallback(url: string, verifier: string): Promise<SocialFinish | null> {
  const { queryParams } = Linking.parse(url);
  const error = queryParams?.social_error, ticket = queryParams?.social;
  if (typeof error === 'string') { if (error === 'cancelled') return null; throw failure(error); }
  if (typeof ticket !== 'string') throw failure('failed');
  return finishSocialSignIn(ticket, verifier);
}

/** Resume a web redirect or a native callback that relaunched the app after OS termination. */
export async function resumeSocialSignIn(): Promise<SocialFinish | null> {
  if (Platform.OS !== 'web') {
    if (nativeSignInActive) return null;
    const url = await Linking.getInitialURL();
    if (!url) return null;
    const { queryParams } = Linking.parse(url);
    if (!queryParams?.social && !queryParams?.social_error) return null;
    const stored = await SecureStore.getItemAsync(NATIVE_VERIFIER);
    await SecureStore.deleteItemAsync(NATIVE_VERIFIER);
    let pending: { verifier?: string; createdAt?: number } = {};
    try { pending = JSON.parse(stored ?? '{}'); } catch { /* expired below */ }
    if (!pending || typeof pending.verifier !== 'string' || typeof pending.createdAt !== 'number' ||
      !Number.isFinite(pending.createdAt) || pending.createdAt > Date.now() + 300_000 ||
      Date.now() - pending.createdAt > 30 * 60_000) throw new Error('Sign-in expired. Try again.');
    return finishNativeCallback(url, pending.verifier);
  }
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const ticket = params.get('social'), error = params.get('social_error');
  if (!ticket && !error) return null;
  window.history.replaceState(null, '', window.location.pathname);
  let verifier: string | null = null;
  try { verifier = window.sessionStorage.getItem(WEB_VERIFIER); window.sessionStorage.removeItem(WEB_VERIFIER); } catch { /* treated as expired */ }
  if (error) { if (error === 'cancelled') return null; throw failure(error); }
  if (!ticket || !verifier) throw new Error('Sign-in expired. Try again.');
  return finishSocialSignIn(ticket, verifier);
}
