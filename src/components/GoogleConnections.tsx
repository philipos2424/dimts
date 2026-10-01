import { useEffect, useState } from 'react';
import { Linking, Pressable, TextInput, View } from 'react-native';
import { confirmGoogleConnection, disconnectGoogle, getGoogleStatus, startGoogleConnection,
  type GoogleKind, type GoogleStatus } from '../api';
import { color, space } from '../theme';
import { Txt } from './Txt';

export function GoogleConnections() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => {
    let mounted = true;
    getGoogleStatus().then(s => { if (mounted) setStatus(s); })
      .catch(() => { if (mounted) setMessage('Could not load Google connections.'); });
    return () => { mounted = false; };
  }, []);
  async function run(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await work(); setStatus(await getGoogleStatus()); }
    catch { setMessage('Connection did not finish. Refresh status or start again.'); }
    finally { setBusy(false); }
  }
  async function connect(kind: GoogleKind) {
    const { url } = await startGoogleConnection(kind);
    await Linking.openURL(url);
    setMessage('After Google consent, paste the one-time connection code below.');
  }
  return <View style={{ gap: space.sm, padding: space.md }}>
    <Txt weight="bold">Google connections</Txt>
    <Txt tone="muted">Connect your primary calendar for reviewed meeting bookings. Connect Gmail to create drafts.</Txt>
    <Txt tone="muted">Google’s Gmail permission includes managing drafts and sending email. Dimts will only create drafts for you to review. Calendar permission allows managing events in calendars you own.</Txt>
    {status && !status.configured && <Txt tone="muted">Google authorization is awaiting server setup.</Txt>}
    {(['calendar', 'gmail'] as GoogleKind[]).map(kind => {
      const connected = status?.connections.some(c => c.kind === kind);
      return <View key={kind} style={{ flexDirection: 'row', gap: space.md }}>
        <Txt style={{ flex: 1 }}>{kind === 'calendar' ? 'Google Calendar' : 'Gmail'}: {connected ? 'Connected' : 'Not connected'}</Txt>
        <Pressable accessibilityRole="button" disabled={busy || !status?.configured}
          onPress={() => run(() => connected ? disconnectGoogle(kind) : connect(kind))}>
          <Txt tone="accent">{connected ? 'Disconnect' : 'Connect'}</Txt>
        </Pressable>
      </View>;
    })}
    <TextInput value={code} onChangeText={setCode} placeholder="One-time connection code" placeholderTextColor={color.line}
      accessibilityLabel="One-time Google connection code" autoCapitalize="none" autoCorrect={false}
      style={{ color: color.parchment, borderColor: color.line, borderWidth: 1, padding: space.sm }} />
    <Pressable accessibilityRole="button" disabled={busy || !/^[a-f0-9]{64}$/.test(code.trim())}
      onPress={() => run(async () => { await confirmGoogleConnection(code.trim()); setCode(''); setMessage('Google connected.'); })}>
      <Txt tone="accent">{busy ? 'Working…' : 'Finish connection'}</Txt>
    </Pressable>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(async () => {})}>
      <Txt tone="accent">Refresh connection status</Txt>
    </Pressable>
    {!!message && <Txt tone="muted">{message}</Txt>}
  </View>;
}
