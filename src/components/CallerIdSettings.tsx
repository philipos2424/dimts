import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { ApiError, getMe, startCallerId, stopCallerId, verifyCallerId } from '../api';
import { useApp } from '../AppContext';
import { Button } from './Button';
import { Section } from './Section';
import { Txt } from './Txt';
import { radius, space, type, useTheme } from '../theme';

/**
 * Outgoing calls show the owner's own mobile instead of the Dimts number, once
 * the carrier has verified it with a code. People recognise who is calling;
 * calls they return go straight to that mobile and are not recorded.
 */
export function CallerIdSettings() {
  const { c } = useTheme();
  const { userPhone } = useApp();
  const [on, setOn] = useState<boolean | null>(null);
  const [step, setStep] = useState<'idle' | 'code'>('idle');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => { if (userPhone) getMe().then(me => setOn(!!me.caller_id)).catch(() => {}); }, [userPhone]);

  async function run(work: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await work(); } catch (err) { setMessage(err instanceof ApiError ? err.message : 'Something went wrong. Try again.'); }
    finally { setBusy(false); }
  }
  const send = (method: 'call' | 'sms') => run(async () => {
    const result = await startCallerId(method);
    if (result.status === 'verified') { setOn(true); setStep('idle'); return; }
    setStep('code');
    setMessage(method === 'call' ? 'Answer the call: it reads out your code.' : 'Enter the code we texted you.');
  });
  const confirm = () => run(async () => { await verifyCallerId(code.trim()); setOn(true); setStep('idle'); setCode(''); });
  const turnOff = () => run(async () => { await stopCallerId(); setOn(false); });

  if (on === null) return null;
  return (
    <Section title="Caller ID">
      <Txt>{on ? `People you call see ${userPhone}.` : 'People you call see your Dimts business number.'}</Txt>
      <Txt size="caption" tone="muted">
        Showing your own mobile helps people answer. If they call back, it rings your mobile directly and is not recorded.
      </Txt>
      {on ? <Button compact variant="quiet" label="Show my Dimts number instead" busy={busy} onPress={turnOff} />
        : step === 'idle' ? (
          <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
            <Button compact label="Show my number: call me with a code" busy={busy} onPress={() => send('call')} />
            <Button compact variant="quiet" label="Text me the code" disabled={busy} onPress={() => send('sms')} />
          </View>
        ) : (
          <View style={{ gap: space.sm }}>
            <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" placeholder="Code"
              placeholderTextColor={c.faint} accessibilityLabel="Verification code" maxLength={10}
              style={{ color: c.ink, backgroundColor: c.card, borderRadius: radius.md, padding: space.md, fontSize: type.body }} />
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button compact label="Confirm" busy={busy} disabled={!/^\d{4,10}$/.test(code.trim())} onPress={confirm} />
              <Button compact variant="quiet" label="Cancel" onPress={() => { setStep('idle'); setCode(''); setMessage(''); }} />
            </View>
          </View>
        )}
      {message ? <Txt size="caption" tone="muted">{message}</Txt> : null}
    </Section>
  );
}
