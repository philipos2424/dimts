import { View } from 'react-native';
import { space } from '../theme';
import { Txt } from './Txt';

/** An empty screen is an invitation to act, so it always names the next step. */
export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.xl,
        gap: space.sm,
      }}
    >
      <Txt size="title" weight="bold">
        {title}
      </Txt>
      <Txt tone="muted" style={{ textAlign: 'center', maxWidth: 280 }}>
        {body}
      </Txt>
    </View>
  );
}
