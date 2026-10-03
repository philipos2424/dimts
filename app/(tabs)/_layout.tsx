import { Tabs, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { Txt } from '../../src/components/Txt';
import { font, space, useTheme } from '../../src/theme';

function Wordmark() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginLeft: space.md }}>
      <Txt size="title" serif tone="brand">Dimts</Txt>
      <Txt size="subhead" tone="gold">ድምፅ</Txt>
    </View>
  );
}

function Avatar() {
  const { c } = useTheme();
  const { userPhone } = useApp();
  const router = useRouter();
  const initials = (userPhone ?? '').replace(/\D/g, '').slice(-2) || '•';
  return (
    <Pressable onPress={() => router.push('/settings')} hitSlop={12} accessibilityRole="button" accessibilityLabel="Settings and account"
      style={{ marginRight: space.md, width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: c.brand }}>
      <Txt size="caption" weight="bold" tone="onBrand">{initials}</Txt>
    </Pressable>
  );
}

function Icon({ glyph, focused }: { glyph: string; focused: boolean }) {
  return <Txt size="subhead" tone={focused ? 'brand' : 'faint'}>{glyph}</Txt>;
}

export default function TabsLayout() {
  const { c } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.bg },
        headerTintColor: c.ink,
        headerShadowVisible: false,
        headerTitle: '',
        headerLeft: () => <Wordmark />,
        headerRight: () => <Avatar />,
        sceneStyle: { backgroundColor: c.bg },
        tabBarStyle: { backgroundColor: c.card, borderTopColor: c.line, height: 62, paddingTop: space.sm },
        tabBarActiveTintColor: c.brand,
        tabBarInactiveTintColor: c.faint,
        tabBarLabelStyle: { fontFamily: font.medium, fontSize: 12 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Ask', tabBarIcon: ({ focused }) => <Icon glyph="✦" focused={focused} /> }} />
      <Tabs.Screen name="calls" options={{ title: 'Calls', tabBarIcon: ({ focused }) => <Icon glyph="◎" focused={focused} /> }} />
      <Tabs.Screen name="dialer" options={{ title: 'Call', tabBarIcon: ({ focused }) => <Icon glyph="✆" focused={focused} /> }} />
      <Tabs.Screen name="ask" options={{ href: null }} />
    </Tabs>
  );
}
