import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { captureSessionGuard, registerNotificationDevice, removeNotificationDevice } from './api';

const preference = (phone: string) => `dimts.notifications.${phone}`;
export async function notificationPreference(phone: string) {
  return (await AsyncStorage.getItem(preference(phone))) === 'true';
}
async function register(requestPermission: boolean) {
  const sameSession = captureSessionGuard();
  if (Platform.OS === 'web') throw new Error('Incoming-call notifications require the installed iPhone or Android app.');
  const Notifications = await import('expo-notifications');
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) throw new Error('Push notifications are not configured for this build.');
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('incoming-calls', {
    name: 'Incoming business calls', importance: Notifications.AndroidImportance.HIGH,
  });
  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted' && requestPermission) permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Notifications are not allowed. Enable them in your phone’s settings.');
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  if (!sameSession()) throw new Error('Your account changed. Sign in and enable notifications again.');
  await registerNotificationDevice(token);
  if (!sameSession()) throw new Error('Your account changed. Sign in and enable notifications again.');
}
export async function enableIncomingNotifications(phone: string) {
  await register(true); await AsyncStorage.setItem(preference(phone), 'true');
}
export async function disableIncomingNotifications(phone: string) {
  await removeNotificationDevice(); await AsyncStorage.removeItem(preference(phone));
}
export async function restoreIncomingNotifications(phone: string) {
  if (Platform.OS !== 'web' && await notificationPreference(phone)) await register(false);
}
export async function observeIncomingNotifications(onCall: (id: string) => Promise<void>, onBilling: () => void = () => {}) {
  if (Platform.OS === 'web') return () => {};
  const Notifications = await import('expo-notifications');
  Notifications.setNotificationHandler({ handleNotification: async () => ({
    shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: false, shouldShowList: false,
  }) });
  const seen = new Set<string>();
  async function respond(response: import('expo-notifications').NotificationResponse) {
    const request = response.notification.request, data = request.content.data;
    // Minutes and credit warnings open Plan. The destination is fixed here, never read from the push.
    if (typeof data?.type === 'string' && data.type.startsWith('billing-') && !seen.has(request.identifier)) {
      seen.add(request.identifier);
      await Notifications.clearLastNotificationResponseAsync().catch(() => {});
      onBilling();
      return;
    }
    if (data?.type !== 'incoming-call' || typeof data.callId !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(data.callId) || seen.has(request.identifier)) return;
    seen.add(request.identifier);
    await Notifications.clearLastNotificationResponseAsync().catch(() => {});
    await onCall(data.callId);
  }
  const listener = Notifications.addNotificationResponseReceivedListener(response => { void respond(response).catch(() => {}); });
  let last: import('expo-notifications').NotificationResponse | null;
  try { last = await Notifications.getLastNotificationResponseAsync(); }
  catch { listener.remove(); throw new Error('Unable to read the notification response'); }
  if (last) void respond(last).catch(() => {});
  return () => listener.remove();
}
