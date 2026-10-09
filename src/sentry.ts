import * as Sentry from '@sentry/react-native';
import { Platform } from 'react-native';
import { beforeSend, isEuDsn } from '../server/lib/sentry-privacy.cjs';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
const enabled = !!dsn && isEuDsn(dsn);

export function initSentry() {
  if (!enabled) return;
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    defaultIntegrations: false,
    integrations: [Platform.OS === 'web' ? Sentry.browserGlobalHandlersIntegration() : Sentry.reactNativeErrorHandlersIntegration()],
    beforeSend,
    beforeBreadcrumb: () => null,
    maxBreadcrumbs: 0,
    // Native crashes can bypass the JS beforeSend privacy boundary.
    enableNative: false,
    enableAutoSessionTracking: false,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    sendClientReports: false,
    enableLogs: false,
    initialScope: { tags: { stage: 'app' } },
  });
}

export const wrapWithSentry: typeof Sentry.wrap = component => enabled ? Sentry.wrap(component) : component;
