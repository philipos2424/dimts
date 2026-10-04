import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'dimts.session';
// Web keeps the sign-in across reloads, tabs and home-screen launches until
// sign-out or the server's 30-day expiry; native uses the OS keychain/keystore.
function webStore() {
  try { return window.localStorage; } catch { return null; }
}
export async function readSession(): Promise<string | null> {
  if (Platform.OS !== 'web') return SecureStore.getItemAsync(KEY);
  const store = webStore();
  // Sessions from before this change lived in sessionStorage; carry them over.
  const legacy = (() => { try { return window.sessionStorage.getItem(KEY); } catch { return null; } })();
  if (legacy) {
    store?.setItem(KEY, legacy);
    try { window.sessionStorage.removeItem(KEY); } catch {}
  }
  return store?.getItem(KEY) ?? legacy;
}
export async function storeSession(token: string | null) {
  if (Platform.OS === 'web') {
    const store = webStore();
    if (token) store?.setItem(KEY, token);
    else store?.removeItem(KEY);
    try { window.sessionStorage.removeItem(KEY); } catch {}
  } else if (token) await SecureStore.setItemAsync(KEY, token);
  else await SecureStore.deleteItemAsync(KEY);
}
