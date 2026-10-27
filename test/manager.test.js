'use strict';
// HID manager: device list stream, raw feature I/O with the read-only guard,
// vendor input forwarding, dongle status polling (poller injected).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHidManager } = require('../bridge/hid/manager');
const { FakeHidModule } = require('../bridge/hid/fake');
const { GrpcError } = require('../bridge/grpcweb');

const A75_CMD = { node: '/dev/hidraw2', vid: 0x3151, pid: 0x4011, name: 'ROYUAN 2.4G Wireless Keyboard', interface: 2, collections: [{ usagePage: 0xffff, usage: 2 }], role: { kind: 'support', dongleCommon: true, ble: false, usagePage: 0xffff, usage: 2 } };
const A75_VENDER = { node: '/dev/hidraw1', vid: 0x3151, pid: 0x4011, name: 'ROYUAN 2.4G Wireless Keyboard', interface: 1, collections: [{ usagePage: 0xffff, usage: 1, reportIds: [5] }], role: { kind: 'vender', usagePage: 0xffff, usage: 1, reportIds: [5] } };

class StubWatcher extends EventEmitter {
  constructor(devices) { super(); this.devicesList = devices; this.started = false; }
  start() { this.started = true; this.emit('change', { type: 'INIT', devices: this.devicesList, added: this.devicesList, removed: [] }); }
  stop() { this.started = false; }
}

function fakeStream() {
  const s = { written: [], ended: undefined, closeCbs: [], open: true };
  s.write = (o) => s.written.push(o);
  s.end = (e) => { s.ended = e || null; s.open = false; };
  s.onClose = (cb) => s.closeCbs.push(cb);
  s.close = () => { s.open = false; s.closeCbs.forEach((cb) => cb()); };
  return s;
}

async function setup({ readOnly = true, poller, devices = [A75_CMD, A75_VENDER], frameRules } = {}) {
  const hidModule = new FakeHidModule();
  const cmd = hidModule.addDevice('/dev/hidraw2');
  const vender = hidModule.addDevice('/dev/hidraw1');
  const watcher = new StubWatcher(devices);
  const polls = [];
  const mgr = await createHidManager({
    readOnly,
    hidModule,
    watcher,
    log: () => {},
    pollIntervalMs: 5,
    dongleStatus: poller || (async (dev) => { polls.push(dev.path); return { keyboardId: 0x80000790, mouseId: 0, keyboard: { battery: 88, isOnline: true }, mouse: null }; }),
    frameRules,
  });
  return { mgr, hidModule, cmd, vender, watcher, polls };
}

test('watchDevList sends INIT with the dongle keyboard as a DangleCommon entry', async () => {
  const { mgr } = await setup();
  const s = fakeStream();
  await mgr.watchDevList(s);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(s.written.length >= 1);
  const init = s.written[0];
  assert.equal(init.type, 0); // INIT
  assert.equal(init.devlist.length, 1);
  const dc = init.devlist[0].danglecommondev;
  assert.equal(dc.path, '/dev/hidraw2');
  assert.equal(dc.vid, 0x3151);
  assert.equal(dc.pid, 0x4011);
  assert.equal(dc.keyboardId, 0x80000790);
  assert.deepEqual(dc.keyboard, { status: { battery: 88, isOnline: true } });
  assert.deepEqual(dc.mouse, { empty: {} });
  s.close();
  await mgr.close();
});

test('a status change from the poller is pushed as a CHANGE event', async () => {
  let online = true;
  const { mgr } = await setup({ poller: async () => ({ keyboardId: 0x80000790, mouseId: 0, keyboard: { battery: 50, isOnline: online }, mouse: null }) });
  const s = fakeStream();
  await mgr.watchDevList(s);
  await new Promise((r) => setTimeout(r, 20));
  const before = s.written.length;
  online = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(s.written.length > before);
  const last = s.written.at(-1);
  assert.equal(last.type, 3); // CHANGE
  assert.equal(last.devlist[0].danglecommondev.keyboard.status.isOnline, false);
  s.close();
  await mgr.close();
});

