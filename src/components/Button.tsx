import { ActivityIndicator, Pressable } from 'react-native';
import { Txt } from './Txt';
import { radius, space, useTheme } from '../theme';

type Variant = 'primary' | 'quiet' | 'danger';

export function Button({ label, onPress, variant = 'primary', busy = false, disabled = false, compact = false }:
  { label: string; onPress: () => void; variant?: Variant; busy?: boolean; disabled?: boolean; compact?: boolean }) {
  const { c } = useTheme();
  const off = disabled || busy;
  const background = variant === 'primary' ? c.brand : variant === 'danger' ? c.danger : 'transparent';
  const text = variant === 'quiet' ? c.brand : c.onBrand;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: off, busy }} disabled={off} onPress={onPress}
      style={({ pressed }) => ({ minHeight: compact ? 36 : 48, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
        paddingHorizontal: compact ? space.md : space.lg, backgroundColor: background, opacity: off ? 0.45 : pressed ? 0.85 : 1,
        borderWidth: variant === 'quiet' ? 1 : 0, borderColor: c.line, alignSelf: compact ? 'flex-start' : 'stretch' })}>
      {busy ? <ActivityIndicator color={text} /> : <Txt weight="bold" size={compact ? 'caption' : 'body'} style={{ color: text }}>{label}</Txt>}
    </Pressable>
  );
}
