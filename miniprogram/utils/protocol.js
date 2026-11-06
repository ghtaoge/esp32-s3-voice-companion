(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceProtocol = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  font_scale: 1,
  display_mode: 'page',
  page_ms: 3000,
  scroll_speed: 20,
  brightness: 128,
  animation: true
});
const MAX_SEGMENTS = 160;
const MAX_TEXT = 4096;
const MAX_TEXT_UNITS = 64 * 1024;
const MAX_PACKET = 512 * 1024;
const EMOTIONS = Object.freeze({
  neutral: '平静', happy: '开心', sad: '低落', angry: '生气',
  fearful: '害怕', disgusted: '厌恶', surprised: '惊讶', unknown: '未识别'
});
const STATES = Object.freeze({ offline: '开发板离线', idle: '按住 BOOT 开始说话',
  recording: '正在听你说话', processing: '正在整理最后一句', error: '需要处理' });
const MODES = Object.freeze({ page: '自动翻页', scroll: '向上滚动', typewriter: '逐字出现', static: '静态显示' });

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function integer(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
function boundedText(value, max) {
  if (typeof value !== 'string') return '';
  const limit = max || MAX_TEXT;
  if (value.length <= limit) return value;
  // Stop at the limit rather than allocating an array for an entire huge packet.
  let end = 0, count = 0;
  for (const point of value) {
    if (count++ >= limit) break;
    end += point.length;
  }
  return value.slice(0, end);
}
function safeId(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function validateCorrection(value) {
  if(value===null)return null;
  if(typeof value!=='string')throw new Error('校对文字格式不正确');
  const normalized=value.replace(/\r\n?/g,'\n');
  if(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(normalized))throw new Error('校对文字不能包含TAB或控制字符，只允许正常换行');
  const text=normalized.trim();
  if(!text)throw new Error('校对文字不能为空；恢复原文请使用“恢复原始识别”');
  let points=0,bytes=0;
  for(const point of text){
    const cp=point.codePointAt(0);
    if(cp===0||(cp>=0xD800&&cp<=0xDFFF))throw new Error('校对文字包含无效字符');
    points++;bytes+=cp<=0x7F?1:cp<=0x7FF?2:cp<=0xFFFF?3:4;
    if(points>512||bytes>1536)throw new Error('校对文字最多512个字，UTF-8最多1536字节');
  }
  return text;
}
function displayText(segment) { return typeof segment.corrected_text==='string'?segment.corrected_text:segment.text; }
function segmentUnits(segment) {return segment.text.length+(typeof segment.corrected_text==='string'?segment.corrected_text.length:0);}

function validateSettings(value) {
  if (!object(value)) throw new Error('屏幕设置格式不正确');
  const keys = Object.keys(DEFAULT_SETTINGS);
  if (Object.keys(value).some(key => keys.indexOf(key) === -1)) throw new Error('包含不支持的屏幕设置');
  const s = Object.assign({}, DEFAULT_SETTINGS, value);
  if (!integer(s.font_scale, 1, 4)) throw new Error('字号应为 1 至 4 倍');
  if (!Object.prototype.hasOwnProperty.call(MODES, s.display_mode)) throw new Error('不支持这种展示方式');
  if (!integer(s.page_ms, 500, 10000)) throw new Error('翻页停留时间应为 0.5 至 10 秒');
  if (!integer(s.scroll_speed, 5, 60)) throw new Error('滚动速度应为 5 至 60 像素/秒');
  if (!integer(s.brightness, 1, 255)) throw new Error('亮度应为 1 至 255');
  if (typeof s.animation !== 'boolean') throw new Error('动画设置应为开或关');
  return s;
}

function normalizeConnection(value) {
  if (!object(value)) throw new Error('连接信息格式不正确');
  let address = typeof value.url === 'string' ? value.url.trim() : '';
  let deviceId = typeof value.device_id === 'string' ? value.device_id.trim() : '';
  let token = typeof value.token === 'string' ? value.token.trim() : '';
  if (!address || address.length > 1024) throw new Error('请填写电脑的 WebSocket 地址');
  const match = /^(wss?):\/\/(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(\/[^?#]*)?(?:\?([^#]*))?$/.exec(address);
  if (!match) throw new Error('地址格式示例：ws://192.168.1.100:8765');
  if (match[3] && (!integer(Number(match[3]), 1, 65535))) throw new Error('端口应为 1 至 65535');
  const path = (match[4] || '').replace(/\/$/, '');
  if (path) {
    const endpoint = /^\/ws\/client\/([A-Za-z0-9_-]{1,40})$/.exec(path);
    if (!endpoint) throw new Error('请使用电脑服务的根地址或小程序连接地址');
    if (deviceId && endpoint[1] !== deviceId) throw new Error('地址与设备标识不一致');
    deviceId = endpoint[1];
  }
  if (match[5]) {
    const query = /^token=([^&]*)$/.exec(match[5]);
    if (!path || !query) throw new Error('连接地址包含不支持的参数');
    let scannedToken;
    try { scannedToken = decodeURIComponent(query[1]); } catch (_) { throw new Error('配对口令编码不正确'); }
    if (token && token !== scannedToken) throw new Error('地址与配对口令不一致');
    token = scannedToken;
  }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(deviceId)) throw new Error('设备标识只能包含字母、数字、下划线或短横线，最多 40 位');
  if (!token || token.length > 256 || /[\s\u0000-\u001f\u007f]/.test(token)) throw new Error('请填写有效的配对口令');
  address = match[1] + '://' + match[2] + (match[3] ? ':' + match[3] : '');
  return { url: address, device_id: deviceId, token };
}

function parsePairing(text) {
  if (typeof text !== 'string' || text.length > 4096) throw new Error('二维码内容不是有效的配对信息');
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { url: text }; }
  return normalizeConnection(data);
}
function socketURL(connection) {
  const c = normalizeConnection(connection);
  return c.url + '/ws/client/' + encodeURIComponent(c.device_id) + '?token=' + encodeURIComponent(c.token);
}
function parseMessage(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_PACKET) return null;
  try {
    const data = JSON.parse(raw);
    return object(data) && typeof data.type === 'string' ? data : null;
  } catch (_) { return null; }
}
function emotionValue(value) {
  if (!object(value)) return null;
  const label = Object.prototype.hasOwnProperty.call(EMOTIONS, value.label) ? value.label : 'unknown';
  const status = ['ready', 'skipped', 'error'].indexOf(value.status) !== -1 ? value.status : 'ready';
  const result = { label, status, event: boundedText(value.event, 80) };
  if (Array.isArray(value.raw_tags)) result.raw_tags = value.raw_tags.slice(0,8).filter(tag=>typeof tag==='string').map(tag=>boundedText(tag,40));
  if (Array.isArray(value.candidates)) {
    const seen=new Set();
    result.candidates=value.candidates.slice(0,16).filter(candidate=>{
      if(!object(candidate)||candidate.label==='unknown'||!Object.prototype.hasOwnProperty.call(EMOTIONS,candidate.label)||!Number.isFinite(candidate.score)||seen.has(candidate.label))return false;
      seen.add(candidate.label);return true;
    }).slice(0,3).map(candidate=>({label:candidate.label,score:candidate.score}));
  }
  if (object(value.audio_quality)) {
    const quality = {}, source = value.audio_quality;
    const ranges = {duration_ms:[0,3600000],analyzed_ms:[0,3600000],peak:[0,8],rms_dbfs:[-180,24],clipping_ratio:[0,1]};
    Object.keys(ranges).forEach(key=>{const number=source[key];if(Number.isFinite(number)&&number>=ranges[key][0]&&number<=ranges[key][1])quality[key]=number;});
    if (source.reason === null || ['no_audio','no_signal','below_feature_window','short_context','truncated'].indexOf(source.reason)!==-1) quality.reason=source.reason;
    if(Object.keys(quality).length)result.audio_quality=quality;
  }
  return result;
}
function initialState(deviceId) {
  return { device_id: deviceId || '', state: 'offline', recording_id: null, segments: [],
    text_units:0, capabilities:[],
    pending_emotions: {}, settings: Object.assign({}, DEFAULT_SETTINGS), settings_known: false,
    ready: false, message: '', last_done: null };
}
function segmentKey(recordingId, segmentId) { return recordingId + ':' + segmentId; }
function validSegment(value) {
  return safeId(value.recording_id, 64) && integer(value.segment_id, 0, 1000000);
}
function trimHistory(next) {
  while (next.segments.length > MAX_SEGMENTS || next.text_units > MAX_TEXT_UNITS) {
    next.text_units -= segmentUnits(next.segments.shift());
  }
}
function correctionFields(message,previous) {
  const fallback=previous?{edit_version:previous.edit_version||0,corrected_text:previous.corrected_text==null?null:previous.corrected_text,corrected_at:previous.corrected_at||null}:{edit_version:0,corrected_text:null,corrected_at:null};
  if(!integer(message.edit_version,0,Number.MAX_SAFE_INTEGER)||message.edit_version<fallback.edit_version)return fallback;
  if(previous&&message.edit_version===fallback.edit_version)return fallback;
  if(message.corrected_text!==null&&typeof message.corrected_text!=='string')return fallback;
  try{return{edit_version:message.edit_version,corrected_text:validateCorrection(message.corrected_text),corrected_at:typeof message.corrected_at==='string'?boundedText(message.corrected_at,80):null};}
  catch(_){return fallback;}
}
function replaceSegment(next,index,item) {
  const previous=index>=0?next.segments[index]:null;
  next.text_units+=segmentUnits(item)-(previous?segmentUnits(previous):0);
  if(index>=0)next.segments[index]=item;else next.segments.push(item);
}
function transcriptInto(next, message, trim) {
  if (!validSegment(message) || !integer(message.revision, 0, Number.MAX_SAFE_INTEGER) ||
      typeof message.text !== 'string' || typeof message.final !== 'boolean') return;
  const key = segmentKey(message.recording_id, message.segment_id);
  const index = next.segments.findIndex(item => item.key === key);
  let previous = index >= 0 ? next.segments[index] : null;
  const edits=correctionFields(message.final?message:{},previous);
  if(previous&&edits.edit_version>(previous.edit_version||0)){replaceSegment(next,index,Object.assign({},previous,edits));previous=next.segments[index];}
  if (previous && message.revision === previous.revision) {
    // Emotion may finish while this page is hidden. A reconnect snapshot can
    // carry the same text revision with newly completed emotion metadata.
    const emotion=emotionValue(message.emotion);
    if (emotion) next.segments[index]=Object.assign({},previous,{emotion});
    if(trim!==false)trimHistory(next);
    return;
  }
  if (previous && (message.revision < previous.revision || (previous.final && !message.final))) {if(trim!==false)trimHistory(next);return;}
  const item = { key, recording_id: message.recording_id, segment_id: message.segment_id,
    revision: message.revision, text: boundedText(message.text), final: message.final,
    start_ms: Number.isFinite(message.start_ms) ? Math.max(0, message.start_ms) : 0,
    end_ms: Number.isFinite(message.end_ms) ? Math.max(0, message.end_ms) : 0,
    emotion: emotionValue(message.emotion) || (previous && previous.emotion) || next.pending_emotions[key] || null,
    ...edits };
  replaceSegment(next,index,item);
  delete next.pending_emotions[key];
  if(trim !== false)trimHistory(next);
}
function correctionInto(next,message) {
  if(!validSegment(message))return;
  const index=next.segments.findIndex(item=>item.key===segmentKey(message.recording_id,message.segment_id));
  if(index<0||!next.segments[index].final)return;
  const previous=next.segments[index],edits=correctionFields(message,previous);
  if(edits.edit_version<=(previous.edit_version||0))return;
  replaceSegment(next,index,Object.assign({},previous,edits));trimHistory(next);
}
function emotionInto(next, message) {
  if (!validSegment(message)) return;
  const key = segmentKey(message.recording_id, message.segment_id);
  const value = emotionValue(message);
  const index = next.segments.findIndex(item => item.key === key);
  if (index >= 0) next.segments[index] = Object.assign({}, next.segments[index], { emotion: value });
  else {
    next.pending_emotions[key] = value;
    const keys = Object.keys(next.pending_emotions);
    if (keys.length > MAX_SEGMENTS) delete next.pending_emotions[keys[0]];
  }
}

function reduce(state, message) {
  if (!object(message) || (message.device_id && message.device_id !== state.device_id)) return state;
  if(['hello','snapshot','status','transcript','emotion','history_corrected','recording_done','settings_applied'].indexOf(message.type)===-1)return state;
  const next = Object.assign({}, state);
  if(['snapshot','transcript','emotion','history_corrected'].indexOf(message.type)!==-1){next.segments=state.segments.slice();next.pending_emotions=Object.assign({},state.pending_emotions);}
  switch (message.type) {
    case 'hello':
      next.ready = message.ready === true;
      if (message.protocol !== 1) { next.ready = false; next.message = '服务协议不兼容，请更新服务和小程序'; }
      break;
    case 'snapshot':
      if (Array.isArray(message.history)) {
        const history=message.history.slice(-MAX_SEGMENTS);
        history.forEach(item => {
          if (!object(item)) return;
          if (item.type === 'emotion') emotionInto(next, item);
          else transcriptInto(next, item, false);
        });
        // A large repeated snapshot must not evict current entries while adding
        // its older rows. Merge first, order its rows, and trim exactly once.
        const byKey = new Map(next.segments.map(item => [item.key, item]));
        const ordered = [], seen = new Set();
        history.forEach(item => {
          if (!object(item) || !validSegment(item)) return;
          const key = segmentKey(item.recording_id, item.segment_id);
          if (byKey.has(key) && !seen.has(key)) {
            seen.add(key);
            ordered.push(byKey.get(key));
          }
        });
        next.segments = next.segments.filter(item => !seen.has(item.key)).concat(ordered);
        trimHistory(next);
      }
      if (Object.prototype.hasOwnProperty.call(STATES, message.state)) next.state = message.state;
      next.recording_id = safeId(message.recording_id, 64) ? message.recording_id : null;
      break;
    case 'status':
      if (Object.prototype.hasOwnProperty.call(STATES, message.state)) next.state = message.state;
      next.recording_id = safeId(message.recording_id, 64) ? message.recording_id : null;
      next.message = boundedText(message.message, 200);
      break;
    case 'transcript': transcriptInto(next, message); break;
    case 'emotion': emotionInto(next, message); break;
    case 'history_corrected': correctionInto(next,message);break;
    case 'recording_done':
      if (safeId(message.recording_id, 64)) {
        next.last_done = { recording_id: message.recording_id,
          audio_ms: Number.isFinite(message.audio_ms) ? Math.max(0, message.audio_ms) : null,
          final_latency_ms: Number.isFinite(message.final_latency_ms) ? Math.max(0, message.final_latency_ms) : null };
        // Only the current recording may change the live state. Late results can
        // still update their own history without stopping a newer recording.
        if (next.recording_id === message.recording_id) { next.state = 'idle'; next.recording_id = null; }
      }
      break;
    default: break;
  }
  if (['hello', 'snapshot', 'settings_applied'].indexOf(message.type) !== -1 && object(message.settings)) {
    try { next.settings = validateSettings(message.settings); next.settings_known = true; } catch (_) { /* Keep last confirmed settings. */ }
  }
  if(['hello','snapshot'].indexOf(message.type)!==-1)next.capabilities=Array.isArray(message.capabilities)?message.capabilities.slice(0,16).filter(value=>typeof value==='string'&&/^[a-z_]{1,32}$/.test(value)):[];
  if(message.type==='status'&&message.state==='offline')next.capabilities=[];
  return next;
}

function emotionText(value) {
  if (!value) return '';
  if (value.status === 'skipped') return '情绪分析已跳过';
  if (value.status === 'error') return '情绪分析暂不可用';
  return EMOTIONS[value.label] || EMOTIONS.unknown;
}
function groupBuilder() {
  let sources = new Map(), cachedGroups = new Map();
  return state => {
    const result = [], byRecording = new Map(), nextSources = new Map(), nextGroups = new Map();
    state.segments.forEach(segment => {
      const cached = sources.get(segment.key);
      const view = cached && cached.source === segment ? cached.view : Object.assign({}, segment, {
        emotionText: emotionText(segment.emotion), seconds: (segment.start_ms / 1000).toFixed(1)
      });
      nextSources.set(segment.key, {source: segment, view});
      let group = byRecording.get(segment.recording_id);
      if (!group) {
        group = {id: segment.recording_id, shortId: segment.recording_id.slice(-8), segments: [],
          hasText: false, final: true, active: state.recording_id === segment.recording_id};
        byRecording.set(group.id, group);
        result.push(group);
      }
      group.segments.push(view);
      group.hasText = group.hasText || Boolean(displayText(segment));
      group.final = group.final && segment.final;
    });
    result.forEach((group, index) => {
      group.segments.sort((a, b) => a.segment_id - b.segment_id);
      const old = cachedGroups.get(group.id);
      if (old && old.active === group.active && old.final === group.final && old.hasText === group.hasText &&
          old.segments.length === group.segments.length && old.segments.every((segment, n) => segment === group.segments[n])) {
        result[index] = old;
      }
      nextGroups.set(group.id, result[index]);
    });
    sources = nextSources;
    cachedGroups = nextGroups;
    return result.reverse();
  };
}
function groups(state) { return groupBuilder()(state); }
function recordingText(state, id, source) {
  return state.segments.filter(item => item.recording_id === id)
    .sort((a, b) => a.segment_id - b.segment_id).map(item => source==='original'?item.text:displayText(item)).join('');
}
function sameViewSegment(a, b) {
  if (a === b) return true;
  const sameEmotion = !a.emotion && !b.emotion || (a.emotion && b.emotion &&
    a.emotion.label === b.emotion.label && a.emotion.event === b.emotion.event && a.emotion.status === b.emotion.status &&
    sameQuality(a.emotion.audio_quality,b.emotion.audio_quality) && sameTags(a.emotion.raw_tags,b.emotion.raw_tags) && sameCandidates(a.emotion.candidates,b.emotion.candidates));
  return a.key === b.key && a.revision === b.revision && a.text === b.text && a.final === b.final && a.edit_version===b.edit_version && a.corrected_text===b.corrected_text && a.corrected_at===b.corrected_at &&
    a.start_ms === b.start_ms && a.end_ms === b.end_ms && a.emotionText === b.emotionText && sameEmotion;
}
function sameQuality(a,b) {
  if(a===b)return true;
  if(!a||!b)return false;
  return ['duration_ms','analyzed_ms','peak','rms_dbfs','clipping_ratio','reason'].every(key=>a[key]===b[key]);
}
function sameTags(a,b) {
  if(a===b)return true;
  return Boolean(a&&b&&a.length===b.length&&a.every((tag,index)=>tag===b[index]));
}
function sameCandidates(a,b) {
  if(a===b)return true;
  return Boolean(a&&b&&a.length===b.length&&a.every((candidate,index)=>candidate.label===b[index].label&&candidate.score===b[index].score));
}

function groupPatch(previous, next) {
  // New recordings may reorder groups; ordinary streaming chunks only replace
  // the changed sentence. Avoid resending all historical text through setData.
  if (previous.length !== next.length || previous.some((group,index)=>group.id !== next[index].id)) return {groups:next};
  const patch = {};
  next.forEach((group,index)=>{
    const old = previous[index];
    if(old===group)return;
    ['hasText','final','active'].forEach(key=>{if(old[key] !== group[key]) patch['groups['+index+'].'+key]=group[key];});
    if (old.segments.length !== group.segments.length || old.segments.some((segment,n)=>segment.key !== group.segments[n].key)) {
      patch['groups['+index+'].segments']=group.segments;
    } else group.segments.forEach((segment,n)=>{
      if (!sameViewSegment(old.segments[n],segment)) patch['groups['+index+'].segments['+n+']']=segment;
    });
  });
  return patch;
}

return { DEFAULT_SETTINGS, EMOTIONS, STATES, MODES, MAX_SEGMENTS, MAX_TEXT, MAX_TEXT_UNITS,
  validateSettings, normalizeConnection, parsePairing, socketURL, parseMessage,
  initialState, reduce, groups, groupBuilder, recordingText, groupPatch, boundedText, emotionText,
  validateCorrection,displayText,segmentKey };
});
