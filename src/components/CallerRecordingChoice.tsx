import { useState } from 'react';
import { View } from 'react-native';
import { setContactRecording, type RecordingPref } from '../api';
import { Button } from './Button';
import { Card } from './Card';
import { Txt } from './Txt';
import { space } from '../theme';

const HELP: Record<RecordingPref, string> = {
  default: 'Follows your setting for incoming calls.',
  record: 'Their incoming calls are always recorded and summarized.',
  skip: 'Their incoming calls are never recorded.',
};

/** Per-person override for incoming calls to the business number. */
export function CallerRecordingChoice({ contactId, value }: { contactId: string; value: RecordingPref }) {
  const [pref, setPref] = useState<RecordingPref>(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose(next: RecordingPref) {
    if (next === pref) return;
    setBusy(true); setError('');
    try { await setContactRecording(contactId, next); setPref(next); }
    catch { setError('Could not save. Try again.'); }
    finally { setBusy(false); }
  }

  return (
    <Card>
      <Txt size="caption" tone="muted" weight="bold">WHEN THEY CALL YOU</Txt>
      <Txt>{HELP[pref]}</Txt>
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Button compact variant={pref === 'record' ? 'primary' : 'quiet'} label="Record their calls" busy={busy} onPress={() => choose('record')} />
        <Button compact variant={pref === 'skip' ? 'primary' : 'quiet'} label="Don't record" busy={busy} onPress={() => choose('skip')} />
        <Button compact variant={pref === 'default' ? 'primary' : 'quiet'} label="Use my setting" busy={busy} onPress={() => choose('default')} />
      </View>
      {error ? <Txt size="caption" tone="danger">{error}</Txt> : null}
    </Card>
  );
}
