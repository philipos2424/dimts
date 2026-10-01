import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { useApp } from '../src/AppContext';
import { sendLoginCode, verifyLoginCode } from '../src/api';
import { Txt } from '../src/components/Txt';
import { color, font, radius, space, type } from '../src/theme';

export default function Onboarding() {
  const { t, signIn } = useApp();
  const [value, setValue] = useState('+1');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);

  const valid = /^\+[1-9]\d{6,14}$/.test(value);
  async function submit() {
    setBusy(true); setError('');
    try {
      if (!sent) { await sendLoginCode(value); setSent(true); }
      else { const session = await verifyLoginCode(value, code); await signIn(session.token, session.phone); }
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to sign in.'); }
    finally { setBusy(false); }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: color.ink }}
    >
      <View style={{ flex: 1, justifyContent: 'center', padding: space.xl, gap: space.lg }}>
        <View style={{ gap: space.sm }}>
          <Txt size="screen" weight="bold">
            {t('onboardingTitle')}
          </Txt>
          <Txt tone="muted" style={{ maxWidth: 320 }}>
            {t('onboardingBody')}
          </Txt>
          <Txt size="caption" tone="muted" style={{ maxWidth: 360 }}>
            Dimts records calls routed through your Dimts number or started here. It does not capture every call on your phone or WhatsApp. Both people choose whether to record; the call can continue without recording.
          </Txt>
        </View>

        <TextInput
          value={value}
          onChangeText={setValue}
          onBlur={() => setTouched(true)}
          keyboardType="phone-pad"
          autoFocus
          editable={!sent && !busy}
          placeholder={t('phonePlaceholder')}
          placeholderTextColor={color.faint}
          accessibilityLabel={t('onboardingTitle')}
          style={{
            fontFamily: font.regular,
            fontSize: type.title,
            color: color.parchment,
            backgroundColor: color.surface,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: touched && !valid ? color.madder : color.line,
            paddingHorizontal: space.md,
            paddingVertical: space.md,
          }}
        />

        {touched && !valid && <Txt size="caption" tone="muted">{t('invalidPhone')}</Txt>}
        {sent && <TextInput value={code} onChangeText={setCode} keyboardType="number-pad"
          textContentType="oneTimeCode" autoComplete="sms-otp" placeholder="Verification code"
          placeholderTextColor={color.faint} accessibilityLabel="Verification code"
          style={{ color: color.parchment, padding: space.md, backgroundColor: color.surface }} />}
        {error ? <Txt tone="muted">{error}</Txt> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !valid }}
          disabled={!valid || busy || (sent && !/^\d{4,10}$/.test(code))}
          onPress={submit}
          style={{
            alignItems: 'center',
            paddingVertical: space.md,
            borderRadius: radius.md,
            backgroundColor: valid ? color.saffron : color.line,
          }}
        >
          <Txt
            size="subhead"
            weight="bold"
            style={{ color: valid ? color.ink : color.faint }}
          >
            {busy ? 'Please wait…' : sent ? 'Verify and continue' : 'Send verification code'}
          </Txt>
        </Pressable>
        {sent && <Pressable onPress={() => { setSent(false); setCode(''); setError(''); }}>
          <Txt tone="accent">Change number or send another code</Txt>
        </Pressable>}
      </View>
    </KeyboardAvoidingView>
  );
}
