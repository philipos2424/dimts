import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Pressable, Switch, View } from 'react-native';
import { disconnectMiniMe, getMiniMeStatus, setMiniMeAutoSend, startMiniMeLink, type MiniMeStatus } from '../api';
import { space } from '../theme';
import { Txt } from './Txt';

/** Link MiniMe so promises like "I'll send it on Telegram" are sent for the owner. */
export function MiniMeConnection() {
  const [status, setStatus] = useState<MiniMeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = useCallback(() => getMiniMeStatus().then(setStatus).catch(() => {}), []);
  useEffect(() => {
    refresh();
    // Linking finishes in Telegram; pick up the result when the owner comes back.
    const sub = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => sub.remove();
  }, [refresh]);
  async function run(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await work(); }
    catch { setMessage('That did not finish. Please try again.'); }
    finally { setBusy(false); }
  }
  if (!status?.available) return null;
  return <View style={{ gap: space.sm, padding: space.md }}>
    <Txt weight="bold">MiniMe on Telegram</Txt>
    <Txt tone="muted">{status.reviewed_file_actions ? 'Open a finished call to find file requests. Choose a MiniMe file and Telegram recipient, review the details, then approve the send.' : 'When you tell a caller “I’ll send it to you on Telegram”, MiniMe sends it from your business after the call, using your catalog, and tells you in Telegram. Callers who have never messaged your business on Telegram get it as soon as they do.'}</Txt>
    {status.linked ? <>
      <Txt>Connected to {status.business_name || 'your MiniMe business'}</Txt>
      {!status.reviewed_file_actions && <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Txt style={{ flex: 1 }}>Send Telegram promises automatically</Txt>
        <Switch value={!!status.auto_send} disabled={busy} accessibilityLabel="Send Telegram promises automatically"
          onValueChange={value => run(async () => setStatus(await setMiniMeAutoSend(value)))} />
      </View>}
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(async () => setStatus(await disconnectMiniMe()))}>
        <Txt tone="accent">Disconnect MiniMe</Txt>
      </Pressable>
    </> : <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(async () => {
      const { url } = await startMiniMeLink();
      await Linking.openURL(url);
      setMessage('Tap Start in Telegram, then come back here.');
    })}>
      <Txt tone="accent">{busy ? 'Opening Telegram…' : 'Connect MiniMe'}</Txt>
    </Pressable>}
    {!!message && <Txt tone="muted">{message}</Txt>}
  </View>;
}
