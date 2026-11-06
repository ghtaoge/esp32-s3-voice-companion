'use strict';

// No global socket listeners: each instance owns a SocketTask and a generation.
// A stale callback after hide/reconnect can never schedule another connection.
class Connection {
  constructor(options) {
    this.wx = options.wx;
    this.onState = options.onState || function () {};
    this.onMessage = options.onMessage || function () {};
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.random = options.random || Math.random;
    this.foreground = false;
    this.enabled = false;
    this.task = null;
    this.opened = false;
    this.epoch = 0;
    this.attempt = 0;
    this.handshakeFailures = 0;
    this.retry = null;
    this.heartbeat = null;
    this.watchdog = null;
    this.url = '';
  }
  clearTimers() {
    ['retry', 'heartbeat', 'watchdog'].forEach(name => {
      if (this[name] !== null) this.clearTimeout(this[name]);
      this[name] = null;
    });
  }
  retire() {
    this.epoch++;
    this.clearTimers();
    const old = this.task;
    this.task = null;
    this.opened = false;
    if (old) { try { old.close({ code: 1000, reason: 'client pause' }); } catch (_) { /* Already closed. */ } }
  }
  start(url) {
    this.retire();
    this.url = url;
    this.enabled = true;
    this.attempt = 0;
    this.handshakeFailures = 0;
    if (this.foreground) this.open();
  }
  stop() {
    this.enabled = false;
    this.retire();
    this.onState('disconnected');
  }
  setForeground(value) {
    this.foreground = Boolean(value);
    if (!this.foreground) { this.retire(); this.onState('paused'); }
    else if (this.enabled && !this.task && this.retry === null) this.open();
  }
  open() {
    if (!this.enabled || !this.foreground || !this.url) return;
    const epoch = ++this.epoch;
    this.onState('connecting');
    let task;
    try { task = this.wx.connectSocket({ url: this.url, timeout: 10000, fail: () => this.failed(epoch) }); }
    catch (_) { this.failed(epoch); return; }
    // connectSocket's fail callback can run synchronously in tests/adapters.
    if (epoch !== this.epoch || !task || typeof task.onOpen !== 'function') return;
    this.task = task;
    let opened = false;
    this.watchdog = this.setTimeout(() => this.failed(epoch), 12000);
    task.onOpen(() => {
      if (epoch !== this.epoch) return;
      opened = true;
      this.opened = true;
      this.attempt = 0;
      this.handshakeFailures = 0;
      if (this.watchdog !== null) this.clearTimeout(this.watchdog);
      this.watchdog = null;
      this.onState('connected');
      this.beat(epoch);
    });
    task.onMessage(event => {
      if (epoch !== this.epoch || !opened) return;
      this.armWatchdog(epoch);
      this.onMessage(event.data);
    });
    task.onClose(event => {
      if (epoch !== this.epoch) return;
      if (event && [1008,4401,4403].indexOf(event.code) !== -1) {
        this.enabled = false;
        this.retire();
        this.onState('rejected');
      } else this.failed(epoch);
    });
    task.onError(() => this.failed(epoch));
  }
  armWatchdog(epoch) {
    if (this.watchdog !== null) this.clearTimeout(this.watchdog);
    this.watchdog = this.setTimeout(() => this.failed(epoch), 35000);
  }
  beat(epoch) {
    if (epoch !== this.epoch || !this.task) return;
    this.armWatchdog(epoch);
    this.heartbeat = this.setTimeout(() => {
      if (epoch !== this.epoch) return;
      this.heartbeat = null;
      this.send({ type: 'ping' }).catch(() => {});
      // Do not reset the incoming-message watchdog when sending a heartbeat.
      this.scheduleBeat(epoch);
    }, 15000);
  }
  scheduleBeat(epoch) {
    if (epoch !== this.epoch || !this.task) return;
    this.heartbeat = this.setTimeout(() => {
      if (epoch !== this.epoch) return;
      this.heartbeat = null;
      this.send({ type: 'ping' }).catch(() => {});
      this.scheduleBeat(epoch);
    }, 15000);
  }
  failed(epoch) {
    if (epoch !== this.epoch) return;
    const wasOpen = this.opened;
    this.retire();
    if (!this.enabled || !this.foreground) return;
    this.handshakeFailures = wasOpen ? 0 : this.handshakeFailures + 1;
    const base = Math.min(15000, 800 * Math.pow(2, Math.min(this.attempt++, 5)));
    const delay = Math.round(base * (0.85 + this.random() * 0.3));
    this.onState('reconnecting', delay);
    this.retry = this.setTimeout(() => { this.retry = null; this.open(); }, delay);
  }
  send(message) {
    return new Promise((resolve, reject) => {
      const task = this.task;
      const epoch = this.epoch;
      if (!task || !this.opened || !this.foreground || !this.enabled) { reject(new Error('请先连接电脑服务')); return; }
      try {
        task.send({ data: JSON.stringify(message), success: resolve, fail: () => {
          this.failed(epoch);
          reject(new Error('发送失败，正在重新连接电脑'));
        } });
      } catch (_) { this.failed(epoch); reject(new Error('连接已断开')); }
    });
  }
  destroy() { this.enabled = false; this.foreground = false; this.retire(); }
}

module.exports = { Connection };
