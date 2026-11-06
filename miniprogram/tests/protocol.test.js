'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../utils/protocol');
const transcript = (extra) => Object.assign({type:'transcript',device_id:'s3',recording_id:'recording-a',segment_id:0,revision:1,text:'今天心情',final:false,start_ms:0,end_ms:600},extra);

test('2pass replaces one sentence, drops stale revisions, and never regresses final text', () => {
  let state = p.initialState('s3');
  state = p.reduce(state,transcript());
  state = p.reduce(state,transcript({revision:2,text:'今天心情很好。',final:true}));
  state = p.reduce(state,transcript({revision:1,text:'旧的临时字幕'}));
  state = p.reduce(state,transcript({revision:3,text:'迟到的临时字幕',final:false}));
  assert.equal(state.segments.length,1);
  assert.equal(state.segments[0].text,'今天心情很好。');
  assert.equal(state.segments[0].final,true);
});
test('emotion before/after text merges into the corresponding recording, with no invented confidence', () => {
  let state = p.initialState('s3');
  state = p.reduce(state,{type:'emotion',recording_id:'recording-a',segment_id:0,label:'happy',event:'Speech'});
  state = p.reduce(state,transcript({final:true}));
  state = p.reduce(state,{type:'emotion',recording_id:'recording-b',segment_id:0,label:'angry'});
  assert.equal(state.segments[0].emotion.label,'happy');
  assert.equal(state.segments[0].emotion.confidence,undefined);
  state = p.reduce(state,{type:'emotion',recording_id:'recording-a',segment_id:0,label:'unrecognized-label'});
  assert.equal(state.segments[0].emotion.label,'unknown');
  assert.equal(p.emotionText({status:'skipped',label:'unknown'}),'情绪分析已跳过');
});
test('snapshot reconnect deduplicates and preserves newer final results', () => {
  let state = p.reduce(p.initialState('s3'),transcript({revision:3,final:true,text:'最终字幕'}));
  state = p.reduce(state,{type:'snapshot',device_id:'s3',state:'idle',recording_id:null,settings:p.DEFAULT_SETTINGS,
    history:[transcript(),transcript({segment_id:1,revision:2,final:true,text:'下一句',emotion:{label:'neutral'}})]});
  state = p.reduce(state,{type:'snapshot',device_id:'s3',state:'idle',history:[transcript({segment_id:1,revision:2,final:true,text:'下一句'})]});
  assert.equal(state.segments.length,2);
  assert.equal(state.segments[0].text,'最终字幕');
  assert.equal(state.segments[1].emotion.label,'neutral');
  assert.equal(state.settings_known,true);
});
test('same-revision reconnect snapshot still restores emotion completed in background', () => {
  const final=transcript({final:true,revision:2,text:'你好。'});
  let state=p.reduce(p.initialState('s3'),final);
  state=p.reduce(state,{type:'snapshot',device_id:'s3',state:'idle',history:[Object.assign({},final,{emotion:{label:'happy',status:'ready'}})]});
  assert.equal(state.segments.length,1);
  assert.equal(state.segments[0].emotion.label,'happy');
});
test('old completion cannot stop a new recording or affect a different device', () => {
  let state = p.reduce(p.initialState('s3'),{type:'status',device_id:'s3',state:'recording',recording_id:'new'});
  state = p.reduce(state,{type:'recording_done',recording_id:'old',audio_ms:3000,final_latency_ms:80});
  assert.equal(state.state,'recording');
  assert.equal(state.recording_id,'new');
  assert.equal(p.reduce(state,transcript({device_id:'another'})),state);
});
test('out-of-order sentence packets are ordered within a recording', () => {
  let state = p.reduce(p.initialState('s3'),transcript({segment_id:2,text:'丙'}));
  state = p.reduce(state,transcript({segment_id:0,text:'甲'}));
  state = p.reduce(state,transcript({segment_id:1,text:'乙'}));
  assert.equal(p.recordingText(state,'recording-a'),'甲乙丙');
});
test('streaming view patch sends the changed sentence rather than full history', () => {
  let state=p.reduce(p.initialState('s3'),transcript({recording_id:'old',final:true}));
  state=p.reduce(state,transcript());
  const previous=p.groups(state);
  state=p.reduce(state,transcript({revision:2,text:'今天心情很好'}));
  const patch=p.groupPatch(previous,p.groups(state));
  assert.equal(patch.groups,undefined);
  assert.equal(patch['groups[0].segments[0]'].text,'今天心情很好');
  assert.ok(!Object.keys(patch).some(key=>key.startsWith('groups[1]')));
  state=p.reduce(state,transcript({recording_id:'new'}));
  assert.equal(p.groupPatch(previous,p.groups(state)).groups.length,3);
});
test('recording identifiers cannot collide with object prototype names', () => {
  let state=p.reduce(p.initialState('s3'),transcript({recording_id:'__proto__'}));
  state=p.reduce(state,transcript({recording_id:'constructor'}));
  assert.equal(p.groups(state).length,2);
});
test('history and Unicode text are bounded without splitting surrogate pairs', () => {
  let state = p.initialState('s3');
  for (let n=0;n<p.MAX_SEGMENTS+10;n++) state=p.reduce(state,transcript({recording_id:'r'+n,text:'录音😀'.repeat(3000)}));
  assert.ok(state.segments.length <= p.MAX_SEGMENTS);
  assert.ok(state.text_units <= p.MAX_TEXT_UNITS);
  assert.equal(Array.from(state.segments[0].text).length,p.MAX_TEXT);
  assert.ok(!/[\ud800-\udbff]$/.test(state.segments[0].text));
});
test('invalid packets and settings cannot enter view state', () => {
  assert.equal(p.parseMessage('{broken'),null);
  assert.equal(p.parseMessage(new ArrayBuffer(2)),null);
  assert.equal(p.parseMessage('[1,2]'),null);
  assert.equal(p.parseMessage('x'.repeat(600000)),null);
  let state=p.reduce(p.initialState('s3'),transcript({revision:-1}));
  assert.equal(state.segments.length,0);
  assert.throws(()=>p.validateSettings({animation:'false'}));
  assert.throws(()=>p.validateSettings({font_scale:4.5}));
  assert.throws(()=>p.validateSettings({brightness:0}));
  assert.throws(()=>p.validateSettings({extra:'anything'}));
  state=p.reduce(state,{type:'settings_applied',settings:{font_scale:99}});
  assert.equal(state.settings.font_scale,1);
  assert.equal(state.settings_known,false);
});
test('QR pairing accepts base or complete address and encodes credentials exactly once', () => {
  const info={url:'ws://192.168.1.100:8765/',device_id:'s3-voice',token:'local-token_123'};
  const paired=p.parsePairing(JSON.stringify(info));
  assert.equal(p.socketURL(paired),'ws://192.168.1.100:8765/ws/client/s3-voice?token=local-token_123');
  assert.deepEqual(p.parsePairing(p.socketURL(paired)),paired);
  const special={url:'wss://voice.example.com',device_id:'s3',token:'token+with=symbol'};
  assert.ok(p.socketURL(special).endsWith('token=token%2Bwith%3Dsymbol'));
  assert.deepEqual(p.parsePairing(p.socketURL(special)),special);
});
test('pairing rejects mismatched device, invalid port and arbitrary paths before socket creation', () => {
  assert.throws(()=>p.normalizeConnection({url:'ws://pc:70000',device_id:'s3',token:'a'}));
  assert.throws(()=>p.normalizeConnection({url:'ws://pc:8765/ws/client/other',device_id:'s3',token:'a'}));
  assert.throws(()=>p.normalizeConnection({url:'http://pc:8765',device_id:'s3',token:'a'}));
  assert.throws(()=>p.normalizeConnection({url:'ws://pc/path',device_id:'s3',token:'a'}));
  assert.throws(()=>p.normalizeConnection({url:'ws://user:password@pc',device_id:'s3',token:'a'}));
  assert.throws(()=>p.parsePairing('{"url":"ws://pc:8765","device_id":"s3","token":""}'));
});
