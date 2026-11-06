'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../utils/protocol');
const caption={type:'transcript',recording_id:'r',segment_id:0,revision:1,text:'今天很开心',final:true,start_ms:0,end_ms:1000};
test('audio quality and raw tags arrive independently and trigger a view update without changing the acoustic label',()=>{
  let state=P.reduce(P.initialState('s3'),caption);
  state=P.reduce(state,{type:'emotion',recording_id:'r',segment_id:0,label:'happy',status:'ready'});
  const before=P.groups(state);
  state=P.reduce(state,{type:'emotion',recording_id:'r',segment_id:0,label:'happy',status:'ready',raw_tags:['<|HAPPY|>'],audio_quality:{duration_ms:1000,analyzed_ms:1000,peak:.8,rms_dbfs:-22,clipping_ratio:0,reason:'short_context'}});
  const after=P.groups(state),patch=P.groupPatch(before,after);
  assert.equal(state.segments[0].emotion.label,'happy');assert.equal(after[0].segments[0].emotion.audio_quality.reason,'short_context');
  assert.ok(patch['groups[0].segments[0]']);assert.deepEqual(state.segments[0].emotion.raw_tags,['<|HAPPY|>']);
});
test('same-revision snapshot restores bounded quality while invalid measurements are dropped',()=>{
  let state=P.reduce(P.initialState('s3'),caption);
  state=P.reduce(state,{type:'snapshot',device_id:'s3',history:[Object.assign({},caption,{emotion:{label:'neutral',status:'ready',raw_tags:Array(30).fill('x'.repeat(100)),audio_quality:{duration_ms:500,analyzed_ms:NaN,peak:Infinity,rms_dbfs:-20,clipping_ratio:2,reason:'invalid'}}})]});
  const emotion=state.segments[0].emotion;
  assert.equal(emotion.audio_quality.duration_ms,500);assert.equal(emotion.audio_quality.rms_dbfs,-20);
  assert.equal(emotion.audio_quality.peak,undefined);assert.equal(emotion.audio_quality.reason,undefined);assert.equal(emotion.audio_quality.clipping_ratio,undefined);
  assert.equal(emotion.raw_tags.length,8);assert.equal(emotion.raw_tags[0].length,40);
});
test('uncalibrated candidates are bounded, finite, known labels and never replace the primary unknown label',()=>{
  let state=P.reduce(P.initialState('s3'),caption);
  const candidates=[{label:'happy',score:-2.4},{label:'happy',score:.99},{label:'invalid',score:.5},{label:'sad',score:Infinity},{label:'neutral',score:.8},{label:'angry',score:3.2},{label:'surprised',score:.2}];
  state=P.reduce(state,{type:'emotion',recording_id:'r',segment_id:0,label:'unknown',status:'ready',candidates});
  const before=P.groups(state),emotion=state.segments[0].emotion;
  assert.equal(emotion.label,'unknown');assert.deepEqual(emotion.candidates,[{label:'happy',score:-2.4},{label:'neutral',score:.8},{label:'angry',score:3.2}]);
  state=P.reduce(state,{type:'emotion',recording_id:'r',segment_id:0,label:'unknown',status:'ready',candidates:[{label:'happy',score:-1}]});
  assert.ok(P.groupPatch(before,P.groups(state))['groups[0].segments[0]']);
});
test('no-signal reason survives normalization without inventing an acoustic label',()=>{
  let state=P.reduce(P.initialState('s3'),caption);
  state=P.reduce(state,{type:'emotion',recording_id:'r',segment_id:0,label:'unknown',status:'skipped',audio_quality:{duration_ms:500,analyzed_ms:0,peak:0,rms_dbfs:-120,clipping_ratio:0,reason:'no_signal'}});
  assert.equal(state.segments[0].emotion.audio_quality.reason,'no_signal');assert.equal(state.segments[0].emotion.label,'unknown');
});