test('sendRawFeature writes a 65-byte report through the frame rules; readRawFeature returns 64 bytes', async () => {
  const { mgr, cmd } = await setup({ frameRules: { build: (msg) => { const f = Buffer.alloc(64); Buffer.from(msg).copy(f); f[63] = 0x5a; return f; } } });
  await new Promise((r) => setTimeout(r, 15));
  const res = await mgr.sendRawFeature({ devicepath: '/dev/hidraw2', msg: Buffer.from([0x80]), checksumtype: 0, dangledevtype: 1 });
  assert.deepEqual(res, { err: '' });
  const sent = cmd.sent.at(-1);
  assert.equal(sent.length, 65);
  assert.equal(sent[0], 0);
  assert.equal(sent[1], 0x80);
  assert.equal(sent[64], 0x5a);
  cmd.setFeatureResponse(Buffer.from([0x80, 0x01, 0x02]));
  const rd = await mgr.readRawFeature({ devicepath: '/dev/hidraw2' });
  assert.equal(rd.err, '');
  assert.equal(rd.msg.length, 64);
  assert.equal(rd.msg[0], 0x80);
  assert.equal(rd.msg[2], 0x02);
  await mgr.close();
});

test('read-only mode rejects SET commands without touching the device', async () => {
  const { mgr, cmd } = await setup({ readOnly: true });
  await new Promise((r) => setTimeout(r, 15));
  const before = cmd.sent.length;
  await assert.rejects(mgr.sendRawFeature({ devicepath: '/dev/hidraw2', msg: Buffer.from([0x09, 1, 2]), checksumtype: 0 }), GrpcError);
  await assert.rejects(mgr.sendMsg({ devicepath: '/dev/hidraw2', msg: Buffer.from([0x04]), checksumtype: 0 }), GrpcError);
  assert.equal(cmd.sent.length, before);
  await mgr.close();
});

test('unknown device path is an error', async () => {
  const { mgr } = await setup();
  await assert.rejects(mgr.readRawFeature({ devicepath: '/dev/hidraw7' }), /not found/);
  await mgr.close();
});

test('watchVender forwards vendor input reports including the report id', async () => {
  const { mgr, vender } = await setup();
  const s = fakeStream();
  await mgr.watchVender(s);
  await new Promise((r) => setTimeout(r, 15));
  vender.emitInput(Buffer.from([5, 15, 1, 0]));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.written.length, 1);
  assert.equal(Buffer.from(s.written[0].msg).toString('hex'), '050f0100');
  s.close();
  await mgr.close();
});

test('setLoopLock(true) pauses dongle polling and setLoopLock(false) resumes it', async () => {
  const { mgr, polls } = await setup();
  await new Promise((r) => setTimeout(r, 25));
  await mgr.setLoopLock(true);
  const n = polls.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(polls.length, n, 'no polls while locked');
  await mgr.setLoopLock(false);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(polls.length > n, 'polling resumed');
  await mgr.close();
});

test('feature traffic and polling are serialized: no poll runs in the middle of a send/read pair', async () => {
  const events = [];
  const { mgr } = await setup({ poller: async () => { events.push('poll-start'); await new Promise((r) => setTimeout(r, 8)); events.push('poll-end'); return { keyboardId: 1, mouseId: 0, keyboard: { battery: 1, isOnline: true }, mouse: null }; } });
  await new Promise((r) => setTimeout(r, 12));
  await mgr.sendReadFeature({ devicepath: '/dev/hidraw2', msg: Buffer.from([0x80]), checksumtype: 0 }, async () => { events.push('io'); await new Promise((r) => setTimeout(r, 12)); events.push('io-done'); });
  const i = events.indexOf('io');
  assert.equal(events[i + 1], 'io-done');
  await mgr.close();
});

const WIRED = { node: '/dev/hidraw4', vid: 0x3151, pid: 0x4010, name: 'wired', interface: 2, collections: [{ usagePage: 0xffff, usage: 2, reportIds: [] }], role: { kind: 'support', dongleCommon: false, ble: false, usagePage: 0xffff, usage: 2, reportIds: [] } };

test('watchVender forwards only reports with the vendor collection report id', async () => {
  const { mgr, vender } = await setup();
  const s = fakeStream();
  await mgr.watchVender(s);
  await new Promise((r) => setTimeout(r, 15));
  vender.emitInput(Buffer.from([1, 0x80, 0, 0, 0, 0, 0, 0])); // NKRO report (id 1): "d" pressed
  vender.emitInput(Buffer.from([6, 1, 0, 0])); // mouse report (id 6)
  vender.emitInput(Buffer.from([5, 15, 1, 0])); // vendor event (id 5)
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(s.written.map((w) => Buffer.from(w.msg).toString('hex')), ['050f0100']);
  s.close();
  await mgr.close();
});

