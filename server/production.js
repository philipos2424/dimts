import { validateDeployment } from './lib/deployment-config.js';
import { migrateSchema } from './db/migrate.js';
import { createApp } from './create-app.js';
import { closeDatabase } from './db/pool.js';
import { drainDeferredWork } from './lib/defer.js';
import { createShutdownHandler } from './lib/shutdown.js';

try {
  const { port, host } = validateDeployment();
  await migrateSchema();
  const server = createApp().listen(port,host,() => console.log('Dimts production server listening'));
  const shutdown = createShutdownHandler({server,drain:drainDeferredWork,closeDatabase});
  process.on('SIGTERM',shutdown);
  process.on('SIGINT',shutdown);
  server.on('error',() => { console.error('Unable to listen; check host and port configuration.'); process.exit(1); });
} catch {
  // Validation can also be run separately for setting-specific diagnostics.
  // Database errors may contain credentials or SQL; do not log them here.
  console.error('Dimts startup failed. Validate deployment settings and database connectivity/schema permissions.');
  process.exit(1);
}
