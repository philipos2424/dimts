/**
 * Vercel entry point. Zero-config Express detection picks this file up and
 * turns the whole app into a single Fluid function; `server/` is the project's
 * Root Directory so it does not collide with the Expo app at the repo root.
 */
import { createApp } from './app.js';

export default createApp();
