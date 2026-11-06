'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');

class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.type='text';this.handlers={};this.parent=null;this._text='';this.style={setProperty(){}};this.classList={toggle(){}};}
  get textContent(){return this.children.length?this.children.map(node=>node.textContent).join(''):this._text;}
  set textContent(value){this._text=String(value);this.children=[];}
  append(...nodes){nodes.forEach(node=>{if(node.tagName==='#fragment'){this.append(...node.children.slice());return;}node.remove();node.parent=this;this.children.push(node);});}
  replaceChildren(...nodes){this.children.forEach(node=>{node.parent=null;});this.children=[];this._text='';this.append(...nodes);}
  insertBefore(node,before){node.remove();node.parent=this;const index=this.children.indexOf(before);this.children.splice(index<0?this.children.length:index,0,node);}
  remove(){if(this.parent){const index=this.parent.children.indexOf(this);if(index>=0)this.parent.children.splice(index,1);this.parent=null;}}
  get lastElementChild(){return this.children[this.children.length-1];}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key]||null;}
  removeAttribute(key){delete this.attributes[key];}
  addEventListener(type,handler){(this.handlers[type]||(this.handlers[type]=[])).push(handler);}
  closest(selector){let node=this;while(node){if(node.tagName==='button'&&((selector==='button[data-action]'&&node.dataset.action)||(selector==='button[data-recording]'&&node.dataset.recording)))return node;node=node.parent;}return null;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  emit(type,event={}){(this.handlers[type]||[]).forEach(handler=>handler(Object.assign({target:this,preventDefault(){}},event)));}
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function harness(options={}){
  const nodes=new Map(),doc=new Element('document'),winHandlers={},timers=new Map(),sockets=[],configs=[],healths=[];
  let now=0,id=0;
  const later=(fn,ms)=>{const key=++id;timers.set(key,{fn,at:now+ms,ms});return key;};
  const advance=ms=>{const end=now+ms;for(let count=0;count<10000;count++){const due=Array.from(timers).filter(([,value])=>value.at<=end).sort((a,b)=>a[1].at-b[1].at);if(!due.length){now=end;return;}const[key,value]=due[0];timers.delete(key);now=value.at;value.fn();}throw Error('timer loop');};
  doc.hidden=false;doc.activeElement=null;doc.body=new Element('body');
  doc.getElementById=key=>{if(!nodes.has(key)){const node=new Element();node.id=key;if(key==='animation')node.type='checkbox';nodes.set(key,node);}return nodes.get(key);};
  doc.createElement=tag=>new Element(tag);doc.createTextNode=value=>{const node=new Element('#text');node.textContent=value;return node;};doc.createDocumentFragment=()=>new Element('#fragment');
  const response=value=>({ok:true,json:async()=>value});
  const fetch=(url,init)=>{
    if(url==='/api/console'){const call=deferred();call.signal=init.signal;configs.push(call);return call.promise.then(response);}
    if(url==='/api/health'&&options.manualHealth){const call=deferred();call.signal=init.signal;healths.push(call);return call.promise.then(response);}
    return Promise.resolve(response({ready:true,emotion:'ready'}));
  };
  class Socket{constructor(url){this.url=url;this.sent=[];this.bufferedAmount=0;sockets.push(this);}send(data){this.sent.push(JSON.parse(data));}close(){if(this.onclose)this.onclose({code:1000});}}
  const context=vm.createContext({document:doc,navigator:{},console,AbortController,fetch,WebSocket:Socket,setTimeout:later,clearTimeout:key=>timers.delete(key)});
  context.windowListeners=(type,fn)=>{winHandlers[type]=fn;};
  vm.runInContext('window=globalThis;window.addEventListener=(type,fn)=>windowListeners(type,fn);',context);
  const base=path.resolve(__dirname,'..');
  vm.runInContext(fs.readFileSync(path.join(base,'../miniprogram/utils/protocol.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(base,'core.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(base,'app.js'),'utf8'),context);
  const flush=async()=>{for(let n=0;n<16;n++)await Promise.resolve();};
  const open=(capabilities=[])=>{
    const socket=sockets[sockets.length-1];socket.onopen();
    socket.onmessage({data:JSON.stringify({type:'hello',protocol:1,device_id:'s3',ready:true,settings:context.VoiceProtocol.DEFAULT_SETTINGS,capabilities})});
    socket.onmessage({data:JSON.stringify({type:'snapshot',device_id:'s3',state:'idle',recording_id:null,settings:context.VoiceProtocol.DEFAULT_SETTINGS,history:[],capabilities})});
    advance(100);return socket;
  };
  const configuration={url:'ws://127.0.0.1:8765',device_id:'s3',token:'synthetic-test-token',addresses:['192.168.1.2'],advertise:'192.168.1.2',port:8765};
  return{nodes,doc,timers,sockets,configs,healths,advance,flush,open,configuration,unload:()=>winHandlers.beforeunload()};
}
test('double submit before the batched disabled frame keeps the first pending request and accepts its real ACK',async()=>{
  const h=harness();h.configs[0].resolve(h.configuration);await h.flush();const socket=h.open();
  h.nodes.get('font-scale').value='3';h.nodes.get('font-scale').emit('input');
  h.nodes.get('settings-form').emit('submit');h.nodes.get('settings-form').emit('submit');
  const messages=socket.sent.filter(message=>message.type==='settings_set');assert.equal(messages.length,1);
  socket.onmessage({data:JSON.stringify({type:'settings_applied',device_id:'s3',request_id:messages[0].request_id,settings:messages[0].settings})});h.advance(100);
  assert.equal(h.nodes.get('settings-status').textContent,'开发板已应用并确认');assert.equal(h.nodes.get('apply-settings').disabled,false);
  h.unload();
});
test('pause invalidates an in-flight bootstrap, including a late fetch that ignores abort, and stays paused across visibility',async()=>{
  const h=harness();h.nodes.get('pause-connection').emit('click');
  assert.equal(h.configs[0].signal.aborted,true);
  h.configs[0].resolve(h.configuration);await h.flush();h.advance(100);assert.equal(h.sockets.length,0);
  h.doc.hidden=true;h.doc.emit('visibilitychange');h.doc.hidden=false;h.doc.emit('visibilitychange');await h.flush();h.advance(100);
  assert.equal(h.configs.length,1);assert.equal(h.sockets.length,0);
  h.nodes.get('reconnect').emit('click');assert.equal(h.configs.length,2);h.configs[1].resolve(h.configuration);await h.flush();assert.equal(h.sockets.length,1);
  h.unload();
});
test('a stale aborted health request cannot overwrite a newer successful health result or schedule another poll',async()=>{
  const h=harness({manualHealth:true});h.configs[0].resolve(h.configuration);await h.flush();h.open();assert.equal(h.healths.length,1);
  h.doc.hidden=true;h.doc.emit('visibilitychange');h.doc.hidden=false;h.doc.emit('visibilitychange');assert.equal(h.healths.length,2);
  h.healths[1].resolve({ready:true,emotion:'ready'});await h.flush();h.advance(100);
  const aborted=new Error('old request aborted');aborted.name='AbortError';h.healths[0].reject(aborted);await h.flush();h.advance(100);
  assert.equal(h.nodes.get('service-asr').textContent,'Paraformer · INT8 已就绪');assert.equal(h.nodes.get('service-emotion').textContent,'已就绪 · 独立进程');
  assert.equal(Array.from(h.timers.values()).filter(timer=>timer.ms===10000).length,1);h.unload();
});
test('silent SER clips keep their no-signal reason and describe the supplied clip rather than the original sentence',async()=>{
  const h=harness();h.configs[0].resolve(h.configuration);await h.flush();const socket=h.open();
  socket.onmessage({data:JSON.stringify({type:'transcript',device_id:'s3',recording_id:'r',segment_id:0,revision:1,text:'静音测试',final:true,start_ms:0,end_ms:2000})});
  socket.onmessage({data:JSON.stringify({type:'emotion',device_id:'s3',recording_id:'r',segment_id:0,label:'unknown',status:'skipped',audio_quality:{duration_ms:2000,analyzed_ms:0,peak:0,rms_dbfs:-120,clipping_ratio:0,reason:'no_signal'}})});
  h.advance(100);
  const content=h.nodes.get('history-list').textContent;
  assert.ok(content.includes('片段几乎无声'));assert.ok(content.includes('送入片段 2.00 秒'));assert.ok(!content.includes('原分句'));
  h.unload();
});
function find(root,predicate){if(predicate(root))return root;for(const child of root.children){const result=find(child,predicate);if(result)return result;}return null;}
function receive(socket,message){socket.onmessage({data:JSON.stringify(message)});}
const savedCaption={type:'transcript',device_id:'s3',recording_id:'history-r',segment_id:0,revision:2,text:'原始识别始终保留',final:true,start_ms:0,end_ms:2000,edit_version:0,corrected_text:null,corrected_at:null};
function historyAction(h,action,source){const button=find(h.nodes.get('history-list'),node=>node.dataset.action===action&&(!source||node.dataset.source===source));assert.ok(button,'history action must exist');h.nodes.get('history-list').emit('click',{target:button});return button;}
test('history double-save keeps the original text and does not push OLED until an explicit acknowledged display request',async()=>{
  const h=harness();h.configs[0].resolve(h.configuration);await h.flush();const socket=h.open(['history_display']);receive(socket,savedCaption);h.advance(100);
  historyAction(h,'edit');h.nodes.get('correction-text').value='校对后的文字';h.nodes.get('correction-text').emit('input');h.nodes.get('correction-form').emit('submit');h.nodes.get('correction-form').emit('submit');
  const corrections=socket.sent.filter(message=>message.type==='history_correct');assert.equal(corrections.length,1);assert.equal(corrections[0].expected_edit_version,0);
  receive(socket,{type:'history_corrected',device_id:'s3',recording_id:'history-r',segment_id:0,request_id:corrections[0].request_id,edit_version:1,corrected_text:'校对后的文字',corrected_at:'2026-11-07T00:00:00Z'});h.advance(100);
  assert.ok(h.nodes.get('history-list').textContent.includes(savedCaption.text));assert.ok(h.nodes.get('history-list').textContent.includes('校对后的文字'));
  assert.equal(socket.sent.filter(message=>message.type==='history_display').length,0);
  historyAction(h,'display','corrected');historyAction(h,'display','corrected');const displays=socket.sent.filter(message=>message.type==='history_display');assert.equal(displays.length,1);assert.equal(displays[0].expected_edit_version,1);
  receive(socket,{type:'display_pending',request_id:displays[0].request_id});h.advance(100);assert.ok(!h.nodes.get('history-list').textContent.includes('OLED 已确认显示'));
  receive(socket,{type:'history_displayed',request_id:displays[0].request_id,recording_id:'history-r',segment_id:0,source:'original',edit_version:1});h.advance(100);assert.ok(!h.nodes.get('history-list').textContent.includes('OLED 已确认显示'));
  receive(socket,{type:'history_displayed',request_id:displays[0].request_id,recording_id:'history-r',segment_id:0,source:'corrected',edit_version:1});h.advance(100);assert.ok(h.nodes.get('history-list').textContent.includes('OLED 已确认显示校对后文字'));
  h.unload();
});
test('conflicting correction retains the exact draft until the user explicitly rebases to the latest saved version',async()=>{
  const h=harness();h.configs[0].resolve(h.configuration);await h.flush();const socket=h.open(['history_display']);receive(socket,savedCaption);h.advance(100);
  historyAction(h,'edit');h.nodes.get('correction-text').value='我的冲突草稿';h.nodes.get('correction-text').emit('input');h.nodes.get('correction-form').emit('submit');
  const first=socket.sent.find(message=>message.type==='history_correct');receive(socket,{type:'error',code:'history_conflict',request_id:first.request_id,message:'另一端已修改'});
  receive(socket,{type:'snapshot',device_id:'s3',state:'idle',capabilities:['history_display'],history:[Object.assign({},savedCaption,{edit_version:2,corrected_text:'另一端保存的文字',corrected_at:'2026-11-07'})]});h.advance(100);
  assert.equal(h.nodes.get('correction-text').value,'我的冲突草稿');assert.equal(h.nodes.get('correction-current').textContent,'另一端保存的文字');assert.equal(h.nodes.get('save-correction').disabled,true);
  h.nodes.get('correction-form').emit('submit');assert.equal(socket.sent.filter(message=>message.type==='history_correct').length,1);
  h.nodes.get('correction-rebase').emit('click');h.nodes.get('correction-form').emit('submit');const second=socket.sent.filter(message=>message.type==='history_correct')[1];assert.equal(second.expected_edit_version,2);assert.equal(second.text,'我的冲突草稿');
  h.unload();
});
