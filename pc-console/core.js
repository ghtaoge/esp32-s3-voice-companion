(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../miniprogram/utils/protocol'));
  else root.VoiceConsole = factory(root.VoiceProtocol);
})(typeof globalThis === 'object' ? globalThis : this, function (protocol) {
  'use strict';

  function ipv4(value) {
    if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
    return value.split('.').every(part => String(Number(part)) === part && Number(part) >= 0 && Number(part) <= 255);
  }
  function consoleInfo(value) {
    if (!value || typeof value !== 'object') throw new Error('电脑配对信息格式不正确');
    const connection = protocol.normalizeConnection(value);
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('ASR 端口配置不正确');
    const addresses = Array.from(new Set((Array.isArray(value.addresses) ? value.addresses : []).filter(ipv4))).slice(0,32);
    return Object.assign(connection, {addresses, port:value.port, advertise:addresses.includes(value.advertise) ? value.advertise : addresses[0] || ''});
  }
  function pairing(info, address) {
    if (!info.addresses.includes(address)) throw new Error('请选择电脑已列出的局域网地址');
    return {url:'ws://' + address + ':' + info.port, device_id:info.device_id, token:info.token};
  }
  function number(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
  function emotionStats(state) {
    const counts={};let total=0;
    Object.keys(protocol.EMOTIONS).filter(label=>label!=='unknown').forEach(label=>{counts[label]=0;});
    state.segments.forEach(segment=>{
      const emotion=segment.emotion;
      if(emotion&&emotion.status==='ready'&&Object.prototype.hasOwnProperty.call(counts,emotion.label)){counts[emotion.label]++;total++;}
    });
    return {total,items:Object.keys(counts).map(label=>({label,text:protocol.EMOTIONS[label],count:counts[label],share:total?counts[label]/total:0}))};
  }
  function cueParts(text,cues) {
    const source=typeof text==='string'?text:'';
    const split=index=>index>0&&index<source.length&&/[\ud800-\udbff]/.test(source[index-1])&&/[\udc00-\udfff]/.test(source[index]);
    const valid=(Array.isArray(cues)?cues:[]).slice(0,64).filter(cue=>cue&&Number.isInteger(cue.start)&&Number.isInteger(cue.end)&&cue.start>=0&&cue.end>cue.start&&cue.end<=source.length&&!split(cue.start)&&!split(cue.end)).sort((a,b)=>a.start-b.start);
    const result=[];let cursor=0,used=0;
    valid.forEach(cue=>{
      if(cue.start<cursor||used>=16)return;
      if(cue.start>cursor)result.push({text:source.slice(cursor,cue.start)});
      result.push({text:source.slice(cue.start,cue.end),cue});cursor=cue.end;used++;
    });
    if(cursor<source.length)result.push({text:source.slice(cursor)});
    return result;
  }

  class Model {
    constructor(deviceId) {
      this.state = protocol.initialState(deviceId);
      this.draft = Object.assign({},protocol.DEFAULT_SETTINGS);
      this.dirty = false;
      this.pending = null;
      this.editor=null;
      this.correctionPending=null;
      this.displayPending=null;
      this.historyKey='';
      this.historyMessage='';
      this.settingsMessage = '连接后读取开发板实际设置';
      this.error = '';
      this.level = 0;
      this.connection = 'connecting';
      this.health = null;
      this.metrics = null;
      this.buildGroups = protocol.groupBuilder();
    }
    receive(message) {
      if (!message || typeof message !== 'object' || (message.device_id && message.device_id !== this.state.device_id)) return false;
      if (message.type === 'level') {
        if (message.recording_id !== this.state.recording_id || !Number.isFinite(message.level)) return false;
        const level = Math.max(0,Math.min(1,message.level));
        if (this.level === level) return false;
        this.level = level;
        return true;
      }
      if (message.type === 'error') {
        const publicMessage = protocol.boundedText(message.message,200) || '服务返回错误，请查看电脑日志';
        if(this.correctionPending&&message.request_id===this.correctionPending.id){
          this.correctionPending=null;
          if(this.editor&&message.code==='history_conflict')this.editor.conflict=true;
          this.historyMessage=message.code==='history_conflict'?'另一端已更新校对，草稿已保留。查看最新版本后，点击“基于最新版本继续编辑”。':publicMessage;
          return true;
        }
        if(this.displayPending&&message.request_id===this.displayPending.id){this.displayPending=null;this.historyMessage=publicMessage;return true;}
        this.error=publicMessage;
        if (this.pending && message.request_id === this.pending.id) this.failSettings('设备未确认这次设置');
        return true;
      }
      if (message.type === 'settings_pending' && this.pending && this.pending.id === message.request_id) {
        this.settingsMessage = '电脑已转发，等待开发板确认…';
        return true;
      }
      const previous = this.state;
      this.state = protocol.reduce(this.state,message);
      if(message.type==='history_corrected'&&this.correctionPending&&message.request_id===this.correctionPending.id){
        const pending=this.correctionPending,segment=this.segment(pending.key);
        if(message.recording_id===pending.recording_id&&message.segment_id===pending.segment_id&&segment&&segment.edit_version===message.edit_version&&message.edit_version>pending.version){
          this.correctionPending=null;this.editor=null;
          this.historyMessage=segment.corrected_text===null?'已恢复原始识别，尚未推送屏幕。':'校对已保存，尚未推送屏幕。';
        }
      }
      if(this.editor){const segment=this.segment(this.editor.key);if(segment&&segment.edit_version>this.editor.version){this.editor.conflict=true;this.historyMessage='保存版本已在另一端更新，当前草稿保留。请先查看最新校对再继续。';}}
      if(message.type==='display_pending'&&this.displayPending&&message.request_id===this.displayPending.id){this.historyMessage='推送已转发，等待 OLED 确认…';return true;}
      if(message.type==='history_displayed'&&this.displayPending&&message.request_id===this.displayPending.id){
        const pending=this.displayPending;
        if(message.recording_id===pending.recording_id&&message.segment_id===pending.segment_id&&message.source===pending.source&&(pending.source==='original'||message.edit_version===pending.version)){
          this.displayPending=null;this.historyMessage=pending.source==='original'?'OLED 已确认显示原始识别。':'OLED 已确认显示校对后文字。';return true;
        }
      }
      if (message.type === 'settings_applied' && this.pending && this.pending.id === message.request_id) {
        try {
          this.draft = protocol.validateSettings(message.settings);
          this.dirty = false;
          this.pending = null;
          this.settingsMessage = '开发板已应用并确认';
        } catch (_) { this.failSettings('设备确认格式不正确，请刷新实际设置'); }
      } else if (['hello','snapshot','settings_applied'].includes(message.type) && this.state.settings_known && !this.dirty && !this.pending) {
        this.draft = Object.assign({},this.state.settings);
      }
      if (message.type === 'recording_done' && typeof message.recording_id === 'string') {
        this.metrics = {recording_id:message.recording_id,audio_ms:number(message.audio_ms),final_latency_ms:number(message.final_latency_ms),
          first_partial_ms:number(message.first_partial_ms),asr_inference_ms:number(message.asr_inference_ms),audio_queue_peak_ms:number(message.audio_queue_peak_ms)};
      }
      if (message.type === 'status') {
        if (message.state !== 'recording') this.level = 0;
        if (message.state !== 'error') this.error = '';
      }
      return previous !== this.state;
    }
    edit(patch) {
      if (this.pending) return;
      this.draft = protocol.validateSettings(Object.assign({},this.draft,patch));
      this.dirty = Object.keys(protocol.DEFAULT_SETTINGS).some(key => this.draft[key] !== this.state.settings[key]);
      this.settingsMessage = this.dirty ? '草稿尚未应用到开发板' : '与开发板当前设置一致';
    }
    restore() {
      if (!this.state.settings_known || this.pending) return;
      this.draft = Object.assign({},this.state.settings);
      this.dirty = false;
      this.settingsMessage = '已恢复设备当前设置';
    }
    apply(id) {
      if (this.pending) throw new Error('请先等待上一项设置确认');
      if (this.connection !== 'connected' || this.state.state === 'offline') throw new Error('请先连接开发板');
      const settings = protocol.validateSettings(this.draft);
      this.pending = {id,settings};
      this.settingsMessage = '正在发送设置…';
      return {type:'settings_set',request_id:id,settings};
    }
    failSettings(message) { this.pending = null;this.settingsMessage = message; }
    disconnected() {
      this.level = 0;
      if (this.pending) this.failSettings('连接中断，应用结果未知；重连后读取实际设置');
      if(this.correctionPending){this.correctionPending=null;this.historyMessage='连接已变化，保存结果未确认；草稿保留，请刷新历史核对。';}
      if(this.displayPending){this.displayPending=null;this.historyMessage='连接已变化，推送结果未确认；请检查 OLED 后重试。';}
    }
    segment(key){return this.state.segments.find(segment=>segment.key===key);}
    openEditor(key){
      const segment=this.segment(key);
      if(!segment||!segment.final)throw new Error('只能校对已完成的分句');
      if(this.correctionPending)throw new Error('请等待这次校对保存完成');
      if(this.editor&&this.editor.key===key)return;
      if(this.editor)throw new Error('请先保存或取消当前校对草稿');
      this.editor={key,text:protocol.displayText(segment),version:segment.edit_version||0,conflict:false};this.historyKey=key;this.historyMessage='校对只修改显示版，不会覆盖这条历史的原始识别。';
    }
    changeCorrection(text){if(this.editor&&!this.correctionPending)this.editor.text=typeof text==='string'?text.slice(0,2048):'';}
    rebaseCorrection(){if(this.editor&&!this.correctionPending){const segment=this.segment(this.editor.key);if(segment){this.editor.version=segment.edit_version||0;this.editor.conflict=false;this.historyMessage='已采用最新保存版本作为基准，草稿未改变。请确认后保存。';}}}
    correct(id,restore){
      if(this.correctionPending)throw new Error('校对正在保存，请等待确认');
      if(this.connection!=='connected')throw new Error('请先连接 ASR 服务');
      if(!this.editor)throw new Error('请先选择需要校对的分句');
      if(this.editor.conflict)throw new Error('请先查看最新校对，并基于最新版本继续编辑');
      const segment=this.segment(this.editor.key);
      if(!segment||!segment.final)throw new Error('分句已不在当前缓存，请刷新历史');
      const text=protocol.validateCorrection(restore?null:this.editor.text);
      this.correctionPending={id,key:segment.key,recording_id:segment.recording_id,segment_id:segment.segment_id,version:this.editor.version};
      this.historyKey=segment.key;this.historyMessage='正在保存校对，尚未推送 OLED…';
      return{type:'history_correct',request_id:id,recording_id:segment.recording_id,segment_id:segment.segment_id,expected_edit_version:this.editor.version,text};
    }
    failCorrection(message){this.correctionPending=null;this.historyMessage=message;}
    canDisplay(){return this.connection==='connected'&&!['offline','recording','processing'].includes(this.state.state)&&this.state.capabilities.includes('history_display')&&!this.displayPending&&!this.correctionPending;}
    display(id,key,source){
      if(this.displayPending)throw new Error('请等待上一条 OLED 推送确认');
      if(!this.state.capabilities.includes('history_display'))throw new Error('当前固件不支持历史推送，请更新固件后重连');
      if(!this.canDisplay())throw new Error('请等待录音与识别结束，并确认开发板在线');
      const segment=this.segment(key);
      if(!segment||!segment.final)throw new Error('只能推送已完成的分句');
      if(!['original','corrected'].includes(source))throw new Error('推送来源无效');
      if(source==='corrected'&&segment.corrected_text===null)throw new Error('这句话还没有保存校对版本');
      this.displayPending={id,key,recording_id:segment.recording_id,segment_id:segment.segment_id,source,version:segment.edit_version};
      this.historyKey=key;this.historyMessage='正在推送'+(source==='original'?'原始识别':'校对后文字')+'，等待 OLED 确认…';
      const message={type:'history_display',request_id:id,recording_id:segment.recording_id,segment_id:segment.segment_id,source};
      if(source==='corrected')message.expected_edit_version=segment.edit_version;
      return message;
    }
    failDisplay(message){this.displayPending=null;this.historyMessage=message;}
    groups() { return this.buildGroups(this.state); }
  }

  class SocketLink {
    constructor(options) {
      this.create = options.createSocket || (url => new WebSocket(url));
      this.change = options.onState || function(){};
      this.message = options.onMessage || function(){};
      // Window timer methods require their native receiver. Store closures,
      // never rebind Web APIs as methods of this SocketLink instance.
      this.later = options.setTimeout || ((fn,ms) => setTimeout(fn,ms));
      this.cancel = options.clearTimeout || (id => clearTimeout(id));
      this.now = options.now || (() => Date.now());
      this.random = options.random || (() => Math.random());
      this.visible = true;
      this.enabled = false;
      this.epoch = 0;
      this.attempt = 0;
      this.retry = this.heartbeat = this.watchdog = null;
      this.socket = null;
      this.opened = false;
      this.openedAt = this.lastReceived = 0;
    }
    retire() {
      this.epoch++;
      ['retry','heartbeat','watchdog'].forEach(key => {if(this[key]!==null)this.cancel(this[key]);this[key]=null;});
      const old = this.socket;
      this.socket = null;this.opened = false;
      if(old){try{old.close(1000,'console pause');}catch(_){}}
    }
    start(url) {this.retire();this.url=url;this.enabled=true;this.attempt=0;if(this.visible)this.open();}
    foreground(visible) {
      this.visible = visible;
      if(!visible){this.retire();this.change('paused');}
      else if(this.enabled&&!this.socket&&this.retry===null)this.open();
    }
    open() {
      if(!this.enabled||!this.visible)return;
      const epoch = ++this.epoch;
      this.change('connecting');
      let socket;
      try{socket=this.create(this.url);}catch(_){this.failed(epoch);return;}
      this.socket=socket;
      this.watchdog=this.later(()=>this.failed(epoch),12000);
      socket.onopen=()=>{
        if(epoch!==this.epoch)return;
        this.opened=true;this.openedAt=this.lastReceived=this.now();
        this.cancel(this.watchdog);this.watchdog=null;
        this.change('connected');this.watch(epoch);this.beat(epoch);
      };
      socket.onmessage=event=>{
        if(epoch!==this.epoch||!this.opened)return;
        this.lastReceived=this.now();
        const data=protocol.parseMessage(event.data);
        if(data)this.message(data);
      };
      socket.onerror=()=>this.failed(epoch);
      socket.onclose=event=>{
        if(epoch!==this.epoch)return;
        if([1008,4401,4403].includes(event.code)){this.enabled=false;this.retire();this.change('rejected');}
        else this.failed(epoch);
      };
    }
    watch(epoch) {
      if(this.watchdog!==null)return;
      this.watchdog=this.later(()=>{
        this.watchdog=null;
        if(epoch!==this.epoch)return;
        if(this.now()-this.lastReceived>=35000)this.failed(epoch);else this.watch(epoch);
      },Math.max(1,35000-(this.now()-this.lastReceived)));
    }
    beat(epoch) {
      this.heartbeat=this.later(()=>{
        this.heartbeat=null;if(epoch!==this.epoch)return;
        try{this.send({type:'ping'});}catch(_){}
        if(epoch===this.epoch)this.beat(epoch);
      },15000);
    }
    failed(epoch) {
      if(epoch!==this.epoch)return;
      const stable=this.opened&&this.now()-this.openedAt>=10000;
      this.retire();if(!this.enabled||!this.visible)return;
      if(stable)this.attempt=0;
      const delay=Math.round(Math.min(15000,800*Math.pow(2,Math.min(this.attempt++,5)))*(.85+this.random()*.3));
      this.change('reconnecting',delay);
      this.retry=this.later(()=>{this.retry=null;this.open();},delay);
    }
    send(data) {
      if(!this.socket||!this.opened||!this.visible)throw new Error('电脑与 ASR 服务的连接尚未就绪');
      if(this.socket.bufferedAmount>32768){this.failed(this.epoch);throw new Error('连接发送拥塞，正在重连');}
      try{this.socket.send(JSON.stringify(data));}catch(_){this.failed(this.epoch);throw new Error('发送失败，请等待连接恢复');}
    }
    destroy(){this.enabled=false;this.retire();}
  }
  return {Model,SocketLink,consoleInfo,pairing,ipv4,emotionStats,cueParts,protocol};
});
