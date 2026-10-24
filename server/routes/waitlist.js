import express from 'express';
import * as database from '../db/pool.js';
import { HttpError } from '../lib/users.js';
import { hit } from '../lib/rate-limit.js';

export const waitlistRouter = express.Router();

// The marketing site lives on its own origin, so this one route answers CORS
// for that origin list only. Nothing here reads a session or a cookie.
const DEFAULT_ORIGINS = 'https://dimts.app,https://www.dimts.app,https://dimts-site.vercel.app';
const allowedOrigins = () => new Set((process.env.WAITLIST_ORIGINS ?? DEFAULT_ORIGINS).split(',').map(o => o.trim()).filter(Boolean));

waitlistRouter.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins().has(origin)) {
    res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const PLATFORMS = new Set(['iphone', 'android', 'web']);
const clean = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/**
 * The answer is the same for a new and an already-listed email, so the form
 * cannot be used to find out who has signed up.
 */
waitlistRouter.post('/', async (req, res) => {
  const body = req.body ?? {};
  // Bots fill every field; people never see this one.
  if (clean(body.company, 200)) return res.status(202).json({ status: 'listed' });
  const email = clean(body.email, 254)?.toLowerCase();
  if (!email || !EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Enter an email address like name@company.com.');
  const platform = PLATFORMS.has(body.platform) ? body.platform : null;
  await hit(`waitlist-ip:${req.ip}`, 10, 3600);
  await hit(`waitlist-email:${email}`, 3, 86400);
  await hit('waitlist-all', 2000, 3600);
  await database.query(`INSERT INTO waitlist(email,platform,work,country,source) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (email) DO UPDATE SET platform=COALESCE(EXCLUDED.platform,waitlist.platform), work=COALESCE(EXCLUDED.work,waitlist.work)`,
  [email, platform, clean(body.work, 80), clean(body.country, 2)?.toUpperCase() ?? null, clean(body.source, 120)]);
  res.status(202).json({ status: 'listed' });
});
