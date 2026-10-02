// Move existing recordings from Twilio into EU storage, then remove Twilio's
// copy once the stored object is verified. Run --dry-run first.
// Usage: node --env-file=../.env scripts/archive-existing-audio.js [--dry-run] [--limit N]
import { query, closeDatabase } from '../db/pool.js';
import { fetchRecording } from '../services/originate.js';
import { archiveAudio, removeArchivedFromProvider } from '../services/archive-audio.js';
import { audioStoreConfigured } from '../services/audio-store.js';

const dryRun = process.argv.includes('--dry-run');
const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex > -1 ? Number(process.argv[limitIndex + 1]) : 500;
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid --limit');
if (!audioStoreConfigured()) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY');

const { rows } = await query(`SELECT * FROM calls WHERE recording_url IS NOT NULL AND audio_object_key IS NULL
  AND deleted_at IS NULL AND status NOT IN ('initiating','ringing','in-progress','processing')
  ORDER BY created_at LIMIT $1`, [limit]);
const totals = { stored: 0, removed: 0, failed: 0 };
for (const call of rows) {
  if (dryRun) { console.log(`would archive ${call.id} (${call.created_at.toISOString().slice(0, 10)})`); continue; }
  const response = await fetchRecording(call.recording_url);
  if (!response.ok) { totals.failed++; console.log(`${call.id}  Twilio HTTP ${response.status}`); continue; }
  const outcome = await archiveAudio(call, new Uint8Array(await response.arrayBuffer()));
  if (outcome !== 'stored') { totals.failed++; console.log(`${call.id}  ${outcome}`); continue; }
  totals.stored++;
  const removal = await removeArchivedFromProvider(call.id);
  if (removal === 'removed') totals.removed++;
  console.log(`${call.id}  stored, Twilio ${removal}`);
}
console.log(dryRun ? `${rows.length} calls would be archived.` : `stored ${totals.stored}, removed from Twilio ${totals.removed}, failed ${totals.failed}`);
await closeDatabase();
