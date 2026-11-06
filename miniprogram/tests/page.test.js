'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const p=require('../utils/protocol');
const emotionCues=require('../utils/emotion-cues');

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
  const context=vm.createContext({Page:value=>{definition=value;},wx,require:name=>name.endsWith('/protocol')?p:name.endsWith('/emotion-cues')?emotionCues:{Connection},
    setTimeout:(fn)=>{const id=++nextId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),console});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../pages/index/index.js'),'utf8'),context);
  const page=Object.assign({},definition,{data:JSON.parse(JSON.stringify(definition.data)),setData(patch,callback){
    Object.entries(patch).forEach(([key,value])=>{
      const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');
      let item=this.data;for(let n=0;n<parts.length-1;n++)item=item[parts[n]];
      item[parts[parts.length-1]]=value;
    });
    if(callback)callback();
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
  assert.equal(h.page.data.groups[0].segments[0].text,'今天很好。');assert.equal(h.page.data.groups[0].segments[0].emotionText,'开心');
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

test('text highlights preserve negation and remain independent from the acoustic label',()=>{
  const h=harness(),text='我一点也不开心，但非常生气。';
  h.receive({type:'transcript',device_id:'s3',recording_id:'r',segment_id:0,revision:1,text,final:false,start_ms:0,end_ms:2000});h.flush();
  let view=h.page.data.groups[0].segments[0];
  assert.equal(view.cueTokens.map(token=>token.text).join(''),text);
  assert.equal(view.cueTokens.filter(token=>token.highlight)[0].negated,true);
  const analysis=h.page.cueCache.get('r:0').analysis;
  h.receive({type:'emotion',device_id:'s3',recording_id:'r',segment_id:0,label:'neutral',status:'ready'});h.flush();
  view=h.page.data.groups[0].segments[0];
  assert.equal(view.emotion.label,'neutral');assert.equal(view.emotionText,'平静');
  assert.equal(h.page.cueCache.get('r:0').analysis,analysis,'late acoustic metadata must reuse lexical analysis');
  h.page.toggleEmotionDetails({currentTarget:{dataset:{key:'r:0'}}});h.flush();
  view=h.page.data.groups[0].segments[0];
  assert.equal(view.detailsOpen,true);assert.equal(view.detailCues[0].negation,'否定表达');
  assert.equal(view.detailCues[1].degree,'较强');
  h.receive({type:'transcript',device_id:'s3',recording_id:'r',segment_id:0,revision:2,text:'不是不开心。',final:true,start_ms:0,end_ms:2200});h.flush();
  assert.notEqual(h.page.cueCache.get('r:0').analysis,analysis);
  assert.equal(h.page.data.groups[0].segments[0].detailCues[0].negation,'双重否定表达');
});

test('only one emotion detail is expanded and trimmed histories release cue caches',()=>{
  const h=harness();
  const line=n=>({type:'transcript',device_id:'s3',recording_id:'r',segment_id:n,revision:1,text:'我很开心。',final:true,start_ms:n*1000,end_ms:(n+1)*1000});
  h.receive(line(0));h.receive(line(1));h.flush();
  h.page.toggleEmotionDetails({currentTarget:{dataset:{key:'r:0'}}});h.flush();
  h.page.toggleEmotionDetails({currentTarget:{dataset:{key:'r:1'}}});h.flush();
  const list=h.page.data.groups[0].segments;
  assert.equal(list[0].detailsOpen,false);assert.equal(list[1].detailsOpen,true);
  assert.equal(h.page.cueCache.size,2);
  h.page.state=p.initialState('s3');h.page.scheduleRender();h.flush();
  assert.equal(h.page.cueCache.size,0);assert.equal(h.page.cueViews.size,0);assert.equal(h.page.expandedEmotionKey,null);
});

test('audio quality is optional, concise by default, and numeric only inside details',()=>{
  const h=harness();
  h.receive({type:'transcript',device_id:'s3',recording_id:'r',segment_id:0,revision:1,text:'非常生气。',final:true,start_ms:0,end_ms:700});
  h.receive({type:'emotion',device_id:'s3',recording_id:'r',segment_id:0,label:'neutral',status:'ready',event:'speech',
    audio_quality:{duration_ms:700,analyzed_ms:700,peak:1,rms_dbfs:-10,clipping_ratio:0.02,reason:'short_context'}});h.flush();
  let view=h.page.data.groups[0].segments[0];
  assert.ok(view.qualityNote.includes('片段较短'));assert.ok(view.qualityNote.includes('声音可能过载'));
  assert.equal(view.qualityDetail,'');assert.equal(view.emotion.label,'neutral');
  h.page.toggleEmotionDetails({currentTarget:{dataset:{key:'r:0'}}});h.flush();
  view=h.page.data.groups[0].segments[0];
  assert.ok(view.qualityDetail.includes('削波比例 2.00%'));assert.ok(view.qualityDetail.includes('RMS -10.0 dBFS'));
  h.receive({type:'emotion',device_id:'s3',recording_id:'r',segment_id:0,label:'neutral',status:'ready',event:'speech',
    audio_quality:{duration_ms:700,analyzed_ms:500,peak:0.8,rms_dbfs:-16,clipping_ratio:0,reason:'short_context'}});h.flush();
  assert.ok(h.page.data.groups[0].segments[0].qualityDetail.includes('分析 0.50 秒'));
});

test('silent audio has an explicit quality hint and duration describes the supplied segment',()=>{
  const h=harness();
  h.receive({type:'transcript',device_id:'s3',recording_id:'r',segment_id:0,revision:1,text:'识别到的文字。',final:true,start_ms:0,end_ms:20000});
  h.receive({type:'emotion',device_id:'s3',recording_id:'r',segment_id:0,label:'unknown',status:'skipped',
    audio_quality:{duration_ms:12000,analyzed_ms:0,peak:0,rms_dbfs:-120,clipping_ratio:0,reason:'no_signal'}});h.flush();
  let view=h.page.data.groups[0].segments[0];
  assert.equal(view.qualityNote,'未检测到有效音频信号');
  assert.equal(view.qualityDetail,'');
  assert.equal(view.emotion.label,'unknown');
  h.page.toggleEmotionDetails({currentTarget:{dataset:{key:'r:0'}}});h.flush();
  view=h.page.data.groups[0].segments[0];
  assert.ok(view.qualityDetail.includes('送入片段 12.00 秒'));
  assert.ok(view.qualityDetail.includes('分析 0.00 秒'));
  assert.ok(!view.qualityDetail.includes('原分句'));
});

const historyLine={type:'transcript',device_id:'s3',recording_id:'r',segment_id:0,revision:1,text:'原来不开心。',final:true,start_ms:0,end_ms:1000};
const historyEvent=(source)=>({currentTarget:{dataset:{key:'r:0',source}}});
function corrected(h,version,text,requestId){h.receive({type:'history_corrected',device_id:'s3',recording_id:'r',segment_id:0,
  request_id:requestId,edit_version:version,corrected_text:text,corrected_at:'2026-11-07T00:00:00Z'});}

test('saved corrections render and highlight independently while original text and acoustic emotion stay intact',()=>{
  const h=harness();h.receive(historyLine);h.flush();
  h.receive({type:'emotion',device_id:'s3',recording_id:'r',segment_id:0,label:'sad',status:'ready'});h.flush();
  const lexical=h.page.cueCache.get('r:0').analysis;
  corrected(h,1,'现在非常开心。');h.flush();
  let view=h.page.data.groups[0].segments[0];
  assert.equal(view.text,historyLine.text);assert.equal(view.corrected_text,'现在非常开心。');
  assert.equal(view.cueTokens.map(item=>item.text).join(''),'现在非常开心。');
  assert.notEqual(h.page.cueCache.get('r:0').analysis,lexical);
  assert.equal(view.emotion.label,'sad');
  h.page.toggleOriginal(historyEvent());h.flush();assert.equal(h.page.data.groups[0].segments[0].originalOpen,true);
  corrected(h,2,null);h.flush();view=h.page.data.groups[0].segments[0];
  assert.equal(view.corrected_text,null);assert.equal(view.text,historyLine.text);
  assert.equal(view.cueTokens.map(item=>item.text).join(''),historyLine.text);
});

test('correction saves and restores are versioned, wait for matching confirmation, and never auto-push',()=>{
  const h=harness();h.receive(historyLine);h.flush();h.page.openCorrection(historyEvent());
  h.page.inputCorrection({detail:{value:'  现在很开心。  '}});h.page.saveCorrection();h.page.saveCorrection();
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].type,'history_correct');assert.equal(h.sent[0].text,'现在很开心。');
  assert.equal(h.sent[0].expected_edit_version,0);assert.equal(h.page.data.historyEditor.saving,true);
  assert.equal(h.page.state.segments[0].corrected_text,null,'unsaved draft is not applied to subtitle');
  corrected(h,1,'现在很开心。','another-request');
  assert.equal(h.page.data.historyEditor.saving,true,'another client acknowledgement cannot complete this save');
  corrected(h,1,'现在很开心。',h.sent[0].request_id);h.flush();
  assert.equal(h.page.data.historyEditor.saving,false);assert.equal(h.page.data.historyEditor.version,1);
  assert.ok(h.page.data.historyEditor.status.includes('尚未推送'));
  h.page.saveCorrection({currentTarget:{dataset:{restore:true}}});
  assert.equal(h.sent[1].text,null);assert.equal(h.sent[1].expected_edit_version,1);
  corrected(h,2,null,h.sent[1].request_id);h.flush();
  assert.equal(h.page.data.historyEditor.hasCorrection,false);
  assert.equal(h.page.data.historyEditor.draft,historyLine.text);
  assert.equal(h.sent.filter(item=>item.type==='history_display').length,0);
});

test('version conflicts preserve a local draft and require explicit reload before retrying',()=>{
  const h=harness();h.receive(historyLine);h.flush();h.page.openCorrection(historyEvent());
  h.page.inputCorrection({detail:{value:'我的未保存草稿'}});h.page.saveCorrection();
  h.receive({type:'error',code:'history_conflict',request_id:h.sent[0].request_id});
  h.receive({type:'snapshot',device_id:'s3',state:'idle',history:[Object.assign({},historyLine,{edit_version:1,corrected_text:'另一端保存',corrected_at:'2026-11-07'})]});h.flush();
  assert.equal(h.page.data.historyEditor.draft,'我的未保存草稿');assert.equal(h.page.data.historyEditor.version,0);
  assert.equal(h.page.data.historyEditor.conflict,true);h.page.saveCorrection();assert.equal(h.sent.length,1);
  h.page.reloadCorrection();assert.equal(h.page.data.historyEditor.draft,'另一端保存');assert.equal(h.page.data.historyEditor.version,1);
  assert.equal(h.page.data.historyEditor.conflict,false);h.page.inputCorrection({detail:{value:'新草稿'}});h.page.saveCorrection();
  assert.equal(h.sent[1].expected_edit_version,1);
  h.page.onHide();assert.equal(h.page.data.historyEditor.draft,'新草稿');assert.equal(h.page.data.historyEditor.saving,false);
  assert.equal(h.page.data.historyEditor.conflict,true);assert.equal(h.page.correctionTimer,null);
});

test('invalid drafts and partial subtitles cannot create correction requests',()=>{
  const h=harness();h.receive(Object.assign({},historyLine,{final:false}));h.flush();h.page.openCorrection(historyEvent());
  assert.equal(h.page.data.historyEditor,null);h.receive(Object.assign({},historyLine,{revision:2}));h.flush();h.page.openCorrection(historyEvent());
  for(const draft of ['   ','字'.repeat(513),'😀'.repeat(385)]){
    h.page.inputCorrection({detail:{value:draft}});h.page.saveCorrection();assert.equal(h.sent.length,0);
  }
});

test('OLED push requires a declared capability, idle device and a matching device acknowledgement',()=>{
  const h=harness();h.receive(historyLine);corrected(h,1,'校对文字');h.flush();
  h.page.displayHistory(historyEvent('corrected'));assert.equal(h.sent.length,0);assert.ok(h.page.data.errorText.includes('升级'));
  h.receive({type:'snapshot',device_id:'s3',state:'recording',recording_id:'active',capabilities:['history_display'],history:[]});
  h.page.displayHistory(historyEvent('corrected'));assert.equal(h.sent.length,0);
  h.receive({type:'status',device_id:'s3',state:'idle',recording_id:null});h.flush();
  h.page.displayHistory(historyEvent('corrected'));h.page.displayHistory(historyEvent('original'));
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].source,'corrected');assert.equal(h.sent[0].expected_edit_version,1);
  const id=h.sent[0].request_id;
  h.receive({type:'display_pending',request_id:id});assert.equal(h.page.data.historyDisplayPending,true);
  assert.ok(h.page.data.historyDisplayStatus.includes('等待 OLED'));
  h.receive({type:'history_displayed',request_id:id,recording_id:'different',segment_id:0,source:'corrected',edit_version:1});
  assert.equal(h.page.data.historyDisplayPending,true);
  h.receive({type:'history_displayed',request_id:id,recording_id:'r',segment_id:0,source:'corrected',edit_version:1});
  assert.equal(h.page.data.historyDisplayPending,false);assert.ok(h.page.data.historyDisplayStatus.includes('OLED 已确认'));
  h.page.displayHistory(historyEvent('original'));assert.equal(h.sent[1].source,'original');assert.equal(h.sent[1].expected_edit_version,undefined);
  h.receive({type:'history_displayed',request_id:h.sent[1].request_id,recording_id:'r',segment_id:0,source:'original',edit_version:99});
  assert.ok(h.page.data.historyDisplayStatus.includes('原始版'));
});

