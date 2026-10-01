import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const db=new PGlite();await db.exec(await readFile(new URL('../db/schema.sql',import.meta.url),'utf8'));
let failReceipt=false;
mock.module('../db/pool.js',{namedExports:{
  query:(sql,p)=>db.query(sql,p),queryOne:async(sql,p)=>{
    if(failReceipt&&sql.includes('provider_deleted_at=CASE')){failReceipt=false;throw new Error('Receipt storage interrupted');}
    return(await db.query(sql,p)).rows[0];
  },withTransaction:work=>db.transaction(work),
}});
let providerCalls=0,providerResult={status:'confirmed'},providerHook,summaryHook,startHook,providerCall;
mock.module('../services/start-recording.js',{namedExports:{startCallRecording:async()=>{if(startHook)await startHook();return 'RE'+'c'.repeat(32);}}});
mock.module('../services/delete-recording.js',{namedExports:{deleteProviderRecording:async call=>{
  providerCall=call;providerCalls++;if(providerHook)await providerHook();return providerResult;
}}});
mock.module('../services/originate.js',{namedExports:{isE164:()=>true,originateCall:async()=>{throw new Error('No test calls');},
  fetchRecording:async()=>({ok:true,blob:async()=>new Blob(['audio'])})}});
mock.module('../services/transcribe.js',{namedExports:{transcribe:async()=>({text:'Caller: Hello\nUser: Hi',raw:{},language:'en',languageProbability:1})}});
mock.module('../services/summarize.js',{namedExports:{summarize:async()=>{if(summaryHook)await summaryHook();return{summary:'Never restore this',next_moves:[],action_items:[],key_points:[]};}}});
mock.module('../services/identify.js',{namedExports:{identifyCaller:async()=>({name:null,company:null,confidence:0})}});
mock.module('../lib/twilio-signature.js',{namedExports:{verifyTwilioSignature:(_req,_res,next)=>next()}});
const {callsRouter}=await import('./calls.js');
const {callDeletionRouter,deletionsRouter}=await import('./call-deletion.js');
const {webhooksRouter}=await import('./webhooks.js');
const {processRecording}=await import('../services/process-recording.js');
const {processDeletion}=await import('../services/process-deletion.js');
const {beginAgreedRecording}=await import('../db/start-recording.js');
const app=express();app.use(express.json());app.use('/calls',callsRouter,callDeletionRouter);app.use('/deletions',deletionsRouter);app.use('/webhooks',webhooksRouter);
app.use((err,_req,res,_next)=>res.status(err.status||500).json({error:err.code||'internal_error'}));
const server=app.listen(0),base=`http://127.0.0.1:${server.address().port}`;
const tokens=['a'.repeat(64),'b'.repeat(64)],users=[];
for(const[i,token]of tokens.entries()){
  const user=(await db.query('INSERT INTO users(phone) VALUES($1) RETURNING id',[`+1555555010${i}`])).rows[0];users.push(user);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[createHash('sha256').update(token).digest('hex'),user.id]);
}
const sid='RE'+'c'.repeat(32),parent='CA'+'b'.repeat(32);
async function seed(){return(await db.query(`INSERT INTO calls(user_id,user_phone,destination,status,duration_sec,completed_at,
  twilio_call_sid,recording_sid,recording_url,recording_start_status,transcript,transcript_data,summary,followups,
  parent_consent_at,child_consent_at) VALUES($1,'+15555550100','+15555550103','ready',60,now(),$2,$3,'private-audio','started',
  'Private transcript','{"private":"text"}','Private notes','{"email":{"body":"private"}}',now(),now()) RETURNING id`,[users[0].id,parent,sid])).rows[0].id;}
const row=async id=>(await db.query('SELECT * FROM calls WHERE id=$1',[id])).rows[0];
async function request(path,method='GET',body,token=tokens[0]){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();return{status:response.status,data:text?JSON.parse(text):null};
}
async function until(check){const deadline=Date.now()+3000;while(!await check()){if(Date.now()>deadline)throw new Error('Deletion worker timed out');await new Promise(r=>setTimeout(r,5));}}
test.after(async()=>{await new Promise(r=>server.close(r));await db.close();});
test.afterEach(()=>{providerResult={status:'confirmed'};providerHook=undefined;summaryHook=undefined;startHook=undefined;failReceipt=false;});

