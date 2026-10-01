import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { space } from '../theme';
import { Txt } from './Txt';

export function FirstCallLink() {
  const router = useRouter();
  return <View style={{ padding: space.md, gap: space.xs }}>
    <Txt weight="bold">Try a call before relying on Dimts</Txt>
    <Txt tone="muted">Test with another person, listen to both voices and check your notes.</Txt>
    <Pressable accessibilityRole="button" onPress={() => router.push('/first-call')}
      style={{ minHeight: 44, justifyContent: 'center' }}>
      <Txt tone="accent">Open the first-call guide</Txt>
    </Pressable>
  </View>;
}
