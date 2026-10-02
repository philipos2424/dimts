import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../src/AppContext';
import { IncomingBriefing } from '../src/components/IncomingBriefing';
import { IncomingNotificationObserver } from '../src/components/IncomingNotificationObserver';
import { color, font } from '../src/theme';

const PUBLIC = new Set(['privacy', 'terms', 'privacy-request']);

function Gate() {
  const { ready, userPhone, termsRequired } = useApp();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const screen = segments[0] as string | undefined;
    // Legal pages and the privacy-request page are public.
    if (screen && PUBLIC.has(screen)) return;
    const onOnboarding = screen === 'onboarding';

    if (!userPhone && !onOnboarding) router.replace('/onboarding');
    else if (userPhone && termsRequired && screen !== 'terms-accept') router.replace('/terms-accept');
    else if (userPhone && !termsRequired && (onOnboarding || screen === 'terms-accept')) router.replace('/');
  }, [ready, userPhone, termsRequired, segments, router]);

  return (
    <View style={{ flex: 1 }}>
    <IncomingBriefing />
    <IncomingNotificationObserver />
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
      <Stack.Screen name="first-call" options={{ title: 'Test your first call' }} />
      <Stack.Screen name="call/[id]" />
      <Stack.Screen name="terms-accept" options={{ headerShown: false }} />
      <Stack.Screen name="privacy" options={{ title: 'Privacy' }} />
      <Stack.Screen name="terms" options={{ title: 'Terms' }} />
      <Stack.Screen name="privacy-request" options={{ title: 'Privacy request' }} />
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