test('push timeout and busy failures never claim success or change the live caption',()=>{
  const h=harness();h.receive(historyLine);
  h.receive({type:'snapshot',device_id:'s3',state:'idle',capabilities:['history_display'],history:[]});h.flush();
  h.page.displayHistory(historyEvent('original'));h.receive({type:'error',code:'display_busy',request_id:h.sent[0].request_id});
  assert.equal(h.page.data.historyDisplayPending,false);assert.ok(h.page.data.historyDisplayStatus.includes('正在录音'));
  assert.equal(h.page.state.segments[0].text,historyLine.text);
  h.page.displayHistory(historyEvent('original'));h.flush();
  assert.equal(h.page.data.historyDisplayPending,false);assert.ok(h.page.data.historyDisplayStatus.includes('结果未知'));
  assert.equal(h.page.historyDisplayTimer,null);
});

test('changed correction versions and mismatched display acknowledgements never claim the selected version was shown',()=>{
  const h=harness();h.receive(historyLine);corrected(h,1,'已保存校对');
  h.receive({type:'snapshot',device_id:'s3',state:'idle',capabilities:['history_display'],history:[]});h.flush();
  h.page.displayHistory(historyEvent('corrected'));
  h.receive({type:'error',code:'history_conflict',request_id:h.sent[0].request_id});
  assert.equal(h.page.data.historyDisplayPending,false);assert.ok(h.page.data.historyDisplayStatus.includes('重新推送'));
  assert.ok(!h.page.data.historyDisplayStatus.includes('草稿已保留'));
  h.page.displayHistory(historyEvent('corrected'));
  h.receive({type:'history_displayed',request_id:h.sent[1].request_id,recording_id:'r',segment_id:0,source:'corrected',edit_version:2});
  assert.equal(h.page.data.historyDisplayPending,false);assert.ok(h.page.data.historyDisplayStatus.includes('版本不同'));
  assert.ok(!h.page.data.historyDisplayStatus.includes('OLED 已确认'));
});
