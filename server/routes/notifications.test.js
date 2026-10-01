import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const db=new PGlite();await db.exec(await readFile(new URL('../db/schema.sql',import.meta.url),'utf8'));
let failTicketStore=false;
mock.module('../db/pool.js',{namedExports:{query:(sql,p)=>{
  if(failTicketStore&&sql.includes('ticket_id=$3')){failTicketStore=false;throw new Error('Ticket storage interrupted');}return db.query(sql,p);
},queryOne:async(sql,p)=>(await db.query(sql,p)).rows[0],withTransaction:work=>db.transaction(work)}});
const {notificationsRouter}=await import('./notifications.js');
const {sendIncomingNotification,checkPushReceipts}=await import('../services/notifications.js');
const app=express();app.use(express.json());app.use('/notifications',notificationsRouter);
app.use((err,_req,res,_next)=>res.status(err.status||500).json({error:err.code||'internal_error'}));
const server=app.listen(0),base=`http://127.0.0.1:${server.address().port}`;
const tokens=['a'.repeat(64),'b'.repeat(64)],users=[];
for(const[i,token]of tokens.entries()){
  const user=(await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id',[`+1555555010${i}`])).rows[0];users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[createHash('sha256').update(token).digest('hex'),user.id]);
}
const realFetch=globalThis.fetch;let sends=0,receipts=0,mode='ok',receiptMode='ok',duringSend,payloads=[];
globalThis.fetch=async(url,options)=>{
  if(!String(url).startsWith('https://exp.host/'))throw new Error('No real provider requests allowed');
  if(String(url).endsWith('getReceipts')){
    receipts++;const ids=JSON.parse(options.body).ids;
    return Response.json({data:Object.fromEntries(ids.map(id=>[id,receiptMode==='ok'?{status:'ok'}:{status:'error',details:{error:'DeviceNotRegistered'}}]))});
  }
  sends++;const payload=JSON.parse(options.body);payloads.push(payload);
  if(duringSend)await duringSend();
  if(mode==='timeout')throw new Error('Private provider detail must not be persisted');
  return Response.json({data:payload.map((_,i)=>mode==='invalid-device'?{status:'error',details:{error:'DeviceNotRegistered'}}:{status:'ok',id:`ticket-${sends}-${i}`})});
};
async function request(path='',method='GET',body,token=tokens[0]){
  const response=await realFetch(base+'/notifications'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
  return{status:response.status,data:await response.json()};
}
const pushToken=i=>`ExpoPushToken[${'x'.repeat(20)}${i}]`;
async function register(i=1,owner=tokens[0]){return request('/device','POST',{token:pushToken(i)},owner);}
async function seed(owner=users[0].id){return(await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,direction)
  VALUES($1,'+15555550100','+15555550103','ringing','inbound') RETURNING id`,[owner])).rows[0].id;}
const jobs=async id=>(await db.query('SELECT * FROM call_notifications WHERE call_id=$1',[id])).rows;
async function until(check){const deadline=Date.now()+3000;while(!await check()){if(Date.now()>deadline)throw new Error('Timed out');await new Promise(r=>setTimeout(r,5));}}
test.after(async()=>{globalThis.fetch=realFetch;await new Promise(r=>server.close(r));await db.close();});
test.beforeEach(async()=>{await db.query('DELETE FROM notification_devices');sends=0;receipts=0;mode='ok';receiptMode='ok';duringSend=undefined;payloads=[];failTicketStore=false;});

test('registration requires a valid session and token; diagnostics hide device tokens and another account cannot disable devices',async()=>{
  assert.equal((await request('/device','POST',{token:pushToken(1)},null)).status,401);
  assert.equal((await request('/device','POST',{token:'https://evil.example'})).status,400);
  assert.equal((await register()).status,200);
  const status=await request();assert.equal(status.data.devices.length,1);assert.ok(!JSON.stringify(status.data).includes(pushToken(1)));
  assert.equal((await request('/device','DELETE',undefined,tokens[1])).status,200);
  assert.equal((await request()).data.devices.length,1);
  for(let i=2;i<=5;i++)assert.equal((await register(i)).status,200);
  assert.equal((await register(6)).status,409);
  await request('/device','DELETE');assert.equal((await request()).data.devices.length,0);
});
test('duplicate/concurrent dispatch sends one generic alert per active owner device, never caller data or credentials',async()=>{
  await register();await register(2,tokens[1]);const id=await seed();
  let release,waiting=false;duringSend=()=>{waiting=true;return new Promise(r=>{release=r;});};
  const first=sendIncomingNotification(id);await until(()=>waiting);await sendIncomingNotification(id);release();await first;
  assert.equal(sends,1);assert.equal(payloads[0].length,1);assert.equal(payloads[0][0].to,pushToken(1));
  assert.deepEqual(payloads[0][0].data,{type:'incoming-call',callId:id});assert.equal(payloads[0][0].ttl,60);
  assert.ok(!JSON.stringify(payloads).includes('+15555550103'));assert.ok(!JSON.stringify(payloads).includes(tokens[0]));
  assert.equal((await jobs(id))[0].status,'accepted');await sendIncomingNotification(id);assert.equal(sends,1);
});
test('signed-out, expired, completed and deleted calls do not produce new alerts',async()=>{
  await register();const id=await seed();
  await db.query("UPDATE calls SET duration_sec=60,status='completed' WHERE id=$1",[id]);await sendIncomingNotification(id);assert.equal(sends,0);
  await db.query("UPDATE calls SET duration_sec=NULL,status='ringing',deleted_at=now() WHERE id=$1",[id]);await sendIncomingNotification(id);assert.equal(sends,0);
  await db.query('UPDATE calls SET deleted_at=NULL WHERE id=$1',[id]);
  await db.query("UPDATE calls SET created_at=now()-interval '3 minutes' WHERE id=$1",[id]);
  await sendIncomingNotification(id);assert.equal(sends,0);
  await db.query('UPDATE calls SET created_at=now() WHERE id=$1',[id]);
  const hash=createHash('sha256').update(tokens[0]).digest('hex');
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hash]);
  await sendIncomingNotification(id);assert.equal(sends,0);
  await db.query("UPDATE sessions SET expires_at=now()+interval '1 day' WHERE token_hash=$1",[hash]);
  await request('/device','DELETE');await sendIncomingNotification(id);assert.equal(sends,0);
});
test('uncertain send is not blindly retried; invalid devices are disabled',async()=>{
  await register();const id=await seed();mode='timeout';await sendIncomingNotification(id);
  assert.equal((await jobs(id))[0].status,'unknown');assert.equal((await jobs(id))[0].error_code,'send_unconfirmed');
  await sendIncomingNotification(id);assert.equal(sends,1);
  mode='invalid-device';const another=await seed();await sendIncomingNotification(another);
  assert.equal((await jobs(another))[0].error_code,'device_not_registered');
  assert.equal((await request()).data.devices[0].disabled,true);
});
test('receipt checks distinguish provider handoff from device delivery and disable devices rejected later',async()=>{
  await register();const id=await seed();await sendIncomingNotification(id);
  await checkPushReceipts(users[0].id);assert.equal(receipts,0);
  await db.query("UPDATE call_notifications SET created_at=now()-interval '16 minutes',updated_at=now()-interval '2 minutes' WHERE call_id=$1",[id]);
  await checkPushReceipts(users[1].id);assert.equal(receipts,0);
  await checkPushReceipts(users[0].id);assert.equal((await jobs(id))[0].status,'provider_handoff');
  const second=await seed();await sendIncomingNotification(second);receiptMode='error';
  await db.query("UPDATE call_notifications SET created_at=now()-interval '16 minutes',updated_at=now()-interval '2 minutes' WHERE call_id=$1",[second]);
  await checkPushReceipts(users[0].id);assert.equal((await jobs(second))[0].error_code,'device_not_registered');
  assert.equal((await request()).data.devices[0].disabled,true);
});
test('a device moved to a different account never dispatches old pending work; session deletion removes its registrations',async()=>{
  await register();const id=await seed();const device=(await db.query('SELECT id FROM notification_devices')).rows[0];
  await db.query('INSERT INTO call_notifications(call_id,device_id,user_id) VALUES($1,$2,$3)',[id,device.id,users[0].id]);
  await register(1,tokens[1]);await sendIncomingNotification(id);assert.equal(sends,0);
  await db.query('DELETE FROM sessions WHERE token_hash=$1',[createHash('sha256').update(tokens[1]).digest('hex')]);
  assert.equal((await db.query('SELECT * FROM notification_devices')).rows.length,0);
});
test('interrupted ticket storage and expired receipts remain unconfirmed without a duplicate alert',async()=>{
  await register();const id=await seed();failTicketStore=true;
  await assert.rejects(sendIncomingNotification(id),/storage interrupted/);assert.equal((await jobs(id))[0].status,'sending');
  await db.query("UPDATE call_notifications SET updated_at=now()-interval '3 minutes' WHERE call_id=$1",[id]);
  await checkPushReceipts(users[0].id);assert.equal((await jobs(id))[0].status,'unknown');
  await sendIncomingNotification(id);assert.equal(sends,1);
  const another=await seed();await sendIncomingNotification(another);
  await db.query("UPDATE call_notifications SET created_at=now()-interval '25 hours' WHERE call_id=$1",[another]);
  await checkPushReceipts(users[0].id);assert.equal((await jobs(another))[0].error_code,'receipt_expired');
  const queued=await seed(),device=(await db.query('SELECT id FROM notification_devices')).rows[0];
  await db.query("INSERT INTO call_notifications(call_id,device_id,user_id,created_at) VALUES($1,$2,$3,now()-interval '3 minutes')",[queued,device.id,users[0].id]);
  await checkPushReceipts(users[0].id);assert.equal((await jobs(queued))[0].error_code,'alert_expired');
});
