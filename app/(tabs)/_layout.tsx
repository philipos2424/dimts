import { Tabs, useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import { useApp } from '../../src/AppContext';
import { Txt } from '../../src/components/Txt';
import { font, space, useTheme } from '../../src/theme';

export default function TabsLayout() {
  const { c } = useTheme();
  const { t } = useApp();
  const router = useRouter();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.bg },
        headerTintColor: c.ink,
        headerTitleStyle: { fontFamily: font.bold, fontSize: 21 },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: c.bg },
        tabBarStyle: {
          backgroundColor: c.card,
          borderTopColor: c.line,
          height: 62,
          paddingTop: space.sm,
        },
        tabBarActiveTintColor: c.brand,
        tabBarInactiveTintColor: c.muted,
        tabBarLabelStyle: { fontFamily: font.regular, fontSize: 12 },
        headerRight: () => (
          <Pressable
            onPress={() => router.push('/settings')}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('settings')}
            style={{ marginRight: space.md }}
          >
            <Txt size="title" tone="muted">
              ⚙
            </Txt>
          </Pressable>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: t('recents'), tabBarIcon: () => null }}
      />
      <Tabs.Screen
        name="dialer"
        options={{ title: t('dialer'), tabBarIcon: () => null }}
      />
      <Tabs.Screen
        name="notes"
        options={{ title: t('notes'), tabBarIcon: () => null }}
      />
      <Tabs.Screen name="contacts" options={{ title: 'Contacts', tabBarIcon: () => null }} />
    </Tabs>
  );
}
