// Encrypt call content and audio stored before encryption at rest, and
// re-encrypt anything sealed with a key other than the current one (rotation).
// Safe to re-run: finished rows are skipped. Run --dry-run first.
// Production also does this every night in the retention cron.
// Usage: node --env-file=../.env scripts/encrypt-existing.js [--dry-run] [--limit N]
import { closeDatabase } from '../db/pool.js';
import { encryptExisting } from '../services/encrypt-existing.js';

const dryRun = process.argv.includes('--dry-run');
const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex > -1 ? Number(process.argv[limitIndex + 1]) : 500;
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid --limit');

const result = await encryptExisting({ dryRun, limit, log: console.log });
console.log(dryRun
  ? `${result.pending.calls} calls, ${result.pending.contacts} contacts and ${result.pending.recordings} recordings would be encrypted (one batch of up to ${limit} each).`
  : `encrypted ${result.calls} calls, ${result.contacts} contacts, ${result.actions} Google drafts, ${result.audio} recordings; ${result.audioFailed} recordings failed. Re-run until nothing is left.`);
await closeDatabase();
