import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../src/AppContext';
import { IncomingBriefing } from '../src/components/IncomingBriefing';
import { color, font } from '../src/theme';

function Gate() {
  const { ready, userPhone } = useApp();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const onOnboarding = segments[0] === 'onboarding';

    if (!userPhone && !onOnboarding) router.replace('/onboarding');
    else if (userPhone && onOnboarding) router.replace('/');
  }, [ready, userPhone, segments, router]);

  return (
    <View style={{ flex: 1 }}>
    <IncomingBriefing />
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: color.ink },
        headerTintColor: color.parchment,
        headerTitleStyle: { fontFamily: font.bold },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: color.ink },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false }} />
      <Stack.Screen
        name="in-call"
        options={{ presentation: 'fullScreenModal', headerShown: false }}
      />
      <Stack.Screen name="settings" />
      <Stack.Screen name="call/[id]" />
    </Stack>
    </View>
  );
}

export default function RootLayout() {
  // The plugin embeds these at build time; loading them here also covers
  // Expo Go during development.
  const [loaded] = useFonts({
    [font.regular]: require('../assets/fonts/NotoSansEthiopic-Regular.ttf'),
    [font.bold]: require('../assets/fonts/NotoSansEthiopic-Bold.ttf'),
  });

  if (!loaded) return <View style={{ flex: 1, backgroundColor: color.ink }} />;

  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="light" />
        <Gate />
      </AppProvider>
    </SafeAreaProvider>
  );
}
