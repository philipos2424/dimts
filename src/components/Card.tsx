import { Pressable, View, type ViewStyle } from 'react-native';
import { radius, space, useTheme } from '../theme';

export function Card({ children, onPress, style, accessibilityLabel }:
  { children: React.ReactNode; onPress?: () => void; style?: ViewStyle; accessibilityLabel?: string }) {
  const { c } = useTheme();
  const base: ViewStyle = { backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderRadius: radius.lg, padding: space.md, gap: space.sm };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress}
      style={({ pressed }) => [base, { opacity: pressed ? 0.85 : 1 }, style]}>
      {children}
    </Pressable>
  );
}
