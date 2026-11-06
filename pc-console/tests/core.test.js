'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const V=require('../core'),P=V.protocol;

function event(patch){return Object.assign({type:'transcript',device_id:'s3',recording_id:'r',segment_id:0,revision:1,text:'今天有点开心。',final:false,start_ms:0,end_ms:1000},patch);}
function model(){const m=new V.Model('s3');m.connection='connected';m.receive({type:'hello',protocol:1,ready:true,settings:P.DEFAULT_SETTINGS});m.receive({type:'status',state:'idle',recording_id:null});return m;}
test('shared protocol UMD produces the same browser and CommonJS settings contract',()=>{
  const sandbox=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../miniprogram/utils/protocol.js'),'utf8'),sandbox);
  assert.equal(typeof sandbox.VoiceProtocol.reduce,'function');
  assert.equal(JSON.stringify(sandbox.VoiceProtocol.DEFAULT_SETTINGS),JSON.stringify(P.DEFAULT_SETTINGS));
});
test('PC service port does not change the independent ASR socket or pairing port',()=>{
  const info=V.consoleInfo({url:'ws://127.0.0.1:8765',device_id:'s3',token:'local-token',addresses:['192.168.1.5','192.168.1.5','bad'],advertise:'192.168.1.5',port:8765});
  assert.equal(P.socketURL(info),'ws://127.0.0.1:8765/ws/client/s3?token=local-token');
  assert.deepEqual(V.pairing(info,'192.168.1.5'),{url:'ws://192.168.1.5:8765',device_id:'s3',token:'local-token'});
  assert.throws(()=>V.pairing(info,'203.0.113.1'));
  assert.throws(()=>V.consoleInfo({url:'ws://127.0.0.1:8765',device_id:'s3',token:'t',port:0}));
});
test('settings draft remains separate until matching device ACK, including late and other-client results',()=>{
  const m=model();m.edit({font_scale:3});const request=m.apply('pc-1');
  assert.equal(request.settings.font_scale,3);assert.equal(m.state.settings.font_scale,1);
  m.receive({type:'settings_pending',request_id:'pc-1'});assert.ok(m.pending);
  m.receive({type:'settings_applied',request_id:'other',settings:Object.assign({},P.DEFAULT_SETTINGS,{font_scale:2})});
  assert.ok(m.pending);assert.equal(m.draft.font_scale,3);assert.equal(m.state.settings.font_scale,2);
  m.receive({type:'settings_applied',request_id:'pc-1',settings:request.settings});
  assert.equal(m.pending,null);assert.equal(m.dirty,false);assert.equal(m.state.settings.font_scale,3);
});
test('disconnect clears pending confirmation but keeps unsent draft and never fabricates success',()=>{
  const m=model();m.edit({display_mode:'scroll'});m.apply('pc-2');m.disconnected();
  assert.equal(m.pending,null);assert.equal(m.dirty,true);assert.equal(m.draft.display_mode,'scroll');assert.ok(m.settingsMessage.includes('结果未知'));
});
test('late emotion updates its sentence without stopping a newer recording and stats only count model-ready labels',()=>{
  const m=model();m.receive(event({final:true}));m.receive(event({recording_id:'r2',final:true,text:'第二句'}));
  m.receive({type:'status',state:'recording',recording_id:'new'});
  m.receive({type:'emotion',recording_id:'r',segment_id:0,label:'happy',status:'ready'});
  m.receive({type:'emotion',recording_id:'r2',segment_id:0,label:'neutral',status:'skipped'});
  assert.equal(m.state.recording_id,'new');const stats=V.emotionStats(m.state);
  assert.equal(stats.total,1);assert.equal(stats.items.find(item=>item.label==='happy').count,1);
});
test('uncalibrated candidates and text cues do not enter the acoustic emotion distribution',()=>{
  const m=model();m.receive(event({final:true,text:'我非常开心'}));
  m.receive({type:'emotion',recording_id:'r',segment_id:0,label:'unknown',status:'ready',candidates:[{label:'happy',score:2.1}]});
  assert.equal(V.emotionStats(m.state).total,0);assert.equal(m.state.segments[0].emotion.label,'unknown');
});
test('cue ranges preserve full Unicode caption, cap DOM marks and reject invalid/overlapping ranges',()=>{
  const text='😀我很高兴<script>alert(1)</script>';
  const parts=V.cueParts(text,[{start:1,end:2},{start:5,end:7,label:'happy'},{start:5,end:8},{start:999,end:1000}]);
  assert.equal(parts.map(part=>part.text).join(''),text);assert.equal(parts.filter(part=>part.cue).length,1);
  const many=V.cueParts('字'.repeat(100),Array.from({length:100},(_,n)=>({start:n,end:n+1})));
  assert.equal(many.filter(part=>part.cue).length,16);assert.equal(many.map(part=>part.text).join(''),'字'.repeat(100));
});
test('subtitle state remains bounded under long snapshot and retains final text over stale partials',()=>{
  const m=model();m.receive({type:'snapshot',state:'idle',history:Array.from({length:160},(_,n)=>event({recording_id:'r'+n,text:'字'.repeat(2048),final:true}))});
  assert.ok(m.state.text_units<=P.MAX_TEXT_UNITS);assert.equal(m.state.segments.length,32);
  m.receive(event({recording_id:'r159',revision:0,text:'旧字幕',final:false}));assert.equal(m.state.segments.at(-1).text.length,2048);
});
test('health-unavailable UI does not require model inference dependencies in console core',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../core.js'),'utf8');
  assert.ok(!/require\([^)]*(?:torch|funasr|inference)/.test(source));
});
test('history confirmation uses its own pending channel and cannot clear a settings ACK',()=>{
  const m=model();m.receive({type:'snapshot',state:'idle',capabilities:['history_display'],history:[event({final:true})]});
  m.edit({font_scale:2});m.apply('font-1');const key=m.state.segments[0].key;m.openEditor(key);m.changeCorrection('校对后的文字');m.correct('edit-1');
  m.receive({type:'history_corrected',recording_id:'r',segment_id:0,request_id:'edit-1',edit_version:1,corrected_text:'校对后的文字',corrected_at:null});
  assert.equal(m.pending.id,'font-1');assert.equal(m.correctionPending,null);assert.equal(m.editor,null);
  const display=m.display('display-1',key,'corrected');assert.equal(display.expected_edit_version,1);
  m.receive({type:'history_displayed',request_id:'display-1',recording_id:'r',segment_id:0,source:'corrected',edit_version:2});assert.ok(m.displayPending);
  m.receive({type:'history_displayed',request_id:'display-1',recording_id:'r',segment_id:0,source:'corrected',edit_version:1});assert.equal(m.displayPending,null);assert.equal(m.pending.id,'font-1');
});
test('history display is unavailable while recording or processing, including original text',()=>{
  const m=model();m.receive({type:'snapshot',state:'idle',capabilities:['history_display'],history:[event({final:true})]});const key=m.state.segments[0].key;
  for(const state of ['recording','processing']){m.receive({type:'status',state,recording_id:'new'});assert.equal(m.canDisplay(),false);assert.throws(()=>m.display('display',key,'original'));}
});
