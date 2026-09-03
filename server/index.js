/**
 * Vercel entry point.
 *
 * The `express` import is load-bearing even though nothing here calls it:
 * Vercel's zero-config Express detection scans this entry file for it, and
 * without the direct import the deployment builds no function at all and
 * every route answers with the platform's NOT_FOUND page.
 *
 * Set the Vercel project's Root Directory to `server/` so this file - and not
 * the Expo app at the repo root - is what gets detected.
 */
import express from 'express';
import { createApp } from './app.js';

export const runtime = 'nodejs';

const app = createApp();

// Guard against a future refactor quietly breaking the detection above.
if (typeof express !== 'function') {
  throw new Error('express failed to load');
}

export default app;
