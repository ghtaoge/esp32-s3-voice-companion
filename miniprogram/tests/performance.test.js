'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const p=require('../utils/protocol');
const {pageHarness,streamScenario,snapshotScenario,connectionScenario}=require('../scripts/benchmark');

test('30 seconds of subtitle/level bursts coalesce behind a slow view and retain the latest result',()=>{
  const result=streamScenario(160);
  assert.equal(result.incoming_packets,3630);
  assert.ok(result.set_data_calls<=380,'not more than the 80ms view ceiling');
  assert.equal(result.draft_writes,0,'streaming never rewrites the settings draft');
  assert.equal(result.max_pending_bridges,1,'only one subtitle bridge call is outstanding');
  assert.ok(result.total_bytes<1024*1024,'history is not resent on every chunk');
  assert.ok(result.retained_segments<=p.MAX_SEGMENTS);
  assert.equal(result.latest_view_revision,600);
  assert.equal(result.latest_state_revision,600);
});
test('large repeated snapshots stay below the view payload ceiling and do not churn unchanged views',()=>{
  const result=snapshotScenario();
  assert.ok(result.incoming_snapshot_bytes>1000000,'exercise a large but valid Unicode snapshot');
  assert.ok(result.retained_text_utf16<=p.MAX_TEXT_UNITS);
  assert.ok(result.max_payload_bytes<512*1024,'leave ample headroom below a 1MiB view payload');
  assert.equal(result.full_history_writes,1);
  assert.ok(result.set_data_calls<=5,'unchanged snapshots do not resend historical text');
});
test('repeated snapshot trimming keeps the newest rows in their original order',()=>{
  const rows=Array.from({length:160},(_,n)=>({type:'transcript',recording_id:'r'+n,segment_id:0,revision:1,final:true,text:'字'.repeat(2048),start_ms:0,end_ms:1000}));
  let state=p.initialState('s3');
  for(let n=0;n<20;n++)state=p.reduce(state,{type:'snapshot',device_id:'s3',history:rows});
  assert.equal(state.segments[0].recording_id,'r128');
  assert.equal(state.segments[state.segments.length-1].recording_id,'r159');
  assert.equal(state.text_units,65536);
  const build=p.groupBuilder(),first=build(state),second=build(state);
  assert.equal(first[0],second[0],'unchanged groups reuse their cached view');
  assert.equal(p.groupPatch(first,second).groups,undefined);
});
test('frequent incoming packets do not allocate a watchdog timer per packet',()=>{
  const result=connectionScenario(false);
  assert.equal(result.incoming_packets,3000);
  assert.ok(result.app_timers_created<=5);
  assert.ok(result.max_app_timers<=2);
  assert.equal(result.timers_after_hide,0);
  assert.equal(result.attempts_after_hide,result.connect_attempts);
});
test('open-close storms preserve backoff and duplicate errors cannot multiply retries',()=>{
  const result=connectionScenario(true);
  assert.ok(result.connect_attempts<=10,'rapidly closing an opened socket must not reset backoff');
  assert.ok(result.max_app_timers<=2);
  assert.equal(result.timers_after_hide,0);
  assert.equal(result.attempts_after_hide,result.connect_attempts);
});
test('view completion after hide cannot restart a stale render generation',()=>{
  const h=pageHarness(500);
  h.receive({type:'status',device_id:'s3',state:'recording',recording_id:'r'});
  h.clock.advance(80);
  assert.equal(h.page.renderInFlight,true);
  h.page.onHide();
  assert.equal(h.page.renderInFlight,false);
  h.page.onShow();
  h.receive({type:'transcript',device_id:'s3',recording_id:'r',segment_id:0,revision:1,text:'重新回到前台',final:false,start_ms:0,end_ms:500});
  h.clock.advance(80);
  assert.equal(h.page.renderInFlight,true);
  h.clock.advance(420); // Includes the old generation's completion at t+500.
  assert.equal(h.page.renderInFlight,true,'old completion must not release the new view lock');
  h.clock.advance(80);
  assert.equal(h.page.renderInFlight,false);
  h.page.onHide();h.clock.advance(60000);
  assert.equal(h.clock.appCount(),0);
  h.page.onUnload();
});
