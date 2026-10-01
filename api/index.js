// Root Vercel function alongside the Expo static export. Server code remains
// ESM inside server/package.json; the Expo root package stays CommonJS.
const application = import('../server/create-app.js').then(({ createApp }) => createApp());
module.exports = async function handler(req, res) {
  return (await application)(req, res);
};
