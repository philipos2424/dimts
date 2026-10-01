import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptTurns } from './transcript-turns.js';
function call() {
  return { direction:'inbound',recording_url:'recording-a',transcript_recording_url:'recording-a',duration_sec:60,
    transcript:'Caller: ሰላም\nUser: Hello\nCaller: Tomorrow?',
    transcript_data:{secret:'not for the client',transcripts:[
      {words:[{text:'ሰላም',start:0.3,end:1},{text:'Tomorrow?',start:9,end:10}]},
      {words:[{text:'Hello',start:2,end:3},{text:'[noise]',type:'audio_event',start:4}]},
    ]} };
}
test('preserves speaker ownership, chronological timing and Unicode while omitting provider metadata',()=>{
  const value=call();
  assert.deepEqual(transcriptTurns(value),[
    {speaker:'Caller',text:'ሰላም',start:0.3,end:1},
    {speaker:'User',text:'Hello',start:2,end:3},
    {speaker:'Caller',text:'Tomorrow?',start:9,end:10},
  ]);
  value.direction='outbound';value.transcript='User: ሰላም\nCaller: Hello\nUser: Tomorrow?';
  assert.equal(transcriptTurns(value)[0].speaker,'User');
});
test('does not attach timestamps to changed audio, edited text, deleted calls or unsupported legacy data',()=>{
  for(const change of [{recording_url:'recording-b'},{transcript_recording_url:null},{transcript:'A user correction'},
    {deleted_at:new Date()},{transcript_data:{text:'mono'}},{transcript_data:{transcripts:[{words:[]}]}}]) {
    assert.deepEqual(transcriptTurns({...call(),...change}),[]);
  }
});
test('incomplete, negative, nonfinite or out-of-range word timing never creates a misleading seek target',()=>{
  for(const change of [{start:undefined},{start:-1},{start:NaN},{start:Infinity},{start:60},{end:0.1},{end:Infinity},{text:42}]) {
    const value=call();Object.assign(value.transcript_data.transcripts[0].words[0],change);
    assert.deepEqual(transcriptTurns(value),[]);
  }
  const value=call();value.transcript_data.transcripts[1]={text:'Hello',words:[]};
  assert.deepEqual(transcriptTurns(value),[]);
});
