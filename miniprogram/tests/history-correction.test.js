'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../utils/protocol');
const source={type:'transcript',recording_id:'r',segment_id:0,revision:5,text:'原始识别文本',final:true,start_ms:0,end_ms:1000};
function corrected(version,text){return{type:'history_corrected',recording_id:'r',segment_id:0,edit_version:version,corrected_text:text,corrected_at:'2026-11-07T00:00:00Z'};}
test('correction is independent from ASR revision, preserves original text and defaults copy to the displayed version',()=>{
  let state=P.reduce(P.initialState('s3'),source),before=P.groups(state);
  state=P.reduce(state,Object.assign(corrected(1,'校对文本'),{text:'不得覆盖原文'}));
  assert.equal(state.segments[0].text,source.text);assert.equal(state.segments[0].revision,5);assert.equal(state.segments[0].edit_version,1);
  assert.equal(P.displayText(state.segments[0]),'校对文本');assert.equal(P.recordingText(state,'r'),'校对文本');assert.equal(P.recordingText(state,'r','original'),source.text);
  assert.ok(P.groupPatch(before,P.groups(state))['groups[0].segments[0]']);
  state=P.reduce(state,corrected(2,null));assert.equal(P.displayText(state.segments[0]),source.text);assert.equal(state.segments[0].text,source.text);
});
test('same and older ASR revision snapshots can bring newer edits, but older edit versions cannot roll back a correction',()=>{
  let state=P.reduce(P.initialState('s3'),source);
  state=P.reduce(state,{type:'snapshot',device_id:'s3',history:[Object.assign({},source,{edit_version:1,corrected_text:'第一版',corrected_at:'one'})]});
  state=P.reduce(state,{type:'snapshot',device_id:'s3',history:[Object.assign({},source,{revision:1,text:'迟到旧原文',edit_version:2,corrected_text:'第二版',corrected_at:'two'})]});
  assert.equal(state.segments[0].text,source.text);assert.equal(state.segments[0].revision,5);assert.equal(state.segments[0].corrected_text,'第二版');
  state=P.reduce(state,{type:'snapshot',device_id:'s3',history:[Object.assign({},source,{edit_version:1,corrected_text:'过期校对',corrected_at:'one'})]});
  state=P.reduce(state,corrected(1,null));assert.equal(state.segments[0].corrected_text,'第二版');assert.equal(state.segments[0].edit_version,2);
});
test('original and corrected text share the same total history budget',()=>{
  let state=P.initialState('s3');
  const history=Array.from({length:160},(_,n)=>Object.assign({},source,{recording_id:'r'+n,text:'原'.repeat(512),edit_version:1,corrected_text:'校'.repeat(512),corrected_at:null}));
  state=P.reduce(state,{type:'snapshot',device_id:'s3',history});
  assert.equal(state.text_units,65536);assert.equal(state.segments.length,64);assert.equal(state.segments[0].recording_id,'r96');
});
test('correction validation trims, counts Unicode and UTF8 separately, and rejects control characters',()=>{
  assert.equal(P.validateCorrection(null),null);assert.equal(P.validateCorrection(' 你好 '),'你好');assert.equal(P.validateCorrection('第一行\r\n第二行'),'第一行\n第二行');
  assert.equal(P.validateCorrection('字'.repeat(512)).length,512);assert.ok(P.validateCorrection('😀'.repeat(384)));
  for(const value of ['', '  ', '字'.repeat(513),'😀'.repeat(385),'字\t字','字\u0085字','字\u0000字','\ud800'])assert.throws(()=>P.validateCorrection(value));
});
test('partial captions cannot be manually corrected and absent/cleared capabilities disable old firmware display support',()=>{
  let state=P.reduce(P.initialState('s3'),Object.assign({},source,{final:false,edit_version:3,corrected_text:'无效校对'}));
  state=P.reduce(state,corrected(4,'无效'));assert.equal(state.segments[0].corrected_text,null);
  state=P.reduce(state,{type:'hello',protocol:1,ready:true,capabilities:['history_display']});assert.deepEqual(state.capabilities,['history_display']);
  state=P.reduce(state,{type:'status',state:'offline'});assert.deepEqual(state.capabilities,[]);
});
