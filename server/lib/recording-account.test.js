import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingAccount } from './recording-account.js';
const account='AC'+'a'.repeat(32), other='AC'+'b'.repeat(32), sid='RE'+'c'.repeat(32);
const url=`https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${sid}`;

test('preserves stamped ownership or extracts a canonical legacy recording account without assuming configuration',()=>{
  assert.equal(recordingAccount({twilio_account_sid:account}),account);
  for(const extension of ['', '.mp3', '.wav']) assert.equal(recordingAccount({recording_url:url+extension,recording_sid:sid}),account);
  assert.equal(recordingAccount({recording_sid:sid}),null);
  assert.equal(recordingAccount({twilio_account_sid:'invalid',recording_url:url}),null);
  assert.equal(recordingAccount({twilio_account_sid:other,recording_url:url}),null);
  assert.equal(recordingAccount({recording_sid:'RE'+'d'.repeat(32),recording_url:url}),null);
});

test('untrusted URLs cannot supply legacy ownership',()=>{
  for(const recording_url of [
    url.replace('https:', 'http:'),url.replace('api.twilio.com','api.twilio.com.evil.example'),
    url.replace('api.twilio.com','user:pass@api.twilio.com'),url.replace('api.twilio.com','api.twilio.com:444'),
    url+'?AccountSid='+other,url+'#'+other,url+'/extra',url.replace('/Recordings/','/Calls/'),
    'not a URL',null,
  ]) assert.equal(recordingAccount({recording_url}),null);
});
