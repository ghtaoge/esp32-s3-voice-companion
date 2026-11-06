'use strict';
// Synthetic protocol/view load, not an ASR model or phone benchmark. Run with:
// node --expose-gc scripts/benchmark.js
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const protocol=require('../utils/protocol');
const {Connection}=require('../utils/connection');

class Clock {
  constructor(){this.time=0;this.id=0;this.tasks=new Map();this.created=0;this.max=0;}
  later(fn,ms,kind='app'){
    const id=++this.id;this.tasks.set(id,{fn,at:this.time+ms,kind});
    if(kind==='app'){this.created++;this.max=Math.max(this.max,this.appCount());}return id;
  }
  clear(id){this.tasks.delete(id);}
  appCount(){let n=0;this.tasks.forEach(value=>{if(value.kind==='app')n++;});return n;}
  advance(ms){
    const end=this.time+ms;
    for(let loops=0;loops<1000000;loops++){
      let selected=null;
      this.tasks.forEach((value,id)=>{if(value.at<=end&&(!selected||value.at<selected.value.at))selected={id,value};});
      if(!selected){this.time=end;return;}
      this.time=selected.value.at;this.tasks.delete(selected.id);selected.value.fn();
    }
    throw new Error('Synthetic timer workload did not settle');
  }
  resetCounters(){this.created=0;this.max=this.appCount();}
}

function pageHarness(bridgeDelay=120) {
  let definition;
  const clock=new Clock();
  let metrics, pending=0;
  function reset(){metrics={set_data_calls:0,total_bytes:0,max_payload_bytes:0,full_history_writes:0,draft_writes:0,level_only_writes:0,max_pending_bridges:0};clock.resetCounters();}
  reset();
  class StubConnection {
    constructor(options){this.options=options;this.handshakeFailures=0;}
    start(){}setForeground(){}destroy(){}stop(){}send(){return Promise.resolve();}
  }
  const wx={getStorageSync(){},setStorageSync(){},removeStorageSync(){}};
  const sandbox=vm.createContext({Page:value=>{definition=value;},wx,
    require:name=>name.endsWith('/protocol')?protocol:{Connection:StubConnection},
    setTimeout:(fn,ms)=>clock.later(fn,ms),clearTimeout:id=>clock.clear(id),console});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../pages/index/index.js'),'utf8'),sandbox);
  const page=Object.assign({},definition,{data:JSON.parse(JSON.stringify(definition.data)),setData(patch,callback){
    const serialized=JSON.stringify(patch);
    const bytes=Buffer.byteLength(serialized);
    metrics.set_data_calls++;metrics.total_bytes+=bytes;metrics.max_payload_bytes=Math.max(metrics.max_payload_bytes,bytes);
    if(Object.prototype.hasOwnProperty.call(patch,'groups'))metrics.full_history_writes++;
    if(Object.prototype.hasOwnProperty.call(patch,'draft'))metrics.draft_writes++;
    if(Object.keys(patch).length===1&&Object.prototype.hasOwnProperty.call(patch,'level'))metrics.level_only_writes++;
    pending++;metrics.max_pending_bridges=Math.max(metrics.max_pending_bridges,pending);
    // Emulate the data bridge's serialization semantics, not its rendering CPU.
    Object.entries(JSON.parse(serialized)).forEach(([key,value])=>{
      const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');let item=this.data;
      for(let n=0;n<parts.length-1;n++)item=item[parts[n]];item[parts[parts.length-1]]=value;
    });
    clock.later(()=>{pending--;if(callback)callback();},bridgeDelay,'bridge');
  }});
  page.onLoad();page.onShow();
  page.setData({address:'ws://192.168.1.100:8765',deviceId:'s3',token:'synthetic-local-token'});page.connect();page.connection.options.onState('connected');
  const receive=message=>page.receive(JSON.stringify(message));
  receive({type:'hello',protocol:1,device_id:'s3',ready:true,settings:protocol.DEFAULT_SETTINGS});
  clock.advance(1000+bridgeDelay*3);reset();
  return {page,clock,receive,reset,metrics:()=>Object.assign({},metrics,{app_timers_created:clock.created,max_app_timers:clock.max,
    retained_segments:page.state.segments.length,retained_text_utf16:page.state.segments.reduce((n,item)=>n+item.text.length,0),
    state_json_bytes:Buffer.byteLength(JSON.stringify(page.state)),view_json_bytes:Buffer.byteLength(JSON.stringify(page.data.groups))})};
}
function history(count,chars){return Array.from({length:count},(_,n)=>({type:'transcript',device_id:'s3',recording_id:'history-'+n,
  segment_id:0,revision:1,text:'本地字幕用于流量负载测试。'.repeat(Math.ceil(chars/13)).slice(0,chars),final:true,start_ms:0,end_ms:12000}));}

