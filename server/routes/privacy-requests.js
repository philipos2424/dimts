import express from 'express';
import * as database from '../db/pool.js';
import { isE164 } from '../lib/phone.js';
import { HttpError, hashToken, resolveUser } from '../lib/users.js';
import { hit } from '../lib/rate-limit.js';
import { audit } from '../lib/audit.js';
import { defer } from '../lib/defer.js';
import { checkPhoneCode, sendPhoneCode } from '../services/verify-phone.js';
import { sendPrivacyRequestNotification } from '../services/notifications.js';
import { isReviewDemo } from '../lib/review-demo.js';

export const privacyRequestsRouter = express.Router();
export const SENT_MESSAGE = 'Your request was sent to the businesses who recorded calls with this number. They must act within 30 days. Contact privacy@dimts.app if they do not.';

privacyRequestsRouter.post('/start', async (req, res) => {
  const { phone } = req.body ?? {};
  if (!isE164(phone)) throw new HttpError(400, 'invalid_phone');
  await hit(`privacy-send-phone:${phone}`, 5, 3600);
  await hit(`privacy-send-ip:${req.ip}`, 20, 3600);
  // Same answer as a real send, but the fictional review number is never texted.
  if (!isReviewDemo(phone)) await sendPhoneCode(phone);
  res.status(202).json({ status: 'code_sent' });
});

/**
 * The response is identical whether or not any business holds the number,
 * so the page cannot be used to discover who has recorded someone.
 */
privacyRequestsRouter.post('/verify', async (req, res) => {
  const { phone, code } = req.body ?? {};
  if (!isE164(phone) || typeof code !== 'string' || !/^\d{4,10}$/.test(code)) throw new HttpError(400, 'invalid_verification');
  await hit(`privacy-check-phone:${phone}`, 15, 3600);
  await hit(`privacy-check-ip:${req.ip}`, 40, 3600);
  if (!(await checkPhoneCode(phone, code))) throw new HttpError(401, 'invalid_code');
  const owners = await database.withTransaction(async tx => {
    const request = (await tx.query('INSERT INTO privacy_requests(phone_hash) VALUES($1) RETURNING id', [hashToken(phone)])).rows[0];
    const { rows } = await tx.query(`INSERT INTO privacy_request_targets(request_id,user_id,contact_id)
      SELECT $1,k.user_id,k.id FROM contacts k JOIN users u ON u.id=k.user_id
      WHERE k.phone=$2 AND u.deleted_at IS NULL
      ON CONFLICT DO NOTHING RETURNING user_id`, [request.id, phone]);
    return rows.map(row => row.user_id);
  });
  for (const userId of owners) {
    await audit({ userId, action: 'privacy_request_received', targetType: 'privacy_request', req });
    defer(sendPrivacyRequestNotification(userId), `privacy-notify:${userId}`);
  }
  res.json({ status: 'sent', message: SENT_MESSAGE });
});

export const myPrivacyRequestsRouter = express.Router();
myPrivacyRequestsRouter.get('/', async (req, res) => {
  const user = await resolveUser(req);
  const { rows } = await database.query(`SELECT r.id,t.contact_id,r.created_at,r.created_at+interval '30 days' AS due_at
    FROM privacy_request_targets t JOIN privacy_requests r ON r.id=t.request_id
    WHERE t.user_id=$1 AND t.resolved_at IS NULL ORDER BY r.created_at`, [user.id]);
  res.json({ requests: rows });
});
