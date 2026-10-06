import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { useApp } from './AppContext';
import { Button } from './components/Button';
import { Txt } from './components/Txt';
import { space, useTheme } from './theme';

/*
 * Optional lock: Face ID, fingerprint or the phone's passcode before Dimts
 * shows any call. Whoever holds an unlocked phone otherwise reads every
 * conversation. While locked, or whenever the app leaves the foreground, a
 * cover hides the content so the app switcher never shows a transcript.
 */
const KEY = 'dimts.appLock';
// Coming back within this time does not ask again (answering a call, a quick switch).
const GRACE_MS = 30_000;

let enabled = false;
let loaded = Platform.OS === 'web';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

if (Platform.OS !== 'web') {
  SecureStore.getItemAsync(KEY).then(value => { enabled = value === 'on'; }).catch(() => {})
    .finally(() => { loaded = true; emit(); });
}

export function useAppLockEnabled() {
  return useSyncExternalStore(subscribe, () => enabled, () => false);
}

/** Whether this phone can lock the app: native, with biometrics or at least a passcode set up. */
export async function appLockAvailable() {
  if (Platform.OS === 'web') return false;
  try { return (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE; }
  catch { return false; }
}

const unlock = (promptMessage: string) =>
  LocalAuthentication.authenticateAsync({ promptMessage, cancelLabel: 'Cancel' }).then(r => r.success).catch(() => false);

/** Turning the lock on proves the owner can unlock first, so nobody is locked out by surprise. */
export async function setAppLockEnabled(next: boolean) {
  if (next && !(await unlock('Turn on the Dimts lock'))) return false;
  await SecureStore.setItemAsync(KEY, next ? 'on' : 'off');
  enabled = next; emit();
  return true;
}

export function AppLockGate() {
  const { c } = useTheme();
  const { userPhone, ready: appReady } = useApp();
  const isOn = useSyncExternalStore(subscribe, () => enabled && !!userPhone, () => false);
  // Both the lock setting and the saved sign-in must be restored before
  // deciding; otherwise a restored session looks like a fresh sign-in.
  const ready = useSyncExternalStore(subscribe, () => loaded, () => true) && appReady;
  const [locked, setLocked] = useState(true);
  const [covered, setCovered] = useState(false);
  const [asking, setAsking] = useState(false);
  const leftAt = useRef<number | null>(null);
  const prompting = useRef(false);

  const ask = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true; setAsking(true);
    const ok = await unlock('Unlock Dimts');
    prompting.current = false; setAsking(false);
    if (ok) { setLocked(false); leftAt.current = null; }
  }, []);

  // Locked on every cold start while the lock is on. Turning it on, or signing
  // in with a code, has just proven who is holding the phone: no prompt then.
  const wasOn = useRef<boolean | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (wasOn.current === false && isOn) setLocked(false);
    wasOn.current = isOn;
  }, [ready, isOn]);
  useEffect(() => { if (ready && isOn && locked && wasOn.current) ask(); }, [ready, isOn, locked, ask]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        setCovered(true);
        // The system prompt itself makes the app inactive; that is not leaving.
        if (!prompting.current && leftAt.current === null) leftAt.current = Date.now();
        return;
      }
      setCovered(false);
      if (enabled && leftAt.current !== null && Date.now() - leftAt.current > GRACE_MS) setLocked(true);
      else leftAt.current = null;
    });
    return () => subscription.remove();
  }, []);

  if (Platform.OS === 'web' || !userPhone) return null;
  // Before the setting is read, hide content rather than flash it.
  const showLock = !ready || (isOn && locked);
  if (!showLock && !(isOn && covered)) return null;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.bg, zIndex: 1000, elevation: 1000,
      alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl }]}>
      <Txt size="screen" tone="brand">ድምፅ</Txt>
      {showLock && ready && <>
        <Txt tone="muted" style={{ textAlign: 'center' }}>Dimts is locked to keep your calls private.</Txt>
        <Button label="Unlock" busy={asking} onPress={ask} />
      </>}
    </View>
  );
}
