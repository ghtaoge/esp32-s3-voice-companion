'use strict';

const protocol = require('../../utils/protocol');
const emotionCues = require('../../utils/emotion-cues');
const { Connection } = require('../../utils/connection');
const STORAGE_KEY = 'voice-companion.connection.v1';
const FONT_OPTIONS = ['标准 · 1 倍', '大字 · 2 倍', '特大 · 3 倍', '超大 · 4 倍'];
const MODE_KEYS = ['page', 'scroll', 'typewriter', 'static'];
const MODE_OPTIONS = MODE_KEYS.map(key => protocol.MODES[key]);
const CONNECTION_NAMES = { disconnected:'未连接电脑', connecting:'正在连接电脑', connected:'电脑已连接', reconnecting:'正在重连电脑', paused:'已暂停连接', rejected:'配对未通过' };
const MAX_VISIBLE_CUES = 16;
function requestId() { return 'mini-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8); }
function textCounts(text) {
  let characters=0,bytes=0;
  for(const char of text){const cp=char.codePointAt(0);characters++;bytes+=cp<0x80?1:cp<0x800?2:cp<0x10000?3:4;}
  return {characters,bytes};
}

function cueView(text, analysis) {
  const tokens=[],cues=analysis.cues.slice(0,MAX_VISIBLE_CUES);
  // Plain sentences use the original caption directly; do not duplicate the
  // entire text in a second setData token string on every streaming revision.
  if(!cues.length)return {tokens,cues};
  let cursor=0;
  cues.forEach(cue=>{
    if(cue.start>cursor)tokens.push({text:text.slice(cursor,cue.start),start:cursor,highlight:false});
    tokens.push({text:cue.text,start:cue.start,highlight:true,negated:cue.negated});cursor=cue.end;
  });
  if(cursor<text.length)tokens.push({text:text.slice(cursor),start:cursor,highlight:false});
  return {tokens,cues};
}
function audioQuality(quality) {
  if(!quality || typeof quality!=='object')return {note:'',detail:''};
  const notes=[],parts=[];
  if(quality.reason==='short_context' || quality.reason==='below_feature_window')notes.push('片段较短');
  if(quality.reason==='no_audio')notes.push('没有可分析的声音');
  if(quality.reason==='no_signal')notes.push('未检测到有效音频信号');
  if(quality.reason==='truncated')notes.push('长句仅分析部分');
  if(Number.isFinite(quality.clipping_ratio) && quality.clipping_ratio>0.001)notes.push('声音可能过载');
  if(Number.isFinite(quality.duration_ms))parts.push('送入片段 '+(quality.duration_ms/1000).toFixed(2)+' 秒');
  if(Number.isFinite(quality.analyzed_ms))parts.push('分析 '+(quality.analyzed_ms/1000).toFixed(2)+' 秒');
  if(Number.isFinite(quality.peak))parts.push('峰值 '+(quality.peak*100).toFixed(1)+'%');
  if(Number.isFinite(quality.rms_dbfs))parts.push('RMS '+quality.rms_dbfs.toFixed(1)+' dBFS');
  if(Number.isFinite(quality.clipping_ratio))parts.push('削波比例 '+(quality.clipping_ratio*100).toFixed(2)+'%');
  return {note:notes.join(' · '),detail:parts.join(' · ')};
}
function candidateText(emotion) {
  if(!emotion || !Array.isArray(emotion.candidates))return '';
  return emotion.candidates.slice(0,3).filter(item=>item && Object.prototype.hasOwnProperty.call(protocol.EMOTIONS,item.label) && Number.isFinite(item.score))
    .map(item=>protocol.EMOTIONS[item.label]+' '+item.score.toFixed(2)).join(' / ');
}

Page({
  data: {
    tab:'live', showConnection:true, connectionState:'disconnected', connectionTitle:'未连接电脑', connected:false,
    address:'', deviceId:'esp32-s3', token:'', remember:true,
    state:'offline', stateTitle:'连接电脑，准备说话', stateMessage:'手机、电脑与开发板需要在同一局域网。',
    ready:false, groups:[], level:0, lastTiming:'', errorText:'', notice:'',
    fontOptions:FONT_OPTIONS, modeOptions:MODE_OPTIONS, modeIndex:0,
    draft:Object.assign({}, protocol.DEFAULT_SETTINGS), applied:Object.assign({}, protocol.DEFAULT_SETTINGS),
    appliedKnown:false, draftDirty:false, pending:false, settingsStatus:'连接后读取设备设置',
    draftPageSeconds:'3.0', appliedSummary:'尚未读取设备设置',
    showPrivacy:false, privacyName:'《用户隐私保护指引》',
    historyEditor:null, historyDisplaySupported:false, historyDisplayHint:'',
    historyDisplayKey:'',historyDisplaySource:'',historyDisplayPending:false,historyDisplayStatus:''
  },
  onLoad() {
    this.unloaded = false;
    this.foreground = false;
    this.state = protocol.initialState('');
    this.pendingRequest = null;
    this.pendingTimer = null;
    this.renderTimer = null;
    this.renderInFlight = false;
    this.renderEpoch = 0;
    this.renderDirty = false;
    this.level = 0;
    this.buildGroups = protocol.groupBuilder();
    this.cueCache=new Map();this.cueViews=new Map();this.cueGroups=new Map();this.expandedEmotionKey=null;
    this.expandedOriginalKey=null;this.correctionRequest=null;this.correctionTimer=null;
    this.historyDisplayRequest=null;this.historyDisplayTimer=null;
    this.privacyResolvers = [];
    this.connection = new Connection({ wx,
      onState:(name, delay) => this.connectionChanged(name, delay),
      onMessage:raw => this.receive(raw)
    });
    try {
      const saved = wx.getStorageSync(STORAGE_KEY);
      if (saved) {
        const info = protocol.normalizeConnection(saved);
        this.setData({address:info.url, deviceId:info.device_id, token:info.token});
        this.connectionInfo = info;
        this.state = protocol.initialState(info.device_id);
        this.connection.start(protocol.socketURL(info));
      }
    } catch (_) { /* Invalid/old local data is never used as a connection URL. */ }
    if (wx.onNeedPrivacyAuthorization) {
      this.privacyHandler = resolve => {
        if (this.unloaded || !this.foreground) { resolve({event:'disagree'}); return; }
        this.privacyResolvers.push(resolve);
        this.setData({showPrivacy:true});
        if (wx.getPrivacySetting) wx.getPrivacySetting({success:result => {
          if (!this.unloaded) this.setData({privacyName:result.privacyContractName || this.data.privacyName});
        }});
      };
      wx.onNeedPrivacyAuthorization(this.privacyHandler);
    }
  },
  onShow() { this.foreground = true; if (this.connection) this.connection.setForeground(true); },
  onHide() {
    this.foreground = false;
    this.renderEpoch++; this.renderInFlight=false;
    clearTimeout(this.renderTimer); this.renderTimer=null; this.renderDirty=false;
    if (this.connection) this.connection.setForeground(false);
    this.finishPending('页面已暂停；重新连接后读取实际设置');
    this.finishCorrection('页面已暂停，保存结果未知；重连后重新载入确认',true);
    this.finishHistoryDisplay('页面已暂停，推送结果未知');
    this.settlePrivacy('disagree');
  },
  onUnload() {
    this.unloaded = true;
    this.renderEpoch++;
    this.foreground = false;
    if (this.connection) this.connection.destroy();
    clearTimeout(this.pendingTimer); clearTimeout(this.renderTimer);
    clearTimeout(this.correctionTimer);clearTimeout(this.historyDisplayTimer);
    this.settlePrivacy('disagree');
    if (wx.offNeedPrivacyAuthorization && this.privacyHandler) wx.offNeedPrivacyAuthorization(this.privacyHandler);
    this.cueCache.clear();this.cueViews.clear();this.cueGroups.clear();
  },
  connectionChanged(name, delay) {
    if (this.unloaded) return;
    const connected = name === 'connected';
    const update = {connectionState:name, connectionTitle:CONNECTION_NAMES[name] || name, connected};
    if (name === 'reconnecting') {
      const failures=this.connection ? this.connection.handshakeFailures : 0;
      if (failures >= 3) {
        update.notice='连续 '+failures+' 次未能连接电脑。请检查电脑服务、地址、同网段网络、防火墙和配对口令；仍会自动重试。';
        update.showConnection=true;
      } else update.notice = '连接中断，' + Math.max(1,Math.round(delay / 1000)) + ' 秒后自动重试';
    }
    if (connected) {
      update.notice = '已连接电脑，正在同步设备和最近字幕';
      update.showConnection = false;
    }
    if (!connected) {
      this.level = 0;
      update.level = 0;
      update.stateTitle = '等待连接电脑';
      this.finishPending('连接中断；重连后读取设备实际设置');
      this.finishCorrection('连接中断，保存结果未知；重连后重新载入确认',true);
      this.finishHistoryDisplay('连接中断，推送结果未知');
      if(this.state.capabilities.length)this.state=Object.assign({},this.state,{capabilities:[]});
      this.scheduleRender();
    }
    if (name === 'rejected') { update.errorText='配对未通过，请检查设备标识和口令后重新连接'; update.showConnection=true; }
    this.setData(update);
  },
  receive(raw) {
    if (this.unloaded || !this.foreground) return;
    const message = protocol.parseMessage(raw);
    if (!message || (message.device_id && this.connectionInfo && message.device_id !== this.connectionInfo.device_id)) return;
    if (message.type === 'level') {
      if (message.recording_id !== this.state.recording_id) return;
      const value = Number(message.level);
      if (Number.isFinite(value)) {
        const level=Math.round(Math.max(0,Math.min(1,value))*100);
        if(this.level!==level){this.level=level;this.scheduleRender();}
      }
      return;
    }
    if (message.type === 'error') {
      // Do not expose backend exception details or credential-bearing messages.
      const publicMessages = {
        device_offline:'开发板未连接电脑，请检查开发板 Wi-Fi 与电脑地址',
        busy:'ASR 正在处理上一段录音，请稍后再按 BOOT',
        not_ready:'识别模型仍在准备，请等待电脑显示就绪',
        queue_full:'音频处理暂时跟不上，请缩短录音或调整电脑性能设置',
        audio_overload:'电脑处理落后于录音，本次录音已停止；请松开 BOOT，降低后台负载后重试',
        audio_timeout:'等待音频超时，请松开 BOOT 后重新录音',
        asr_failed:'本地识别失败，请查看电脑日志并在修复后重试',
        invalid_pcm:'音频格式不正确，请检查开发板固件与麦克风配置',
        recording_limit:'已达到单次录音时长上限，请松开 BOOT',
        unexpected_audio:'收到会话外音频，请松开 BOOT 后重新录音',
        recording_id:'录音标识无效，请更新开发板固件',
        recording_id_reused:'录音标识重复，请松开 BOOT 后重新录音',
        recording_mismatch:'本次录音已失效，请松开 BOOT 后重新录音',
        cancelled:'本次录音已取消',
        disconnected:'开发板连接已断开，本次录音已结束',
        shutdown:'电脑服务正在关闭',
        settings_timeout:'设备确认超时，请检查开发板连接',
        invalid_settings:'屏幕设置未通过校验，请重新选择',
        settings_invalid:'屏幕设置超出允许范围，请重新选择',
        settings_busy:'上一项设置还在等待开发板确认，请稍后再试',
        settings_rejected:'开发板未接受这次显示设置，请重新读取设备状态',
        settings_invalid_ack:'开发板返回的设置格式不正确，请更新固件',
        request_id:'设置请求标识无效，请重新应用设置',
        protocol:'开发板协议版本不兼容，请更新服务与固件',
        unsupported:'当前服务不支持这项操作，请检查客户端版本',
        invalid_json:'消息格式不正确，请检查客户端版本',
        unauthorized:'配对失败，请检查设备标识和配对口令',
        history_conflict:'这句话已在另一端修改，草稿已保留；请重新载入后再保存',
        history_invalid:'校对需为非空文字，最多 512 字且 UTF-8 不超过 1536 字节',
        history_not_found:'这条记录已不在电脑历史中，请刷新历史',
        history_not_final:'实时字幕仍在修订，请等最终文字后校对',
        history_save_failed:'校对尚未保存到电脑，草稿已保留，请重试',
        display_busy:'开发板正在录音或整理字幕，请完成后再推送',
        display_unsupported:'当前开发板固件不支持历史推送，请升级固件',
        display_too_long:'这段文字超过 OLED 的 1536 字节上限，请保存较短的校对版后推送',
        display_timeout:'等待 OLED 确认超时，推送结果未知',
        display_rejected:'开发板未应用这次历史推送，请重试',
        display_conflict:'校对版本已更新，请重新载入后再推送'
      };
      const displayConflict=message.code==='history_conflict' && this.historyDisplayRequest && message.request_id===this.historyDisplayRequest.id;
      const errorText=displayConflict?'校对版本已更新，已请求最新历史；确认后请重新推送':
        publicMessages[message.code] || '服务返回错误（' + protocol.boundedText(message.code,40) + '），请查看电脑状态';
      this.setData({errorText});
      if (message.request_id && message.request_id === this.pendingRequest) this.finishPending('设备未应用这次设置');
      if(this.correctionRequest && message.request_id===this.correctionRequest.id)this.finishCorrection(errorText,message.code==='history_conflict');
      if(this.historyDisplayRequest && message.request_id===this.historyDisplayRequest.id)this.finishHistoryDisplay(errorText);
      return;
    }
    const previousState=this.state;
    this.state = protocol.reduce(this.state, message);
    this.receiveHistoryResult(message);
    if (message.type === 'settings_pending' && message.request_id === this.pendingRequest) this.setData({settingsStatus:'电脑已转发，等待开发板确认…'});
    if (message.type === 'settings_applied' && message.request_id === this.pendingRequest) {
      try {
        protocol.validateSettings(message.settings);
        this.finishPending('开发板已应用');
        this.setData({draftDirty:false, notice:'屏幕设置已由开发板确认'});
      } catch (_) { this.finishPending('设备确认格式不正确，请重新读取设置'); }
    }
    const canSyncDraft = ['hello','snapshot','settings_applied'].indexOf(message.type)!==-1 && !this.data.draftDirty && !this.data.pending;
    if (this.state.settings_known && canSyncDraft) this.setDraft(this.state.settings, false);
    if ((message.type === 'snapshot' || message.type === 'status') && (this.data.notice||this.data.errorText)) this.setData({notice:'', errorText:''});
    // Subtitle bursts can arrive faster than the view can render. Merge every
    // message immediately, and render at most 12.5 Hz without dropping state.
    if(this.state!==previousState)this.scheduleRender();
  },
  scheduleRender() {
    this.renderDirty=true;
    if(this.unloaded||!this.foreground||this.renderTimer||this.renderInFlight)return;
    this.renderTimer=setTimeout(()=>{this.renderTimer=null;this.renderDirty=false;this.renderState();},80);
  },
  emotionGroups(groups) {
    const nextCache=new Map(),nextViews=new Map(),nextGroups=new Map();
    const decorated=groups.map(group=>{
      const segments=group.segments.map(segment=>{
        const displayed=protocol.displayText(segment);
        let lexical=this.cueCache.get(segment.key);
        if(!lexical || lexical.text!==displayed){
          const analysis=emotionCues.analyze(displayed);
          lexical=Object.assign({text:displayed,analysis},cueView(displayed,analysis));
        }
        nextCache.set(segment.key,lexical);
        const detailsOpen=this.expandedEmotionKey===segment.key,originalOpen=this.expandedOriginalKey===segment.key,old=this.cueViews.get(segment.key);
        if(old && old.source===segment && old.open===detailsOpen && old.originalOpen===originalOpen){nextViews.set(segment.key,old);return old.view;}
        const quality=audioQuality(segment.emotion && segment.emotion.audio_quality);
        const detailCues=detailsOpen?lexical.cues.map(cue=>({start:cue.start,text:cue.text,label:cue.labelText,
          negation:emotionCues.NEGATIONS[cue.negation],degree:emotionCues.DEGREES[cue.degree],reason:cue.reason})):[];
        const view=Object.assign({},segment,{cueTokens:lexical.tokens,cueCount:lexical.analysis.cues.length,
          cuesLimited:lexical.analysis.truncated || lexical.analysis.cues.length>MAX_VISIBLE_CUES,
          cueLimitNote:lexical.analysis.truncated || lexical.analysis.cues.length>MAX_VISIBLE_CUES?
            (displayed.length>lexical.analysis.text.length?'长字幕仅分析开头，完整字幕保留。':'仅高亮和展开前 16 处线索，完整字幕保留。'):'',
          detailsOpen,originalOpen,detailCues,qualityNote:quality.note,qualityDetail:detailsOpen?quality.detail:'',
          candidateText:detailsOpen?candidateText(segment.emotion):''});
        nextViews.set(segment.key,{source:segment,open:detailsOpen,originalOpen,view});return view;
      });
      const old=this.cueGroups.get(group.id);
      const view=old && old.source===group && old.view.segments.every((segment,n)=>segment===segments[n])?old.view:Object.assign({},group,{segments});
      nextGroups.set(group.id,{source:group,view});return view;
    });
    this.cueCache=nextCache;this.cueViews=nextViews;this.cueGroups=nextGroups;
    if(this.expandedEmotionKey && !nextCache.has(this.expandedEmotionKey))this.expandedEmotionKey=null;
    if(this.expandedOriginalKey && !nextCache.has(this.expandedOriginalKey))this.expandedOriginalKey=null;
    return decorated;
  },
  emotionPatch(previous,next) {
    const patch=protocol.groupPatch(previous,next);
    if(patch.groups)return patch;
    next.forEach((group,index)=>{
      if(patch['groups['+index+'].segments'])return;
      group.segments.forEach((segment,n)=>{
      const old=previous[index].segments[n];
      if(old && old.key===segment.key && (old.detailsOpen!==segment.detailsOpen || old.originalOpen!==segment.originalOpen || old.qualityNote!==segment.qualityNote || old.qualityDetail!==segment.qualityDetail || old.candidateText!==segment.candidateText))
        patch['groups['+index+'].segments['+n+']']=segment;
      });
    });
    return patch;
  },
  toggleEmotionDetails(event) {
    const key=event.currentTarget.dataset.key;
    if(!this.state.segments.some(segment=>segment.key===key))return;
    this.expandedEmotionKey=this.expandedEmotionKey===key?null:key;this.scheduleRender();
  },
  toggleOriginal(event) {
    const key=event.currentTarget.dataset.key;
    if(!this.state.segments.some(segment=>segment.key===key && segment.corrected_text!==null))return;
    this.expandedOriginalKey=this.expandedOriginalKey===key?null:key;this.scheduleRender();
  },
  historySegment(event) {return this.state.segments.find(segment=>segment.key===event.currentTarget.dataset.key);},
  openCorrection(event) {
    const segment=this.historySegment(event);
    if(!segment || !segment.final || this.correctionRequest)return;
    const draft=protocol.displayText(segment);
    this.setData({historyEditor:{key:segment.key,recordingId:segment.recording_id,segmentId:segment.segment_id,
      version:segment.edit_version,original:segment.text,draft,hasCorrection:segment.corrected_text!==null,
      counts:textCounts(draft),saving:false,conflict:false,status:'保存仅更新历史，推送到 OLED 需另行选择版本。'}});
  },
  inputCorrection(event) {
    const editor=this.data.historyEditor;
    if(!editor || editor.saving)return;
    const draft=event.detail.value;
    this.setData({'historyEditor.draft':draft,'historyEditor.counts':textCounts(draft)});
  },
  closeCorrection() {if(!this.correctionRequest)this.setData({historyEditor:null});},
  reloadCorrection() {
    const editor=this.data.historyEditor;if(!editor || this.correctionRequest)return;
    const segment=this.state.segments.find(item=>item.key===editor.key);
    if(!segment){this.setData({'historyEditor.status':'记录已移出当前历史，请关闭后刷新'});return;}
    const draft=protocol.displayText(segment);
    this.setData({historyEditor:Object.assign({},editor,{version:segment.edit_version,original:segment.text,draft,
      hasCorrection:segment.corrected_text!==null,counts:textCounts(draft),conflict:false,status:'已重新载入电脑保存的最新版本。'})});
  },
  saveCorrection(event) {
    const editor=this.data.historyEditor;
    if(!editor || this.correctionRequest || !this.data.connected)return;
    if(editor.conflict){this.setData({'historyEditor.status':'请先重新载入最新版本，再调整草稿并保存'});return;}
    let text;
    try{text=protocol.validateCorrection(event && event.currentTarget && event.currentTarget.dataset.restore?null:editor.draft);}
    catch(error){this.setData({'historyEditor.status':error.message});return;}
    const id=requestId(),request={id,key:editor.key,recordingId:editor.recordingId,segmentId:editor.segmentId,version:editor.version,text};
    this.correctionRequest=request;
    this.setData({'historyEditor.saving':true,'historyEditor.status':'正在保存到电脑历史…',errorText:''});
    this.correctionTimer=setTimeout(()=>{if(this.correctionRequest===request)this.finishCorrection('保存确认超时，结果未知；请重新载入确认',true);},12000);
    this.connection.send({type:'history_correct',request_id:id,recording_id:request.recordingId,segment_id:request.segmentId,
      expected_edit_version:request.version,text}).catch(()=>{if(this.correctionRequest===request)this.finishCorrection('发送失败，草稿已保留；重连后重新载入确认',true);});
  },
  finishCorrection(status,conflict) {
    if(!this.correctionRequest)return;
    clearTimeout(this.correctionTimer);this.correctionTimer=null;this.correctionRequest=null;
    if(!this.unloaded && this.data.historyEditor)this.setData({'historyEditor.saving':false,'historyEditor.status':status,
      'historyEditor.conflict':Boolean(conflict)});
  },
  displayHistory(event) {
    const segment=this.historySegment(event),source=event.currentTarget.dataset.source;
    if(!segment || !segment.final || this.historyDisplayRequest || !this.data.connected)return;
    if(!this.state.capabilities.includes('history_display')){this.setData({errorText:'当前开发板固件不支持历史推送，请升级固件'});return;}
    if(this.state.state==='offline' || this.state.state==='recording' || this.state.state==='processing'){
      this.setData({errorText:'请等待开发板在线且录音处理完成，再推送历史文字'});return;
    }
    if(source!=='original' && source!=='corrected' || source==='corrected' && segment.corrected_text===null)return;
    const text=source==='corrected'?segment.corrected_text:segment.text;
    if(textCounts(text).bytes>1536){this.setData({errorText:'这段文字超过 OLED 的 1536 字节上限，请保存较短校对版后推送'});return;}
    const id=requestId(),request={id,key:segment.key,recordingId:segment.recording_id,segmentId:segment.segment_id,source,version:segment.edit_version};
    this.historyDisplayRequest=request;
    this.setData({historyDisplayKey:segment.key,historyDisplaySource:source,historyDisplayPending:true,historyDisplayStatus:'正在请求推送…',errorText:''});
    this.historyDisplayTimer=setTimeout(()=>{if(this.historyDisplayRequest===request)this.finishHistoryDisplay('OLED 确认超时，推送结果未知');},12000);
    const message={type:'history_display',request_id:id,recording_id:segment.recording_id,segment_id:segment.segment_id,source};
    if(source==='corrected')message.expected_edit_version=segment.edit_version;
    this.connection.send(message).catch(()=>{if(this.historyDisplayRequest===request)this.finishHistoryDisplay('发送失败，请重连后重试');});
  },
  finishHistoryDisplay(status) {
    if(!this.historyDisplayRequest)return;
    clearTimeout(this.historyDisplayTimer);this.historyDisplayTimer=null;this.historyDisplayRequest=null;
    if(!this.unloaded)this.setData({historyDisplayPending:false,historyDisplayStatus:status});
  },
  receiveHistoryResult(message) {
    const correction=this.correctionRequest;
    if(message.type==='history_corrected' && correction && message.request_id===correction.id &&
        message.recording_id===correction.recordingId && message.segment_id===correction.segmentId){
      const saved=this.state.segments.find(item=>item.key===correction.key);
      if(saved && saved.edit_version===message.edit_version && saved.edit_version>correction.version && saved.corrected_text===correction.text){
        this.finishCorrection(correction.text===null?'已恢复原始文字，尚未推送 OLED':'校对已保存，尚未推送 OLED');
        if(this.data.historyEditor)this.setData({'historyEditor.version':saved.edit_version,'historyEditor.draft':protocol.displayText(saved),
          'historyEditor.counts':textCounts(protocol.displayText(saved)),'historyEditor.hasCorrection':saved.corrected_text!==null});
      }else this.finishCorrection('保存确认不完整；草稿已保留，请重新载入确认',true);
    }
    const editor=this.data.historyEditor;
    if(editor && !this.correctionRequest){
      const current=this.state.segments.find(item=>item.key===editor.key);
      if(current && current.edit_version!==editor.version && !editor.conflict)
        this.setData({'historyEditor.conflict':true,'historyEditor.status':'电脑保存的版本已更新，草稿已保留；请重新载入后再保存'});
    }
    const display=this.historyDisplayRequest;
    if(display && message.request_id===display.id){
      if(message.type==='display_pending')this.setData({historyDisplayStatus:'电脑已转发，等待 OLED 应用确认…'});
      if(message.type==='history_displayed' && message.recording_id===display.recordingId && message.segment_id===display.segmentId && message.source===display.source){
        this.finishHistoryDisplay(display.source==='corrected' && message.edit_version!==display.version?
          'OLED 返回的校对版本不同，请重新载入后确认':'OLED 已确认显示'+(display.source==='corrected'?'校对版':'原始版'));
      }
    }
  },
  renderState() {
    if (this.unloaded || !this.foreground) return;
    if(this.renderInFlight){this.renderDirty=true;return;}
    const state = this.state;
    const done = state.last_done;
    let timing = '';
    if (done && done.audio_ms !== null) timing = '上次录音 ' + (done.audio_ms/1000).toFixed(1) + ' 秒';
    if (done && done.final_latency_ms !== null) timing += (timing ? ' · ' : '') + '松键后 ' + Math.round(done.final_latency_ms) + ' ms 完成';
    let message = state.message || (state.state === 'recording' ? '继续按住 BOOT 说话，松开结束本次录音。' :
      state.state === 'processing' ? '已停止采音，正在完成最后的字幕与标点。' :
      state.state === 'idle' ? '按住开发板 BOOT 说话，松开后自动完成识别。' : '请确认开发板 Wi-Fi 和电脑服务已启动。');
    let title = this.data.connected ? (protocol.STATES[state.state] || protocol.STATES.offline) : '等待连接电脑';
    if (this.data.connected && !state.ready) {
      title='本地识别尚未就绪';
      message='请在电脑检查本地模型与服务状态；修复模型后重启服务，再重新连接。';
    }
    const s = state.settings;
    const patch=this.emotionPatch(this.data.groups,this.emotionGroups(this.buildGroups(state)));
    const fields={state:state.state, stateTitle:title, stateMessage:message, ready:state.ready,
      lastTiming:timing, applied:Object.assign({},s), appliedKnown:state.settings_known,
      appliedSummary:state.settings_known ? s.font_scale + ' 倍字号 · ' + protocol.MODES[s.display_mode] + ' · 亮度 ' + s.brightness : '尚未读取设备设置',
      level:state.state === 'recording' ? this.level : 0,
      historyDisplaySupported:state.capabilities.includes('history_display'),
      historyDisplayHint:this.data.connected && state.state!=='offline' && !state.capabilities.includes('history_display')?'开发板需要升级固件，才能推送历史文字到 OLED。':''};
    Object.keys(fields).forEach(key=>{
      if(key==='applied'){
        if(Object.keys(s).some(name=>this.data.applied[name]!==s[name]))patch.applied=fields.applied;
      }else if(this.data[key]!==fields[key])patch[key]=fields[key];
    });
    if(!Object.keys(patch).length)return;
    // At most one subtitle bridge update can be outstanding. A slow view gets
    // the newest merged state after its callback, not an unbounded update queue.
    this.renderInFlight=true;
    const epoch=this.renderEpoch;
    this.setData(patch,()=>{
      if(this.unloaded || epoch!==this.renderEpoch)return;
      this.renderInFlight=false;
      if(this.renderDirty)this.scheduleRender();
    });
  },
  editConnection() { this.setData({showConnection:!this.data.showConnection}); },
  inputConnection(event) {
    const field = event.currentTarget.dataset.field;
    if (['address','deviceId','token'].indexOf(field) !== -1) this.setData({[field]:event.detail.value});
  },
  rememberChanged(event) {
    const remember = event.detail.value;
    this.setData({remember});
    if (!remember) { try { wx.removeStorageSync(STORAGE_KEY); } catch (_) {} }
  },
  connect() {
    let info;
    try { info=protocol.normalizeConnection({url:this.data.address,device_id:this.data.deviceId,token:this.data.token}); }
    catch (error) { this.setData({errorText:error.message}); return; }
    if (!this.connectionInfo || this.connectionInfo.device_id !== info.device_id || this.connectionInfo.url !== info.url) {
      this.state=protocol.initialState(info.device_id);
      this.finishCorrection('连接目标已更换');this.finishHistoryDisplay('连接目标已更换');
      this.setData({groups:[], level:0, appliedKnown:false, draftDirty:false, lastTiming:'',historyEditor:null,historyDisplayKey:'',historyDisplayStatus:''});
    }
    this.connectionInfo=info;
    this.setData({address:info.url,deviceId:info.device_id,token:info.token,errorText:'',notice:''});
    if (this.data.remember) { try { wx.setStorageSync(STORAGE_KEY,info); } catch (_) {} }
    this.connection.start(protocol.socketURL(info));
    this.renderState();
  },
  disconnect() { this.connection.stop(); this.setData({notice:'已主动断开，点击连接后继续同步'}); },
  scanPairing() {
    const scan=()=>wx.scanCode({onlyFromCamera:false,scanType:['qrCode'],success:result=>{
      if (this.unloaded) return;
      try {
        const info=protocol.parsePairing(result.result);
        this.setData({address:info.url,deviceId:info.device_id,token:info.token,errorText:'',notice:'已读取配对信息，点击连接电脑'});
      } catch (error) { this.setData({errorText:error.message}); }
    },fail:result=>{
      if (this.unloaded) return;
      if (!/cancel/.test(result.errMsg || '')) this.setData({errorText:'无法扫码，可手动填写地址与配对口令；也请检查微信相机授权'});
    }});
    if (wx.requirePrivacyAuthorize) wx.requirePrivacyAuthorize({success:scan,fail:()=>this.setData({errorText:'扫码授权未完成，仍可手动填写连接信息'})});
    else scan();
  },
  selectTab(event) { this.setData({tab:event.currentTarget.dataset.tab}); },
  setDraft(value, dirty) {
    const draft=Object.assign({},value);
    const patch={};
    if(Object.keys(protocol.DEFAULT_SETTINGS).some(key=>this.data.draft[key]!==draft[key]))patch.draft=draft;
    if(this.data.draftDirty!==Boolean(dirty))patch.draftDirty=Boolean(dirty);
    const modeIndex=Math.max(0,MODE_KEYS.indexOf(draft.display_mode)),seconds=(draft.page_ms/1000).toFixed(1);
    if(this.data.modeIndex!==modeIndex)patch.modeIndex=modeIndex;
    if(this.data.draftPageSeconds!==seconds)patch.draftPageSeconds=seconds;
    if(Object.keys(patch).length)this.setData(patch);
  },
  fontChanged(event) { this.setDraft(Object.assign({},this.data.draft,{font_scale:Number(event.detail.value)+1}),true); },
  modeChanged(event) { this.setDraft(Object.assign({},this.data.draft,{display_mode:MODE_KEYS[Number(event.detail.value)]}),true); },
  sliderChanged(event) {
    const field=event.currentTarget.dataset.field;
    if (['page_ms','scroll_speed','brightness'].indexOf(field) !== -1) this.setDraft(Object.assign({},this.data.draft,{[field]:Number(event.detail.value)}),true);
  },
  animationChanged(event) { this.setDraft(Object.assign({},this.data.draft,{animation:event.detail.value}),true); },
  restoreApplied() { if (this.data.appliedKnown && !this.data.pending) { this.setDraft(this.data.applied,false); this.setData({settingsStatus:'已恢复设备当前设置'}); } },
  applySettings() {
    if (!this.data.connected || this.data.pending || this.data.state === 'offline') return;
    let settings;
    try { settings=protocol.validateSettings(this.data.draft); } catch (error) { this.setData({errorText:error.message}); return; }
    const requestId='mini-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
    this.pendingRequest=requestId;
    this.setData({pending:true,settingsStatus:'正在发送设置…',errorText:''});
    this.pendingTimer=setTimeout(()=>{
      if (this.pendingRequest===requestId) this.finishPending('等待设备确认超时；重连后读取实际设置');
    },12000);
    this.connection.send({type:'settings_set',request_id:requestId,settings}).catch(()=>{
      if (this.pendingRequest===requestId) this.finishPending('发送失败，请等待连接恢复后再试');
    });
  },
  finishPending(text) {
    clearTimeout(this.pendingTimer); this.pendingTimer=null;
    const hadPending=Boolean(this.pendingRequest);
    this.pendingRequest=null;
    if (!this.unloaded && hadPending) this.setData({pending:false,settingsStatus:text});
  },
  copyTranscript(event) {
    const text=protocol.recordingText(this.state,event.currentTarget.dataset.id);
    if (text) wx.setClipboardData({data:text,fail:()=>wx.showToast({title:'复制失败',icon:'none'})});
  },
  openPrivacy() { if (wx.openPrivacyContract) wx.openPrivacyContract({fail:()=>wx.showToast({title:'请先在小程序后台配置隐私指引',icon:'none'})}); },
  agreePrivacy() { this.settlePrivacy('agree'); },
  rejectPrivacy() { this.settlePrivacy('disagree'); },
  settlePrivacy(event) {
    const resolvers=this.privacyResolvers || [];
    this.privacyResolvers=[];
    resolvers.forEach(resolve=>{try{resolve(event==='agree'?{event,buttonId:'voice-privacy-agree'}:{event});}catch(_){}});
    if (!this.unloaded) this.setData({showPrivacy:false});
  },
  ignoreTap() {}
});
