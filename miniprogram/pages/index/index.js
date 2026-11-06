'use strict';

const protocol = require('../../utils/protocol');
const { Connection } = require('../../utils/connection');
const STORAGE_KEY = 'voice-companion.connection.v1';
const FONT_OPTIONS = ['标准 · 1 倍', '大字 · 2 倍', '特大 · 3 倍', '超大 · 4 倍'];
const MODE_KEYS = ['page', 'scroll', 'typewriter', 'static'];
const MODE_OPTIONS = MODE_KEYS.map(key => protocol.MODES[key]);
const CONNECTION_NAMES = { disconnected:'未连接电脑', connecting:'正在连接电脑', connected:'电脑已连接', reconnecting:'正在重连电脑', paused:'已暂停连接', rejected:'配对未通过' };

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
    showPrivacy:false, privacyName:'《用户隐私保护指引》'
  },
  onLoad() {
    this.unloaded = false;
    this.foreground = false;
    this.state = protocol.initialState('');
    this.pendingRequest = null;
    this.pendingTimer = null;
    this.renderTimer = null;
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
    if (this.connection) this.connection.setForeground(false);
    this.finishPending('页面已暂停；重新连接后读取实际设置');
    this.settlePrivacy('disagree');
  },
  onUnload() {
    this.unloaded = true;
    this.foreground = false;
    if (this.connection) this.connection.destroy();
    clearTimeout(this.pendingTimer); clearTimeout(this.renderTimer);
    this.settlePrivacy('disagree');
    if (wx.offNeedPrivacyAuthorization && this.privacyHandler) wx.offNeedPrivacyAuthorization(this.privacyHandler);
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
      update.level = 0;
      update.stateTitle = '等待连接电脑';
      this.finishPending('连接中断；重连后读取设备实际设置');
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
      if (Number.isFinite(value)) this.setData({level:Math.round(Math.max(0,Math.min(1,value))*100)});
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
        unauthorized:'配对失败，请检查设备标识和配对口令'
      };
      this.setData({errorText:publicMessages[message.code] || '服务返回错误（' + protocol.boundedText(message.code,40) + '），请查看电脑状态'});
      if (message.request_id && message.request_id === this.pendingRequest) this.finishPending('设备未应用这次设置');
      return;
    }
    this.state = protocol.reduce(this.state, message);
    if (message.type === 'settings_pending' && message.request_id === this.pendingRequest) this.setData({settingsStatus:'电脑已转发，等待开发板确认…'});
    if (message.type === 'settings_applied' && message.request_id === this.pendingRequest) {
      try {
        protocol.validateSettings(message.settings);
        this.finishPending('开发板已应用');
        this.setData({draftDirty:false, notice:'屏幕设置已由开发板确认'});
      } catch (_) { this.finishPending('设备确认格式不正确，请重新读取设置'); }
    }
    const canSyncDraft = !this.data.draftDirty && !this.data.pending;
    if (this.state.settings_known && canSyncDraft) this.setDraft(this.state.settings, false);
    if (message.type === 'snapshot' || message.type === 'status') this.setData({notice:'', errorText:''});
    // Subtitle bursts can arrive faster than the view can render. Merge every
    // message immediately, and render at most 12.5 Hz without dropping state.
    if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = null; this.renderState(); }, 80);
  },
  renderState() {
    if (this.unloaded) return;
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
    this.setData(Object.assign(protocol.groupPatch(this.data.groups,protocol.groups(state)),{state:state.state, stateTitle:title, stateMessage:message, ready:state.ready,
      lastTiming:timing, applied:Object.assign({},s), appliedKnown:state.settings_known,
      appliedSummary:state.settings_known ? s.font_scale + ' 倍字号 · ' + protocol.MODES[s.display_mode] + ' · 亮度 ' + s.brightness : '尚未读取设备设置',
      level:state.state === 'recording' ? this.data.level : 0}));
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
      this.setData({groups:[], level:0, appliedKnown:false, draftDirty:false, lastTiming:''});
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
    this.setData({draft,draftDirty:Boolean(dirty),modeIndex:Math.max(0,MODE_KEYS.indexOf(draft.display_mode)),draftPageSeconds:(draft.page_ms/1000).toFixed(1)});
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
    const group=this.data.groups.find(item=>item.id===event.currentTarget.dataset.id);
    if (group && group.text) wx.setClipboardData({data:group.text,fail:()=>wx.showToast({title:'复制失败',icon:'none'})});
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
