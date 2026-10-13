import { Image, Platform, Pressable } from 'react-native';
import type { SocialProvider } from '../api';
import { PROVIDER_LABELS } from '../socialSignIn';
import { Txt } from './Txt';

const google = Platform.OS === 'ios' ? require('../../assets/signin/google-ios.png') : require('../../assets/signin/google.png');
const apple = require('../../assets/signin/apple.png');

/** Provider-supplied artwork preserves the logos, type and spacing on every platform. */
export function SocialSignInButton({ provider, disabled, onPress }: {
  provider: SocialProvider; disabled: boolean; onPress: () => void;
}) {
  const artwork = provider === 'google' ? google : provider === 'apple' ? apple : null;
  const label = `${artwork ? 'Sign in' : 'Continue'} with ${PROVIDER_LABELS[provider]}`;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({ alignSelf: 'center', width: 240, minHeight: 48, alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        ...(artwork ? {} : { borderRadius: 4, borderWidth: 1, borderColor: '#747775', backgroundColor: '#fff' }) })}>
      {artwork
        ? <Image source={artwork} accessible={false} resizeMode="contain" style={{ width: 240, height: 48 }} />
        : <Txt weight="bold" style={{ color: '#1f1f1f' }}>{label}</Txt>}
    </Pressable>
  );
}
