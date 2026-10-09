import { useFonts } from 'expo-font';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../src/AppContext';
import { AppLockGate } from '../src/AppLock';
import { IncomingBriefing } from '../src/components/IncomingBriefing';
import { IncomingNotificationObserver } from '../src/components/IncomingNotificationObserver';
import { font, useTheme } from '../src/theme';
import { initSentry, wrapWithSentry } from '../src/sentry';

initSentry();

const PUBLIC = new Set(['privacy', 'terms', 'privacy-request', 'subprocessors']);

function Gate() {
  const { c } = useTheme();
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

  // Screens fetch on mount; before the stored session is restored those
  // requests go out signed-out, fail with 401 and never retry.
  if (!ready) return <View style={{ flex: 1, backgroundColor: c.bg }} />;

  return (
    <View style={{ flex: 1 }}>
    <IncomingBriefing />
    <IncomingNotificationObserver />
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: c.bg },
        headerTintColor: c.ink,
        headerTitleStyle: { fontFamily: font.bold },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: c.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false }} />
      <Stack.Screen
        name="in-call"
        options={{ presentation: 'fullScreenModal', headerShown: false }}
      />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      <Stack.Screen name="plans" options={{ title: 'Plan' }} />
      <Stack.Screen name="first-call" options={{ title: 'Test your first call' }} />
      <Stack.Screen name="call/[id]" options={{ title: '' }} />
      <Stack.Screen name="person/[id]" options={{ title: '' }} />
      <Stack.Screen name="terms-accept" options={{ headerShown: false }} />
      <Stack.Screen name="privacy" options={{ title: 'Privacy' }} />
      <Stack.Screen name="terms" options={{ title: 'Terms' }} />
      <Stack.Screen name="privacy-request" options={{ title: 'Privacy request' }} />
      <Stack.Screen name="subprocessors" options={{ title: 'Subprocessors' }} />
    </Stack>
    <AppLockGate />
    </View>
  );
}

function RootLayout() {
  const { c } = useTheme();
  // The plugin embeds these at build time; loading them here also covers
  // Expo Go during development.
  const [loaded, error] = useFonts({
    [font.ethiopic]: require('../assets/fonts/NotoSansEthiopic-Regular.ttf'),
    [font.ethiopicBold]: require('../assets/fonts/NotoSansEthiopic-Bold.ttf'),
    [font.regular]: Inter_400Regular,
    [font.medium]: Inter_500Medium,
    [font.bold]: Inter_600SemiBold,
    [font.serif]: Fraunces_600SemiBold,
  });

  // A font that fails to load must never leave the app blank: fall back to system fonts.
  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: c.bg }} />;

  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="auto" />
        <Gate />
      </AppProvider>
    </SafeAreaProvider>
  );
}

export default wrapWithSentry(RootLayout);
