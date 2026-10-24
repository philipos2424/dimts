import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { getMe, patchIncomingRecording, type IncomingRecording } from '../api';
import { useApp } from '../AppContext';
import { Button } from './Button';
import { Section } from './Section';
import { Txt } from './Txt';
import { space } from '../theme';

/**
 * Which people calling your business number get recorded. Recording everyone is
 * the default; "Only people I choose" records a caller only after you mark them
 * Record on their page. Callers you do not record hear no notice and no audio is kept.
 */
export function IncomingRecordingSetting() {
  const { userPhone } = useApp();
  const [mode, setMode] = useState<IncomingRecording | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (userPhone) getMe().then(me => setMode(me.incoming_recording ?? 'all')).catch(() => {}); }, [userPhone]);

  async function choose(next: IncomingRecording) {
    if (next === mode) return;
    setBusy(true); setError('');
    try { await patchIncomingRecording(next); setMode(next); }
    catch { setError('Could not save. Try again.'); }
    finally { setBusy(false); }
  }

  if (mode === null) return null;
  return (
    <Section title="Recording incoming calls">
      <Txt tone="muted">
        {mode === 'all'
          ? 'Everyone who calls your business number is recorded and summarized.'
          : 'Only callers you mark Record are recorded. Open a person and tap Record their calls.'}
      </Txt>
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Button compact variant={mode === 'all' ? 'primary' : 'quiet'} label="Everyone" busy={busy} onPress={() => choose('all')} />
        <Button compact variant={mode === 'chosen' ? 'primary' : 'quiet'} label="Only people I choose" busy={busy} onPress={() => choose('chosen')} />
      </View>
      {error ? <Txt size="caption" tone="danger">{error}</Txt> : null}
    </Section>
  );
}
