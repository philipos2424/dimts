import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { endOtherSessions, endSession, getSessions, type SignedInDevice } from '../api';
import { useApp } from '../AppContext';
import { Button } from './Button';
import { Section } from './Section';
import { Txt } from './Txt';
import { radius, space, useTheme } from '../theme';

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/**
 * Every device signed in to this account. Someone who takes over the phone
 * number (a SIM swap) signs in with a valid code; this is where the owner sees
 * and ends that session.
 */
export function SignedInDevices() {
  const { c } = useTheme();
  const { signedOut } = useApp();
  const [devices, setDevices] = useState<SignedInDevice[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => getSessions().then(setDevices).catch(() => setError('Unable to load your devices.')), []);
  useEffect(() => { load(); }, [load]);

  async function run(key: string, work: () => Promise<unknown>) {
    setBusy(key); setError('');
    try { await work(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to sign out that device.'); }
    finally { setBusy(''); }
  }

  const others = devices?.filter(d => !d.current) ?? [];
  return (
    <Section title="Signed-in devices">
      <Txt tone="muted">Anyone signed in here can read your calls. Sign out anything you don't recognise.</Txt>
      {devices?.map(device => (
        <View key={device.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md,
          backgroundColor: c.card, borderRadius: radius.md, padding: space.md }}>
          <View style={{ flex: 1, gap: space.xs }}>
            <Txt weight="bold">{device.device_name || 'Unknown device'}{device.current ? ' · this device' : ''}</Txt>
            <Txt tone="muted" size="caption">Signed in {when(device.created_at)} · last active {when(device.last_seen_at ?? device.created_at)}</Txt>
          </View>
          {!device.current && (
            <Button compact variant="quiet" label="Sign out" busy={busy === device.id}
              onPress={() => run(device.id, () => endSession(device.id))} />
          )}
        </View>
      ))}
      {others.length > 1 && (
        <Button variant="quiet" label="Sign out all other devices" busy={busy === 'others'}
          onPress={() => run('others', () => endOtherSessions())} />
      )}
      {devices && (
        <Button variant="danger" label="Sign out everywhere, including here" busy={busy === 'all'}
          onPress={() => run('all', async () => { await endOtherSessions(true); signedOut(); })} />
      )}
      {!!error && <Txt tone="danger">{error}</Txt>}
    </Section>
  );
}
