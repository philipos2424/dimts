import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { useApp } from '../src/AppContext';
import { Txt } from '../src/components/Txt';
import { color, font, radius, space, type } from '../src/theme';

export default function Onboarding() {
  const { t, setUserPhone } = useApp();
  const [value, setValue] = useState('+251');
  const [touched, setTouched] = useState(false);

  const valid = /^\+[1-9]\d{6,14}$/.test(value);

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
        </View>

        <TextInput
          value={value}
          onChangeText={setValue}
          onBlur={() => setTouched(true)}
          keyboardType="phone-pad"
          autoFocus
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

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !valid }}
          disabled={!valid}
          onPress={() => setUserPhone(value)}
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
            {t('continue')}
          </Txt>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
