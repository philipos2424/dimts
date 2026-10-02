// Create the private EU bucket for call audio. Safe to run twice.
// Usage: node --env-file=../.env scripts/create-audio-bucket.js
const base = process.env.SUPABASE_URL?.replace(/\/+$/, ''), secret = process.env.SUPABASE_SECRET_KEY;
const bucket = process.env.AUDIO_BUCKET || 'call-audio';
if (!base || !secret) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY');
const response = await fetch(`${base}/storage/v1/bucket`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secret}`, apikey: secret, 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 209715200, allowed_mime_types: ['audio/mpeg'] }),
});
const body = await response.text();
if (response.ok) console.log(`Created private bucket ${bucket}.`);
else if (response.status === 409 || /already exists/i.test(body)) console.log(`Bucket ${bucket} already exists.`);
else throw new Error(`Bucket creation failed (HTTP ${response.status})`);
