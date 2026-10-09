import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { appLockAvailable, setAppLockEnabled, useAppLockEnabled } from '../AppLock';
import { Section } from './Section';
import { Txt } from './Txt';
import { space, useTheme } from '../theme';

export function AppLockSetting() {
  const { c } = useTheme();
  const enabled = useAppLockEnabled();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { appLockAvailable().then(setAvailable); }, []);
  if (available === null) return null;

  async function toggle(next: boolean) {
    setError('');
    try { if (!(await setAppLockEnabled(next))) setError('The lock was not turned on because unlocking did not succeed.'); }
    catch { setError('Unable to change the lock. Try again.'); }
  }

  return (
    <Section title="App lock">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm }}>
        <Txt tone="muted" style={{ flex: 1 }}>
          {available
            ? 'Ask for Face ID, fingerprint or your phone passcode when Dimts opens, and hide calls in the app switcher.'
            : 'Set up Face ID, a fingerprint or a passcode on this phone to lock Dimts.'}
        </Txt>
        <Switch value={enabled} disabled={!available} onValueChange={toggle}
          trackColor={{ false: c.line, true: c.ok }} thumbColor={c.ink} accessibilityLabel="Lock Dimts" />
      </View>
      {!!error && <Txt tone="danger">{error}</Txt>}
    </Section>
  );
}