test('deletion requires owner and explicit confirmation, scrubs content immediately, preserves usage and exposes provider confirmation',async()=>{
  const id=await seed(),before=providerCalls;
  const account='AC'+'a'.repeat(32);
  await db.query('UPDATE calls SET recording_url=$2 WHERE id=$1',[id,`https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${sid}`]);
  assert.equal((await request(`/calls/${id}`,'DELETE',{confirm:'delete-call'},null)).status,401);
  assert.equal((await request(`/calls/${id}`,'DELETE',{confirm:'delete-call'},tokens[1])).status,404);
  assert.equal((await request(`/calls/${id}`,'DELETE',{})).status,400);
  assert.equal((await request(`/calls/${id}`,'DELETE',{confirm:'delete-call'})).status,202);
  await until(async()=>(await row(id)).provider_deletion_status==='confirmed');
  const saved=await row(id);assert.equal(saved.status,'deleted');assert.ok(saved.deleted_at);assert.equal(saved.duration_sec,60);
  assert.equal(saved.twilio_account_sid,account,'legacy account survives URL scrubbing');
  assert.equal(providerCall.twilio_account_sid,account,'removal worker receives original ownership');
  for(const key of ['recording_url','transcript','transcript_data','summary','followups','contact_id'])assert.equal(saved[key],null);
  assert.equal(saved.destination,'');assert.equal(saved.user_phone,'');assert.equal(providerCalls,before+1);
  assert.equal((await request(`/calls/${id}/audio`)).status,404);assert.equal((await request(`/calls/${id}/notes`)).status,404);
  assert.equal((await request(`/calls/${id}/process`,'POST')).status,409);
  assert.ok(!(await request('/calls')).data.calls.some(c=>c.id===id));
  assert.equal((await request(`/calls/${id}`)).data.provider_deletion_status,'confirmed');
  assert.ok((await request('/deletions')).data.deletions.some(c=>c.id===id));
  assert.ok(!(await request('/deletions','GET',undefined,tokens[1])).data.deletions.some(c=>c.id===id));
  await request(`/calls/${id}`,'DELETE',{confirm:'delete-call'});assert.equal(providerCalls,before+1);
});
test('unanswered active calls and unresolved external actions cannot be deleted; an unrecorded call needs no provider action',async()=>{
  const id=await seed(),before=providerCalls;
  await db.query("UPDATE calls SET status='in-progress' WHERE id=$1",[id]);
  assert.equal((await request(`/calls/${id}`,'DELETE',{confirm:'delete-call'})).status,409);
  await db.query("UPDATE calls SET status='ready' WHERE id=$1",[id]);
  await db.query(`INSERT INTO calendar_actions(call_id,user_id,connection_id,proposal_version,meeting,status,event_id)
    VALUES($1,$2,gen_random_uuid(),1,'{}','unknown',$3)`,[id,users[0].id,id.replaceAll('-','')]);
  assert.equal((await request(`/calls/${id}`,'DELETE',{confirm:'delete-call'})).status,409);
  await db.query("UPDATE calendar_actions SET status='confirmed',meeting=$2::jsonb WHERE call_id=$1",[id,JSON.stringify({title:'Private meeting'})]);
  await db.query("UPDATE calls SET recording_url=NULL,recording_sid=NULL,recording_start_status=NULL,record_enabled=false WHERE id=$1",[id]);
  assert.equal((await request(`/calls/${id}`,'DELETE',{confirm:'delete-call'})).data.provider_deletion_status,'not_required');
  assert.deepEqual((await db.query('SELECT meeting FROM calendar_actions WHERE call_id=$1',[id])).rows[0].meeting,{});
  assert.equal(providerCalls,before);
});
test('uncertain provider deletion is visible, cooldown prevents rapid retries and only one concurrent retry owns the job',async()=>{
  const id=await seed(),before=providerCalls;providerResult={status:'unknown',error:'provider_unavailable'};
  await request(`/calls/${id}`,'DELETE',{confirm:'delete-call'});
  await until(async()=>(await row(id)).provider_deletion_status==='unknown');
  assert.equal((await request(`/calls/${id}/deletion/retry`,'POST')).status,429);
  await db.query("UPDATE calls SET provider_deletion_attempted_at=now()-interval '2 minutes' WHERE id=$1",[id]);
  providerResult={status:'confirmed'};
  await Promise.all([processDeletion(id),processDeletion(id)]);
  assert.equal((await row(id)).provider_deletion_status,'confirmed');assert.equal(providerCalls,before+2);
});
test('processing and late recording callbacks cannot restore deleted content',async()=>{
  const id=await seed();await db.query("UPDATE calls SET status='processing',transcript_recording_url=NULL WHERE id=$1",[id]);
  let release,waiting=false;summaryHook=()=>{waiting=true;return new Promise(r=>{release=r;});};
  const processing=processRecording(id);await until(()=>waiting);
  await request(`/calls/${id}`,'DELETE',{confirm:'delete-call'});release();await processing;
  assert.equal((await row(id)).summary,null);assert.equal((await row(id)).status,'deleted');
  const result=await request(`/webhooks/recording-ready?callId=${id}`,'POST',{CallSid:parent,RecordingSid:sid,RecordingStatus:'completed',RecordingUrl:'https://do-not-restore.example'});
  assert.equal(result.status,204);assert.equal((await row(id)).recording_url,null);assert.equal((await row(id)).transcript,null);
  assert.equal((await row(id)).status,'deleted');
});
test('receipt storage interruption keeps local content deleted and a later expired claim can verify removal',async()=>{
  const id=await seed();await db.query("UPDATE calls SET deleted_at=now(),status='deleted',recording_url=NULL,transcript=NULL,summary=NULL,provider_deletion_status='pending' WHERE id=$1",[id]);
  failReceipt=true;await assert.rejects(processDeletion(id),/storage interrupted/);
  assert.equal((await row(id)).provider_deletion_status,'pending');assert.equal((await row(id)).summary,null);
  await db.query("UPDATE calls SET provider_deletion_until=now()-interval '1 second',provider_deletion_attempted_at=now()-interval '2 minutes' WHERE id=$1",[id]);
  await processDeletion(id);assert.equal((await row(id)).provider_deletion_status,'confirmed');
});
test('a recording reference learned during provider lookup cannot receive the old absence receipt',async()=>{
  const id=await seed();await db.query("UPDATE calls SET deleted_at=now(),status='deleted',recording_sid=NULL,provider_deletion_status='pending' WHERE id=$1",[id]);
  providerHook=async()=>{await db.query('UPDATE calls SET recording_sid=$2 WHERE id=$1',[id,sid]);};
  await processDeletion(id);
  assert.equal((await row(id)).provider_deletion_status,'pending');assert.equal((await row(id)).provider_deleted_at,null);
  providerHook=undefined;
  await db.query("UPDATE calls SET provider_deletion_until=now()-interval '1 second',provider_deletion_attempted_at=now()-interval '2 minutes' WHERE id=$1",[id]);
  await processDeletion(id);assert.equal((await row(id)).provider_deletion_status,'confirmed');
});
test('a recording startup receipt arriving after local deletion schedules removal without restoring content',async()=>{
  const id=await seed(),child='CA'+'d'.repeat(32),before=providerCalls;
  await db.query("UPDATE calls SET status='in-progress',duration_sec=NULL,recording_start_status=NULL,recording_sid=NULL,recording_url=NULL,child_call_sid=$2 WHERE id=$1",[id,child]);
  let waiting=false,release;startHook=()=>{waiting=true;return new Promise(r=>{release=r;});};
  const starting=beginAgreedRecording(id,child);await until(()=>waiting);
  await db.query("UPDATE calls SET duration_sec=60,status='processing' WHERE id=$1",[id]);
  await request(`/calls/${id}`,'DELETE',{confirm:'delete-call'});
  await until(async()=>(await row(id)).provider_deletion_status==='confirmed');
  release();await starting;
  await until(async()=>(await row(id)).provider_deletion_status==='confirmed'&&providerCalls>=before+2);
  assert.equal((await row(id)).status,'deleted');assert.equal((await row(id)).recording_url,null);assert.equal((await row(id)).transcript,null);
});
