import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { space } from '../theme';
import { Txt } from './Txt';

export function FirstCallLink() {
  const router = useRouter();
  const link = (label: string, path: '/demo-call' | '/first-call') => <Pressable accessibilityRole="button"
    onPress={() => router.push(path)} style={{ minHeight: 44, justifyContent: 'center' }}>
    <Txt tone="accent">{label}</Txt>
  </Pressable>;
  return <View style={{ padding: space.md, gap: space.xs }}>
    <Txt weight="bold">See Dimts work before relying on it</Txt>
    <Txt tone="muted">A free demo call shows your notes in a minute. Then check a real call with another person.</Txt>
    {link('Try a 1-minute demo call', '/demo-call')}
    {link('Open the first-call guide', '/first-call')}
  </View>;
}
