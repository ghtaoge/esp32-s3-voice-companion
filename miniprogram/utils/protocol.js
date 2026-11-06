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
function boundedText(value, max) { return typeof value === 'string' ? Array.from(value).slice(0, max || MAX_TEXT).join('') : ''; }
function safeId(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }

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
  return { label, status, event: boundedText(value.event, 80) };
}
function initialState(deviceId) {
  return { device_id: deviceId || '', state: 'offline', recording_id: null, segments: [],
    pending_emotions: {}, settings: Object.assign({}, DEFAULT_SETTINGS), settings_known: false,
    ready: false, message: '', last_done: null };
}
function segmentKey(recordingId, segmentId) { return recordingId + ':' + segmentId; }
function validSegment(value) {
  return safeId(value.recording_id, 64) && integer(value.segment_id, 0, 1000000);
}
function transcriptInto(next, message) {
  if (!validSegment(message) || !integer(message.revision, 0, Number.MAX_SAFE_INTEGER) ||
      typeof message.text !== 'string' || typeof message.final !== 'boolean') return;
  const key = segmentKey(message.recording_id, message.segment_id);
  const index = next.segments.findIndex(item => item.key === key);
  const previous = index >= 0 ? next.segments[index] : null;
  if (previous && message.revision === previous.revision) {
    // Emotion may finish while this page is hidden. A reconnect snapshot can
    // carry the same text revision with newly completed emotion metadata.
    const emotion=emotionValue(message.emotion);
    if (emotion) next.segments[index]=Object.assign({},previous,{emotion});
    return;
  }
  if (previous && (message.revision < previous.revision || (previous.final && !message.final))) return;
  const item = { key, recording_id: message.recording_id, segment_id: message.segment_id,
    revision: message.revision, text: boundedText(message.text), final: message.final,
    start_ms: Number.isFinite(message.start_ms) ? Math.max(0, message.start_ms) : 0,
    end_ms: Number.isFinite(message.end_ms) ? Math.max(0, message.end_ms) : 0,
    emotion: emotionValue(message.emotion) || (previous && previous.emotion) || next.pending_emotions[key] || null };
  if (index >= 0) next.segments[index] = item;
  else next.segments.push(item);
  delete next.pending_emotions[key];
  if (next.segments.length > MAX_SEGMENTS) next.segments.splice(0, next.segments.length - MAX_SEGMENTS);
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
  const next = Object.assign({}, state, { segments: state.segments.slice(), pending_emotions: Object.assign({}, state.pending_emotions) });
  switch (message.type) {
    case 'hello':
      next.ready = message.ready === true;
      if (message.protocol !== 1) { next.ready = false; next.message = '服务协议不兼容，请更新服务和小程序'; }
      break;
    case 'snapshot':
      if (Array.isArray(message.history)) {
        message.history.slice(-MAX_SEGMENTS).forEach(item => {
          if (!object(item)) return;
          if (item.type === 'emotion') emotionInto(next, item);
          else transcriptInto(next, item);
        });
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
  return next;
}

function emotionText(value) {
  if (!value) return '';
  if (value.status === 'skipped') return '情绪分析已跳过';
  if (value.status === 'error') return '情绪分析暂不可用';
  return EMOTIONS[value.label] || EMOTIONS.unknown;
}
function groups(state) {
  const result = [];
  const byRecording = Object.create(null);
  state.segments.forEach(segment => {
    let group = byRecording[segment.recording_id];
    if (!group) {
      group = { id: segment.recording_id, shortId: segment.recording_id.slice(-8), segments: [], text: '', final: true, active: state.recording_id === segment.recording_id };
      byRecording[segment.recording_id] = group;
      result.push(group);
    }
    group.segments.push(Object.assign({}, segment, { emotionText: emotionText(segment.emotion), seconds: (segment.start_ms / 1000).toFixed(1) }));
  });
  result.forEach(group => {
    group.segments.sort((a,b) => a.segment_id - b.segment_id);
    group.text = group.segments.map(item => item.text).join('');
    group.final = group.segments.every(item => item.final);
  });
  return result.reverse();
}

function groupPatch(previous, next) {
  // New recordings may reorder groups; ordinary streaming chunks only replace
  // the changed sentence. Avoid resending all historical text through setData.
  if (previous.length !== next.length || previous.some((group,index)=>group.id !== next[index].id)) return {groups:next};
  const patch = {};
  next.forEach((group,index)=>{
    const old = previous[index];
    ['text','final','active'].forEach(key=>{if(old[key] !== group[key]) patch['groups['+index+'].'+key]=group[key];});
    if (old.segments.length !== group.segments.length || old.segments.some((segment,n)=>segment.key !== group.segments[n].key)) {
      patch['groups['+index+'].segments']=group.segments;
    } else group.segments.forEach((segment,n)=>{
      if (JSON.stringify(old.segments[n]) !== JSON.stringify(segment)) patch['groups['+index+'].segments['+n+']']=segment;
    });
  });
  return patch;
}

module.exports = { DEFAULT_SETTINGS, EMOTIONS, STATES, MODES, MAX_SEGMENTS, MAX_TEXT,
  validateSettings, normalizeConnection, parsePairing, socketURL, parseMessage,
  initialState, reduce, groups, groupPatch, boundedText, emotionText };
