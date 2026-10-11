import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, useWindowDimensions, View } from 'react-native';
import { useApp } from '../src/AppContext';
import { sendLoginCode, verifyLoginCode } from '../src/api';
import { Txt } from '../src/components/Txt';
import { font, radius, space, type, useTheme } from '../src/theme';

// The signed-out front page: who Dimts is for and what it does, then sign-in.
// English only, written for the international market.
const BENEFITS = [
  { title: 'A summary after every call', body: 'Who said what, the prices, the dates. Ready when you hang up.' },
  { title: 'Promises, tracked', body: 'What you owe, and who you are waiting on, without taking notes.' },
  { title: 'Ask your calls', body: '“What price did Sam quote?” Every answer opens the moment it was said.' },
];

function Hero({ wide }: { wide: boolean }) {
  const { c } = useTheme();
  const headline = wide ? type.display + 6 : type.display;
  return (
    <View style={{ gap: space.md, maxWidth: 520 }}>
      <Txt size="caption" weight="bold" tone="gold" style={{ letterSpacing: 1, textTransform: 'uppercase' }}>
        For people who do business on the phone
      </Txt>
      <Txt serif style={{ fontSize: headline, lineHeight: Math.round(headline * 1.15) }}>
        Remember every client call.
      </Txt>
      <Txt size="subhead" tone="muted">
        Dimts records your business calls, writes the summary and keeps track of what everyone promised, so you never take notes on the phone again.
      </Txt>
      <Txt tone="muted">Built for consultants, agents, contractors and small-business owners.</Txt>
      <View style={{ gap: space.md, paddingTop: space.sm }}>
        {BENEFITS.map(b => (
          <View key={b.title} style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ width: 4, borderRadius: 2, backgroundColor: c.gold }} />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt weight="bold">{b.title}</Txt>
              <Txt tone="muted">{b.body}</Txt>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

export default function Onboarding() {
  const { c } = useTheme();
  const { t, signIn } = useApp();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [value, setValue] = useState('+1');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);
  const [notice, setNotice] = useState('');

  const valid = /^\+[1-9]\d{6,14}$/.test(value);
  async function submit() {
    setBusy(true); setError('');
    try {
      if (!sent) { await sendLoginCode(value); setSent(true); }
      else { const session = await verifyLoginCode(value, code); await signIn(session.token, session.phone); }
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to sign in.'); }
    finally { setBusy(false); }
  }
  async function callWithCode() {
    setBusy(true); setError(''); setNotice('');
    try { await sendLoginCode(value, 'call'); setNotice('Answer the call: it reads out your code.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to call you.'); }
    finally { setBusy(false); }
  }

  const signInCard = (
    <View style={{
      gap: space.md, padding: space.lg, backgroundColor: c.card, borderRadius: radius.lg,
      borderWidth: 1, borderColor: c.line, width: wide ? 420 : '100%',
    }}>
      <View style={{ gap: space.xs }}>
        <Txt size="title" weight="bold">Sign in or create your account</Txt>
        <Txt size="caption" tone="muted">21-day free trial. No card needed.</Txt>
      </View>

      <TextInput
        value={value}
        onChangeText={setValue}
        onBlur={() => setTouched(true)}
        keyboardType="phone-pad"
        autoFocus={wide}
        editable={!sent && !busy}
        placeholder={t('phonePlaceholder')}
        placeholderTextColor={c.faint}
        accessibilityLabel={t('onboardingTitle')}
        style={{
          fontFamily: font.regular,
          fontSize: type.title,
          color: c.ink,
          backgroundColor: c.bg,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: touched && !valid ? c.danger : c.line,
          paddingHorizontal: space.md,
          paddingVertical: space.md,
        }}
      />
      <Txt size="caption" tone="muted">
        Use the mobile number of the phone you will answer, not a Dimts business number.
      </Txt>

      {touched && !valid && <Txt size="caption" tone="muted">{t('invalidPhone')}</Txt>}
      {sent && <TextInput value={code} onChangeText={setCode} keyboardType="number-pad"
        textContentType="oneTimeCode" autoComplete="sms-otp" placeholder="Verification code"
        placeholderTextColor={c.faint} accessibilityLabel="Verification code"
        style={{ fontFamily: font.regular, fontSize: type.subhead, color: c.ink, padding: space.md, backgroundColor: c.bg,
          borderRadius: radius.md, borderWidth: 1, borderColor: c.line }} />}
      {error ? <Txt tone="danger">{error}</Txt> : null}
      {notice ? <Txt tone="muted">{notice}</Txt> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !valid }}
        disabled={!valid || busy || (sent && !/^\d{4,10}$/.test(code))}
        onPress={submit}
        style={{
          alignItems: 'center',
          paddingVertical: space.md,
          borderRadius: radius.md,
          backgroundColor: valid ? c.brand : c.line,
        }}
      >
        <Txt
          size="subhead"
          weight="bold"
          style={{ color: valid ? c.bg : c.faint }}
        >
          {busy ? 'Please wait…' : sent ? 'Verify and continue' : 'Send verification code'}
        </Txt>
      </Pressable>
      {sent && <Pressable accessibilityRole="button" disabled={busy} onPress={callWithCode} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Txt tone="accent">No text message? Call me with the code</Txt>
      </Pressable>}
      {sent && <Pressable onPress={() => { setSent(false); setCode(''); setError(''); setNotice(''); }}>
        <Txt tone="accent">Change number or send another code</Txt>
      </Pressable>}

      <Txt size="caption" tone="faint">
        Dimts records calls routed through your Dimts number or started here. It does not capture every call on your phone or WhatsApp. Every recorded call starts with a short notice to the other person: “This call is recorded and summarized by Dimts AI.”
      </Txt>
    </View>
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: c.bg }}
    >
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{
        flexGrow: 1, justifyContent: 'center', padding: wide ? space.xxl : space.md, paddingVertical: space.xl,
      }}>
        <View style={{
          flexDirection: wide ? 'row' : 'column', alignItems: wide ? 'center' : 'stretch',
          justifyContent: 'center', gap: wide ? space.xxl : space.xl, width: '100%', maxWidth: 1080, alignSelf: 'center',
        }}>
          <View style={{ flex: wide ? 1 : undefined }}><Hero wide={wide} /></View>
          {signInCard}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
