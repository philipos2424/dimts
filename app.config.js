// The native plugin adds source-map upload build steps. Keep it opt-in so
// local builds without Sentry credentials still work; runtime init is in JS.
module.exports = ({ config }) => ({
  ...config,
  plugins: [...(config.plugins ?? []), ...(process.env.SENTRY_AUTH_TOKEN ? [
    ['@sentry/react-native/expo', {
      organization: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
    }],
  ] : [])],
});
