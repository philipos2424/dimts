import { Pressable, View } from 'react-native';
import { useApp } from '../AppContext';
import { color, radius, space } from '../theme';
import { Txt } from './Txt';

/**
 * Inline failure notice. Errors say what happened and stay on screen until
 * dismissed — a toast that disappears mid-read is no use when the reader is
 * switching between two scripts.
 */
export function Banner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const { t } = useApp();

  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        margin: space.md,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: color.raised,
        borderLeftWidth: 3,
        borderLeftColor: color.madder,
      }}
    >
      <Txt style={{ flex: 1 }}>{message}</Txt>
      <Pressable onPress={onDismiss} hitSlop={12} accessibilityRole="button">
        <Txt tone="accent" weight="bold">
          {t('dismiss')}
        </Txt>
      </Pressable>
    </View>
  );
}