test('plain USB support devices are never polled with dongle frames', async () => {
  const hidModule = new FakeHidModule();
  const wired = hidModule.addDevice('/dev/hidraw4');
  const mgr = await createHidManager({ readOnly: true, hidModule, watcher: new StubWatcher([WIRED]), log: () => {}, pollIntervalMs: 5 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(wired.sent.length, 0, 'no F7/F6/FE/FC/8F sent to a wired keyboard');
  const s = fakeStream();
  await mgr.watchDevList(s);
  assert.deepEqual(s.written[0].devlist[0].dev.path, '/dev/hidraw4');
  assert.equal(s.written[0].devlist[0].dev.isonline, true);
  await mgr.close();
});

test('sendMsg/readMsg to a dongle keyboard run the F7/F6 and F7/FC sequences; raw calls do not', async () => {
  const hidModule = new FakeHidModule();
  const cmd = hidModule.addDevice('/dev/hidraw2');
  const { createFakeResponder } = require('../bridge/hid/dongle');
  cmd.responder = createFakeResponder();
  const mgr = await createHidManager({ readOnly: true, hidModule, watcher: new StubWatcher([A75_CMD]), log: () => {}, pollIntervalMs: 100000, dongleWait: async () => {} });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(cmd.sent.some((b) => b[1] === 0xf6 && b[2] === 0x0a), 'keyboard selected (F6 0A) during the initial id query');
  cmd.sent.length = 0;
  await mgr.sendMsg({ devicepath: '/dev/hidraw2', msg: Buffer.from([0x83]), checksumtype: 0, dangledevtype: 1 });
  const rd = await mgr.readMsg({ devicepath: '/dev/hidraw2' });
  const seq = cmd.sent.map((b) => b[1]);
  assert.equal(seq[0], 0xf7, 'status check before sending');
  assert.deepEqual(seq.filter((c) => c !== 0xf7), [0x83, 0xfc], 'the frame (selection cached), then the FC read prelude');
  await mgr.sendMsg({ devicepath: '/dev/hidraw2', msg: Buffer.from([0x83]), checksumtype: 0, dangledevtype: 2 });
  assert.ok(cmd.sent.some((b) => b[1] === 0xf6 && b[2] === 0x05), 'switching to the mouse re-selects');
  assert.equal(rd.msg[0], 0x83);
  assert.equal(rd.msg[1], 88);
  cmd.sent.length = 0;
  await mgr.sendRawFeature({ devicepath: '/dev/hidraw2', msg: Buffer.from([0x80]), checksumtype: 0 });
  await mgr.readRawFeature({ devicepath: '/dev/hidraw2' });
  assert.deepEqual(cmd.sent.map((b) => b[1]), [0x80], 'raw: no dongle housekeeping');
  await mgr.close();
});

test('user traffic through the dongle pauses status polling for a while', async () => {
  const hidModule = new FakeHidModule();
  const cmd = hidModule.addDevice('/dev/hidraw2');
  const { createFakeResponder } = require('../bridge/hid/dongle');
  cmd.responder = createFakeResponder();
  const mgr = await createHidManager({ readOnly: true, hidModule, watcher: new StubWatcher([A75_CMD]), log: () => {}, pollIntervalMs: 5, dongleWait: async () => {} });
  await new Promise((r) => setTimeout(r, 30));
  await mgr.sendMsg({ devicepath: '/dev/hidraw2', msg: Buffer.from([0x83]), checksumtype: 0, dangledevtype: 1 });
  cmd.sent.length = 0;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cmd.sent.filter((b) => b[1] === 0xf7).length, 0, 'no status polls right after user traffic');
  await mgr.close();
});

test('onBattery reports the keyboard battery and charging state whenever they change', async () => {
  let st = { keyboardId: 0x80000790, mouseId: 0, keyboard: { battery: 30, isOnline: true, charging: false }, mouse: null };
  const { mgr } = await setup({ poller: async () => st });
  const seen = [];
  mgr.onBattery((b) => seen.push(b));
  await new Promise((r) => setTimeout(r, 20));
  st = { ...st, keyboard: { battery: 31, isOnline: true, charging: true } };
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen.at(-1), { path: '/dev/hidraw2', battery: 31, charging: true, online: true });
  assert.ok(mgr.battery && mgr.battery.battery === 31, 'last value is available to late subscribers');
  await mgr.close();
});
