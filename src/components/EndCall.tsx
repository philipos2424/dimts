import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { endCall } from '../api';
import { Txt } from './Txt';
import { color, space } from '../theme';

export function EndCall({ id, onEnded }: { id: string; onEnded: () => void }) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function stop() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await endCall(id); onEnded(); }
    catch { setError('Unable to confirm the call ended. Hang up on your phone, then try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <View style={{ gap: space.sm }}>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
      onPress={() => { void stop(); }} style={{ backgroundColor: color.madder, padding: space.md, minHeight: 48 }}>
      <Txt>{busy ? 'Ending call…' : 'End call'}</Txt>
    </Pressable>
    {error ? <Txt accessibilityRole="alert">{error}</Txt> : null}
  </View>;
}