function streamScenario(count){
  const h=pageHarness();
  h.receive({type:'snapshot',device_id:'s3',state:'idle',recording_id:null,settings:protocol.DEFAULT_SETTINGS,history:history(count,320)});
  h.clock.advance(1000);h.receive({type:'status',device_id:'s3',state:'recording',recording_id:'live'});h.clock.advance(500);h.reset();
  const start=process.hrtime.bigint();
  for(let tick=0;tick<3000;tick++){
    h.clock.advance(10);
    if(tick%5===0)h.receive({type:'transcript',device_id:'s3',recording_id:'live',segment_id:0,revision:tick/5+1,
      text:'实时字幕持续更新，保留历史记录。'.repeat(60).slice(0,Math.min(768,16+tick)),final:false,start_ms:0,end_ms:tick*10});
    h.receive({type:'level',device_id:'s3',recording_id:'live',level:(tick%100)/100});
    if(tick%100===0)h.receive({type:'emotion',device_id:'s3',recording_id:'history-'+(count-1),segment_id:0,label:'neutral',status:'ready'});
  }
  h.clock.advance(2000);
  const result=Object.assign({scenario:'stream-'+count,virtual_ms:30000,incoming_packets:3630,bridge_completion_ms:120,
    node_work_ms:Number(process.hrtime.bigint()-start)/1e6},h.metrics());
  const live=h.page.data.groups.find(group=>group.id==='live');
  result.latest_view_revision=live?live.segments[0].revision:null;
  result.latest_state_revision=h.page.state.segments.find(item=>item.recording_id==='live').revision;
  h.page.onUnload();return result;
}
function snapshotScenario(){
  const h=pageHarness();const entries=history(160,2048);const raw=JSON.stringify({type:'snapshot',device_id:'s3',state:'idle',settings:protocol.DEFAULT_SETTINGS,history:entries});
  const start=process.hrtime.bigint();
  for(let n=0;n<30;n++){h.page.receive(raw);h.clock.advance(200);}
  h.clock.advance(1000);
  const result=Object.assign({scenario:'repeated-large-snapshot',snapshots:30,incoming_snapshot_bytes:Buffer.byteLength(raw),
    node_work_ms:Number(process.hrtime.bigint()-start)/1e6},h.metrics());h.page.onUnload();return result;
}
function connectionScenario(flap){
  const clock=new Clock();const tasks=[];
  const wx={connectSocket:()=>{
    const events={};const task={onOpen:fn=>{events.open=fn;},onMessage:fn=>{events.message=fn;},onClose:fn=>{events.close=fn;},onError:fn=>{events.error=fn;},
      send:options=>options.success(),close(){if(events.close)events.close({code:1000});},events};tasks.push(task);
    if(flap)clock.later(()=>{events.open();for(let n=0;n<100;n++){events.close({code:1006});events.error();}},10,'network');
    return task;
  }};
  const connection=new Connection({wx,now:()=>clock.time,setTimeout:(fn,ms)=>clock.later(fn,ms),clearTimeout:id=>clock.clear(id),random:()=>.5});
  connection.setForeground(true);connection.start('ws://pc/synthetic');
  if(flap)clock.advance(60000);
  else {
    tasks[0].events.open();clock.resetCounters();
    for(let n=0;n<3000;n++){clock.advance(10);tasks[0].events.message({data:'{"type":"level"}'});}
  }
  const result={scenario:flap?'flapping-socket':'busy-socket-watchdog',virtual_ms:flap?60000:30000,
    incoming_packets:flap?tasks.length*200:3000,connect_attempts:tasks.length,app_timers_created:clock.created,max_app_timers:clock.max,
    active_timers:clock.appCount()};
  connection.setForeground(false);clock.advance(60000);result.timers_after_hide=clock.appCount();result.attempts_after_hide=tasks.length;
  connection.destroy();return result;
}

function run(){
  if(global.gc)global.gc();const before=process.memoryUsage().heapUsed;
  const results=[streamScenario(50),streamScenario(160),snapshotScenario(),connectionScenario(false),connectionScenario(true)];
  if(global.gc)global.gc();
  return {kind:'synthetic-miniprogram-protocol-and-setData',node:process.version,
    note:'Node CPU and bridge serialization only; no microphone, ASR model, native phone renderer or network throughput is measured.',
    heap_after_gc_delta_bytes:global.gc?process.memoryUsage().heapUsed-before:null,results};
}
if(require.main===module)process.stdout.write(JSON.stringify(run(),null,2)+'\n');
module.exports={Clock,pageHarness,streamScenario,snapshotScenario,connectionScenario,run};
