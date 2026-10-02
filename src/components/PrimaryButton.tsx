import { ActivityIndicator, Pressable } from 'react-native';
import { Txt } from './Txt';
import { color, radius, space } from '../theme';

export function PrimaryButton({ label, onPress, busy = false, disabled = false, danger = false }:
  { label: string; onPress: () => void; busy?: boolean; disabled?: boolean; danger?: boolean }) {
  const off = disabled || busy;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: off, busy }} disabled={off} onPress={onPress}
      style={{ minHeight: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg,
        backgroundColor: off ? color.raised : danger ? color.madder : color.saffron }}>
      {busy ? <ActivityIndicator color={color.parchment} /> :
        <Txt weight="bold" style={{ color: off ? color.muted : danger ? color.parchment : color.ink }}>{label}</Txt>}
    </Pressable>
  );
}
