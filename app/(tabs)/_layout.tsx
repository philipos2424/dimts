import { Tabs, useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import { useApp } from '../../src/AppContext';
import { Txt } from '../../src/components/Txt';
import { color, font, space } from '../../src/theme';

export default function TabsLayout() {
  const { t } = useApp();
  const router = useRouter();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: color.ink },
        headerTintColor: color.parchment,
        headerTitleStyle: { fontFamily: font.bold, fontSize: 21 },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: color.ink },
        tabBarStyle: {
          backgroundColor: color.surface,
          borderTopColor: color.line,
          height: 62,
          paddingTop: space.sm,
        },
        tabBarActiveTintColor: color.saffron,
        tabBarInactiveTintColor: color.muted,
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
