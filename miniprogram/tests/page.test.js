'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const p=require('../utils/protocol');

function harness() {
  let definition, nextId=0;
  const timers=new Map(),sent=[],storage={};
  class Connection {
    constructor(options){this.options=options;this.enabled=false;}
    start(url){this.url=url;this.enabled=true;}
    setForeground(value){this.foreground=value;if(!value)this.options.onState('paused');}
    stop(){this.enabled=false;this.options.onState('disconnected');}
    destroy(){this.enabled=false;}
    send(message){sent.push(message);return Promise.resolve();}
  }
  const wx={getStorageSync:key=>storage[key],setStorageSync:(key,value)=>{storage[key]=value;},removeStorageSync:key=>{delete storage[key];}};
  const context=vm.createContext({Page:value=>{definition=value;},wx,require:name=>name.endsWith('/protocol')?p:{Connection},
    setTimeout:(fn)=>{const id=++nextId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),console});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../pages/index/index.js'),'utf8'),context);
  const page=Object.assign({},definition,{data:JSON.parse(JSON.stringify(definition.data)),setData(patch){
    Object.entries(patch).forEach(([key,value])=>{
      const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');
      let item=this.data;for(let n=0;n<parts.length-1;n++)item=item[parts[n]];
      item[parts[parts.length-1]]=value;
    });
  }});
  page.onLoad();page.onShow();
  page.setData({address:'ws://192.168.1.100:8765',deviceId:'s3',token:'local-pairing-token'});page.connect();
  page.connection.options.onState('connected');
  const receive=message=>page.receive(JSON.stringify(message));
  receive({type:'hello',protocol:1,device_id:'s3',ready:true,settings:p.DEFAULT_SETTINGS});
  receive({type:'snapshot',device_id:'s3',state:'idle',recording_id:null,settings:p.DEFAULT_SETTINGS,history:[]});
  const flush=()=>{const list=Array.from(timers);timers.clear();list.forEach(([,fn])=>fn());};
  flush();
  return {page,receive,flush,sent,timers,storage};
}
test('setting draft cannot become applied before a matching device acknowledgement', () => {
  const h=harness();h.page.fontChanged({detail:{value:'2'}});h.page.applySettings();
  assert.equal(h.page.data.draft.font_scale,3);assert.equal(h.page.data.applied.font_scale,1);
  assert.equal(h.page.data.pending,true);assert.equal(h.sent[0].type,'settings_set');
  h.receive({type:'settings_pending',request_id:h.sent[0].request_id});
  assert.equal(h.page.data.pending,true);
  h.receive({type:'settings_applied',request_id:h.sent[0].request_id,settings:Object.assign({},p.DEFAULT_SETTINGS,{font_scale:3})});h.flush();
  assert.equal(h.page.data.pending,false);assert.equal(h.page.data.applied.font_scale,3);assert.equal(h.page.data.draftDirty,false);
});
test('reconnect snapshot updates actual settings while preserving unsent edits', () => {
  const h=harness();h.page.fontChanged({detail:{value:'3'}});
  h.receive({type:'snapshot',device_id:'s3',state:'idle',settings:Object.assign({},p.DEFAULT_SETTINGS,{font_scale:2}),history:[]});h.flush();
  assert.equal(h.page.data.draft.font_scale,4);assert.equal(h.page.data.applied.font_scale,2);
  h.page.restoreApplied();assert.equal(h.page.data.draft.font_scale,2);assert.equal(h.page.data.draftDirty,false);
});
test('invalid acknowledgement does not claim success, and hide stops pending work', () => {
  const h=harness();h.page.applySettings();
  h.receive({type:'settings_applied',request_id:h.sent[0].request_id,settings:{font_scale:100}});
  assert.equal(h.page.data.pending,false);assert.ok(h.page.data.settingsStatus.includes('不正确'));
  h.page.applySettings();assert.equal(h.page.data.pending,true);h.page.onHide();
  assert.equal(h.page.connection.foreground,false);assert.equal(h.page.data.pending,false);assert.equal(h.page.data.showPrivacy,false);
  h.page.onUnload();h.flush();
});
test('sentence updates and emotion do not add duplicate visible text', () => {
  const h=harness();const base={type:'transcript',device_id:'s3',recording_id:'r',segment_id:0,revision:1,text:'今天',final:false,start_ms:0,end_ms:300};
  h.receive(base);h.flush();h.receive(Object.assign({},base,{revision:2,text:'今天很好。',final:true}));h.flush();
  h.receive({type:'emotion',device_id:'s3',recording_id:'r',segment_id:0,label:'happy',status:'ready'});h.flush();
  assert.equal(h.page.data.groups.length,1);assert.equal(h.page.data.groups[0].segments.length,1);
  assert.equal(h.page.data.groups[0].text,'今天很好。');assert.equal(h.page.data.groups[0].segments[0].emotionText,'开心');
});
test('repeated handshake failure prompts connection checks without claiming an authentication cause', () => {
  const h=harness();h.page.connection.handshakeFailures=3;
  h.page.connection.options.onState('reconnecting',3200);
  assert.equal(h.page.data.showConnection,true);
  assert.ok(h.page.data.notice.includes('配对口令'));
  assert.ok(h.page.data.notice.includes('仍会自动重试'));
  assert.ok(!h.page.data.notice.includes('认证失败'));
});
test('backend setting errors are readable and do not report settings as applied', () => {
  const h=harness();h.page.applySettings();
  h.receive({type:'error',code:'settings_busy',request_id:h.sent[0].request_id});
  assert.equal(h.page.data.pending,false);
  assert.ok(h.page.data.errorText.includes('等待开发板确认'));
  assert.equal(h.page.data.settingsStatus,'设备未应用这次设置');
});
test('model load failure asks for computer-side repair rather than promising background readiness', () => {
  const h=harness();h.receive({type:'hello',protocol:1,device_id:'s3',ready:false,settings:p.DEFAULT_SETTINGS});h.flush();
  assert.equal(h.page.data.stateTitle,'本地识别尚未就绪');
  assert.ok(h.page.data.stateMessage.includes('重启服务'));
});
