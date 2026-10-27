'use strict';
// HID manager: owns the open devices, the device-list/vender streams, raw
// feature I/O (with the read-only guard) and dongle status polling.
const { GrpcError, STATUS } = require('../grpcweb');
const { HidDevice } = require('./hidasync');
const { DeviceWatcher } = require('./watcher');
const { isReadOnlyFrame, describeCommand } = require('./guard');
const frameMod = require('./frame');
const dongleMod = require('./dongle');

const CHANGE = { INIT: 0, ADD: 1, REMOVE: 2, CHANGE: 3 };

class Managed {
  constructor(info) {
    this.info = info; // { node, vid, pid, interface, role, ... }
    this.path = info.node;
    this.dev = null; // HidDevice
    this.status = null; // dongle status: { keyboardId, mouseId, keyboard, mouse }
    this.dstate = {}; // dongle protocol state: lastSel, keyboardId, mouseId, pausedUntil
    this.queue = Promise.resolve();
  }
  // serialize feature traffic and polling per device
  run(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
}

function statusToProto(st) {
  const kb = st && st.keyboard ? { status: { battery: st.keyboard.battery | 0, isOnline: Boolean(st.keyboard.isOnline) } } : { empty: {} };
  const ms = st && st.mouse ? { status: { battery: st.mouse.battery | 0, isOnline: Boolean(st.mouse.isOnline) } } : { empty: {} };
  return { kb, ms };
}

async function createHidManager({
  readOnly = true,
  fake = false,
  hidModule,
  watcher,
  log = () => {},
  pollIntervalMs = 2000,
  dongleStatus,
  frameRules,
  dongleWait, // test hook: replaces the protocol sleeps
  openRetryMs = 400, // hidraw nodes appear before udev grants the user access; retry opens
  openRetries = 6,
} = {}) {
  if (!hidModule) hidModule = fake ? makeFakeModule() : require('node-hid');
  if (!watcher) watcher = fake ? makeFakeWatcher() : new DeviceWatcher();
  const rules = frameRules || frameMod;
  const pollDongle = dongleStatus || dongleMod.pollStatus;

  const managed = new Map(); // path -> Managed
  const devListStreams = new Set();
  const venderStreams = new Set();
  const batteryListeners = new Set();
  let lastBattery = null;
  const lastRealBattery = new Map(); // dongle path -> last non-zero reading
  const retryTimers = new Map(); // node -> timer of a pending open retry
  const sleep = dongleWait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let loopLocked = false;
  let pollTimer = null;
  let closed = false;

  // ------------------------------------------------------------ streams --
  function snapshot(type) {
    const devlist = [];
    for (const m of managed.values()) {
      if (m.info.role.kind !== 'support') continue;
      const common = { path: m.path, vid: m.info.vid, pid: m.info.pid };
      if (m.info.role.dongleCommon) {
        const { kb, ms } = statusToProto(m.status);
        devlist.push({ danglecommondev: { ...common, keyboard: kb, mouse: ms, keyboardId: (m.status && m.status.keyboardId) >>> 0 || 0, mouseId: (m.status && m.status.mouseId) >>> 0 || 0 } });
      } else {
        const st = m.status || {};
        devlist.push({ dev: { devtype: 0, is24: Boolean(st.is24), path: m.path, id: st.id | 0, battery: st.battery | 0, isonline: st.isOnline !== false, vid: m.info.vid, pid: m.info.pid } });
      }
    }
    return { devlist, type };
  }

  function broadcast(type) {
    const msg = snapshot(type);
    for (const s of devListStreams) { try { s.write(msg); } catch (e) { log('devlist write failed', e.message); } }
  }

  // ------------------------------------------------------------ devices --
  async function attach(info, attempt = 0) {
    const m = new Managed(info);
    managed.set(info.node, m);
    try {
      m.dev = await HidDevice.open(info.node, hidModule);
    } catch (e) {
      managed.delete(info.node);
      if (closed || attempt >= openRetries) { log(`open ${info.node} failed: ${e.message}`); return false; }
      // a freshly plugged device's node exists before udev grants the user access to it
      const delay = openRetryMs * 2 ** attempt;
      log(`open ${info.node} failed (${e.message}); retrying in ${delay} ms`);
      const timer = setTimeout(() => {
        retryTimers.delete(info.node);
        if (closed) return;
        attach(info, attempt + 1).then(async (ok) => {
          if (!ok) return;
          await identifyWired(managed.get(info.node));
          await pollOnce();
          broadcast(CHANGE.ADD);
        }).catch((err) => log('late attach failed', err));
      }, delay);
      if (timer.unref) timer.unref();
      retryTimers.set(info.node, timer);
      return false;
    }
    if (info.role.kind === 'vender') {
      // the interface carries other report ids too (NKRO, consumer, mouse); the
      // renderer only understands the vendor collection's reports
      const ids = new Set(info.role.reportIds || []);
      m.dev.onInput((buf) => {
        if (ids.size && !ids.has(buf[0])) return;
        const msg = { msg: Buffer.from(buf) };
        for (const s of venderStreams) { try { s.write(msg); } catch { /* ignore */ } }
      });
    }
    log(`attached ${info.node} (${info.role.kind}${info.role.dongleCommon ? ', dongle' : ''}) ${info.vid.toString(16)}:${info.pid.toString(16)}`);
    return true;
  }

  // A keyboard on its USB cable is a plain support device: it is identified by
  // the model id it reports to GET_INFOR (0x8F), the same id the vendor table
  // lists for the wired product (e.g. A75: 0x0790 = 1936). Read-only.
  async function identifyWired(m) {
    if (!m || !m.dev || m.info.role.kind !== 'support' || m.info.role.dongleCommon) return;
    if (m.status && m.status.id) return;
    try {
      const r = await m.run(async () => {
        await m.dev.writeFeature(rules.build([0x8f], 0));
        await sleep(20);
        return m.dev.readFeature();
      });
      if (!r || r[0] !== 0x8f) return;
      const id = (r[1] | (r[2] << 8) | (r[3] << 16) | (r[4] << 24)) >>> 0;
      // and its battery level (GET_BATTERY, byte 1); on the cable it reads 100
      const b = await m.run(async () => {
        await m.dev.writeFeature(rules.build([0x83], 0));
        await sleep(20);
        return m.dev.readFeature();
      });
      const battery = b && b[0] === 0x83 ? b[1] : null;
      m.status = { id, isOnline: true, wired: true, battery };
      log(`wired keyboard ${m.path}: model id 0x${id.toString(16)}, battery ${battery}`);
      reportBattery();
    } catch (e) {
      log(`identify ${m.path} failed: ${e.message}`);
    }
  }

  async function detach(node) {
    const t = retryTimers.get(node);
    if (t) { clearTimeout(t); retryTimers.delete(node); }
    const m = managed.get(node);
    if (!m) return;
    managed.delete(node);
    if (m.dev) await m.dev.close();
    log(`detached ${node}`);
    reportBattery();
  }

  // The battery shown to the user: a keyboard on its cable wins (it is charging),
  // then a dongle whose keyboard is awake, then any dongle.
  function currentBattery() {
    let awake = null;
    let asleep = null;
    for (const m of managed.values()) {
      if (m.info.role.kind !== 'support' || !m.status) continue;
      if (!m.info.role.dongleCommon) {
        if (m.status.id) return { path: m.path, battery: typeof m.status.battery === 'number' ? m.status.battery : null, charging: true, online: true, wired: true };
        continue;
      }
      const kb = m.status.keyboard;
      if (!kb) continue;
      let battery = kb.battery | 0;
      // the dongle briefly reports 0% while the cable goes in; the vendor UI ignores 0 too
      if (battery === 0 && !kb.charging) battery = lastRealBattery.has(m.path) ? lastRealBattery.get(m.path) : null;
      else lastRealBattery.set(m.path, battery);
      const b = { path: m.path, battery, charging: Boolean(kb.charging), online: Boolean(kb.isOnline) };
      if (kb.isOnline && !awake) awake = b;
      else if (!asleep) asleep = b;
    }
    return awake || asleep;
  }

  function reportBattery() {
    const b = currentBattery();
    if (JSON.stringify(b) === JSON.stringify(lastBattery)) return;
    lastBattery = b;
    for (const cb of batteryListeners) { try { cb(b); } catch (e) { log('battery listener failed', e.message); } }
  }

  async function pollOnce() {
    if (loopLocked || closed) return;
    let changed = false;
    for (const m of [...managed.values()]) {
      // only dongles have a status protocol; a cabled keyboard is online and charging,
      // and is only asked for its model id until it answers
      if (m.info.role.kind === 'support' && !m.info.role.dongleCommon && m.dev && !(m.status && m.status.id)) {
        await identifyWired(m);
        if (m.status && m.status.id) changed = true;
        continue;
      }
      if (m.info.role.kind !== 'support' || !m.info.role.dongleCommon || !m.dev) continue;
      if (loopLocked) break;
      try {
        const st = await m.run(() => pollDongle(m.dev, m.info, { log, rules, state: m.dstate, wait: dongleWait }));
        if (st && JSON.stringify(st) !== JSON.stringify(m.status)) { m.status = st; changed = true; reportBattery(); }
      } catch (e) {
        log(`status poll ${m.path} failed: ${e.message}`);
      }
    }
    if (changed) broadcast(CHANGE.CHANGE);
  }

  function schedulePoll() {
    if (pollTimer || closed) return;
    pollTimer = setInterval(() => { pollOnce().catch((e) => log('poll error', e)); }, pollIntervalMs);
    if (pollTimer.unref) pollTimer.unref();
  }

  let ready;
  const pending = [];
  watcher.on('change', (ev) => {
    const job = (async () => {
      for (const d of ev.removed) await detach(d.node);
      for (const d of ev.added) await attach(d);
      for (const d of ev.added) await identifyWired(managed.get(d.node));
      if (ev.type === 'INIT') {
        await pollOnce();
        broadcast(CHANGE.INIT);
      } else {
        if (ev.added.length) await pollOnce();
        broadcast(ev.type === 'REMOVE' ? CHANGE.REMOVE : CHANGE.ADD);
      }
    })().catch((e) => log('device change handling failed', e));
    pending.push(job);
    if (!ready) ready = job;
  });
  watcher.start();
  await (ready || Promise.resolve());
  schedulePoll();

  // ------------------------------------------------------------ helpers --
  function need(devicepath) {
    const m = managed.get(devicepath);
    if (!m || !m.dev || m.info.role.kind !== 'support') throw new GrpcError(STATUS.NOT_FOUND, `device ${devicepath} not found`);
    return m;
  }

  function guard(msg) {
    if (readOnly && !isReadOnlyFrame(msg)) {
      const cmd = msg.length ? msg[0] : -1;
      log(`READ-ONLY: refused ${describeCommand(cmd)} (${Buffer.from(msg).toString('hex')})`);
      throw new GrpcError(STATUS.INTERNAL, `read-only mode: refused ${describeCommand(cmd)}`);
    }
  }

  async function write(req, raw) {
    const m = need(req.devicepath);
    const msg = Buffer.from(req.msg || []);
    guard(msg);
    const frame = rules.build(msg, req.checksumtype | 0, { ble: Boolean(m.info.role.ble) });
    log(`${raw ? 'sendRawFeature' : 'sendMsg'} ${m.path} ${describeCommand(msg[0])} cs=${req.checksumtype | 0} dt=${req.dangledevtype | 0} -> ${frame.toString('hex')}`);
    await m.run(async () => {
      if (!raw && m.info.role.dongleCommon) {
        const sel = (req.dangledevtype | 0) === 2 ? 1 : 0;
        await dongleMod.sendToDongle(m.dev, frame, sel, m.dstate, { wait: dongleWait });
      } else {
        await m.dev.writeFeature(frame);
      }
    });
    return { err: '' };
  }

  async function read(req, raw) {
    const m = need(req.devicepath);
    const data = await m.run(() => (!raw && m.info.role.dongleCommon ? dongleMod.readFromDongle(m.dev, m.dstate, { wait: dongleWait }) : m.dev.readFeature()));
    const msg = rules.parseRead ? rules.parseRead(data, { raw }) : data;
    log(`${raw ? 'readRawFeature' : 'readMsg'} ${m.path} <- ${Buffer.from(msg).toString('hex')}`);
    return { err: '', msg: Buffer.from(msg) };
  }

  const api = {
    get battery() { return lastBattery; },
    onBattery(cb) { batteryListeners.add(cb); if (lastBattery) cb(lastBattery); return () => batteryListeners.delete(cb); },
    get devices() { return [...managed.values()].map((m) => ({ path: m.path, role: m.info.role, status: m.status })); },
    async watchDevList(stream) {
      devListStreams.add(stream);
      stream.onClose(() => devListStreams.delete(stream));
      stream.write(snapshot(CHANGE.INIT));
    },
    async watchVender(stream) {
      venderStreams.add(stream);
      stream.onClose(() => venderStreams.delete(stream));
    },
    sendRawFeature: (req) => write(req, true),
    readRawFeature: (req) => read(req, true),
    sendMsg: (req) => write(req, false),
    readMsg: (req) => read(req, false),
    // run an exclusive send+read sequence (used by tests / protocol helpers)
    sendReadFeature(req, fn) { const m = need(req.devicepath); return m.run(() => fn(m.dev)); },
    async setLoopLock(lock) {
      loopLocked = Boolean(lock);
      log(`wireless loop ${loopLocked ? 'paused' : 'resumed'}`);
    },
    async cleanDev() {},
    async close() {
      closed = true;
      for (const t of retryTimers.values()) clearTimeout(t);
      retryTimers.clear();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      watcher.stop();
      await Promise.allSettled(pending);
      for (const node of [...managed.keys()]) await detach(node);
    },
  };
  return api;
}

// --------------------------------------------------------------- fakes ----
function makeFakeWatcher() {
  const { EventEmitter } = require('node:events');
  const w = new EventEmitter();
  const devices = [
    { node: '/dev/hidraw2', vid: 0x3151, pid: 0x4011, name: 'FAKE A75 dongle', interface: 2, collections: [{ usagePage: 0xffff, usage: 2 }], role: { kind: 'support', dongleCommon: true, ble: false, usagePage: 0xffff, usage: 2 } },
    { node: '/dev/hidraw1', vid: 0x3151, pid: 0x4011, name: 'FAKE A75 dongle', interface: 1, collections: [{ usagePage: 0xffff, usage: 1 }], role: { kind: 'vender', usagePage: 0xffff, usage: 1 } },
  ];
  w.start = () => w.emit('change', { type: 'INIT', devices, added: devices, removed: [] });
  w.stop = () => {};
  return w;
}

function makeFakeModule() {
  const { FakeHidModule } = require('./fake');
  const mod = new FakeHidModule();
  const cmd = mod.addDevice('/dev/hidraw2');
  mod.addDevice('/dev/hidraw1');
  cmd.responder = (frame) => dongleMod.fakeResponder ? dongleMod.fakeResponder(frame) : undefined;
  return mod;
}

module.exports = { createHidManager, CHANGE };
