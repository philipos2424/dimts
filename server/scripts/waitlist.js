// Operator view: the marketing-site waitlist as CSV, newest first.
// Usage: node --env-file=../.env scripts/waitlist.js > waitlist.csv
import { query, closeDatabase } from '../db/pool.js';

const { rows } = await query('SELECT email, platform, work, country, source, created_at FROM waitlist ORDER BY created_at DESC');
const cell = value => (value == null ? '' : /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
console.log('email,platform,work,country,source,joined');
for (const row of rows) console.log([row.email, row.platform, row.work, row.country, row.source, row.created_at.toISOString()].map(cell).join(','));
console.error(`${rows.length} on the waitlist.`);
await closeDatabase();
