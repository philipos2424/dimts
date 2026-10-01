import { validateDeployment } from '../lib/deployment-config.js';
try {
  validateDeployment();
  console.log('Deployment settings passed validation; live services are not verified.');
} catch (err) {
  console.error(err.message);
  process.exitCode=1;
}
