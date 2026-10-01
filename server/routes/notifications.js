import express from 'express';
import * as db from '../db/pool.js';
import { resolveUser, hashToken, HttpError } from '../lib/users.js';
import { checkPushReceipts, validPushToken } from '../services/notifications.js';

export const notificationsRouter = express.Router();
notificationsRouter.post('/device', async (req,res) => {
  const user=await resolveUser(req), token=req.body?.token;
  if(!validPushToken(token))throw new HttpError(400,'invalid_push_token');
  const session=hashToken(req.get('authorization').slice(7));
  await db.withTransaction(async tx=>{
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
    await tx.query(`DELETE FROM notification_devices WHERE user_id=$1 AND session_hash IN
      (SELECT token_hash FROM sessions WHERE expires_at<=now())`,[user.id]);
    const {rows}=await tx.query('SELECT id FROM notification_devices WHERE user_id=$1 AND NOT disabled AND push_token<>$2',[user.id,token]);
    if(rows.length>=5)throw new HttpError(409,'device_limit','Remove a device before enabling another.');
    await tx.query(`INSERT INTO notification_devices(user_id,session_hash,push_token) VALUES($1,$2,$3)
      ON CONFLICT(push_token) DO UPDATE SET user_id=EXCLUDED.user_id,session_hash=EXCLUDED.session_hash,
        disabled=false,updated_at=now()`,[user.id,session,token]);
  });
  res.json({status:'registered'});
});
notificationsRouter.delete('/device',async(req,res)=>{
  const user=await resolveUser(req);
  await db.query('DELETE FROM notification_devices WHERE user_id=$1 AND session_hash=$2',[user.id,hashToken(req.get('authorization').slice(7))]);
  res.json({status:'disabled'});
});
notificationsRouter.get('/',async(req,res)=>{
  const user=await resolveUser(req);
  await checkPushReceipts(user.id);
  const {rows:devices}=await db.query(`SELECT d.id,d.disabled,d.updated_at FROM notification_devices d
    JOIN sessions s ON s.token_hash=d.session_hash WHERE d.user_id=$1 AND s.expires_at>now()`,[user.id]);
  const {rows:notifications}=await db.query(`SELECT call_id,status,error_code,created_at FROM call_notifications
    WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,[user.id]);
  res.json({devices,notifications});
});
