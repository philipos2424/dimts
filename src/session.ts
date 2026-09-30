import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'dimts.session';
// Web login lasts for this tab; native tokens use the OS keychain/keystore.
export async function readSession(): Promise<string | null> {
  return Platform.OS === 'web' ? sessionStorage.getItem(KEY) : SecureStore.getItemAsync(KEY);
}
export async function storeSession(token: string | null) {
  if (Platform.OS === 'web') {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } else if (token) await SecureStore.setItemAsync(KEY, token);
  else await SecureStore.deleteItemAsync(KEY);
}
