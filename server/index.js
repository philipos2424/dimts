/**
 * Express entry point.
 *
 * The `express` import is load-bearing even though nothing here calls it:
 * Vercel's zero-config detection scans this file for it. We do not rely on
 * that detection alone though - see api/index.js, which routes to this app
 * explicitly.
 */
import express from 'express';
import { createApp } from './app.js';

const app = createApp();

export default app;
