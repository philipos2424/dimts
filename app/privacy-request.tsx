import { useState } from 'react';
import { ScrollView, TextInput } from 'react-native';
import { startPrivacyRequest, verifyPrivacyRequest } from '../src/api';
import { PrimaryButton } from '../src/components/PrimaryButton';
import { Txt } from '../src/components/Txt';
import { color, font, radius, space, type } from '../src/theme';

const input = { fontFamily: font.regular, fontSize: type.title, color: color.parchment, backgroundColor: color.surface,
  borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm } as const;

/** Public page for people who were recorded by a Dimts user. */
export default function PrivacyRequest() {
  const [phone, setPhone] = useState('+'), [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code' | 'sent'>('phone');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');

  async function submit() {
    setBusy(true); setError('');
    try {
      if (step === 'phone') { await startPrivacyRequest(phone.trim()); setStep('code'); }
      else { setMessage((await verifyPrivacyRequest(phone.trim(), code.trim())).message); setStep('sent'); }
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to send your request. Try again.'); }
    finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.lg, maxWidth: 560 }}>
      <Txt size="screen" weight="bold" accessibilityRole="header">Delete my call data</Txt>
      {step === 'sent' ? <Txt>{message}</Txt> : <>
        <Txt tone="muted">If a business recorded a call with you using Dimts, you can ask them to delete it. We text a code to prove the number is yours.</Txt>
        <TextInput value={phone} onChangeText={setPhone} editable={step === 'phone' && !busy} keyboardType="phone-pad"
          accessibilityLabel="Your phone number with country code" placeholder="+44 7700 900123" placeholderTextColor={color.faint} style={input} />
        {step === 'code' && <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" autoFocus
          accessibilityLabel="Verification code" placeholder="Code" placeholderTextColor={color.faint} style={input} />}
        <PrimaryButton label={step === 'phone' ? 'Send code' : 'Send my request'} onPress={submit} busy={busy}
          disabled={step === 'phone' ? !/^\+[1-9]\d{6,14}$/.test(phone.trim()) : !/^\d{4,10}$/.test(code.trim())} />
        {error ? <Txt accessibilityRole="alert" tone="muted">{error}</Txt> : null}
      </>}
    </ScrollView>
  );
}
