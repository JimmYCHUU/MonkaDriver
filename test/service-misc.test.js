'use strict';
// Non-HID methods of the DriverGrpc service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../bridge/service');
const { GrpcError } = require('../bridge/grpcweb');

function mkService(extra = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'monka-ud-'));
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); return extra.execResult || ''; };
  const svc = createService({ userData, exec, hid: null, readOnly: true, log: () => {}, ...extra });
  return { svc, userData, calls };
}

test('getVersion reports a helper version the renderer treats as up to date', async () => {
  const { svc } = mkService();
  const v = await svc.handlers.getVersion({});
  assert.equal(v.baseversion, '1.7.5');
  assert.equal(typeof v.timestamp, 'string');
});

test('db methods store and retrieve byte keys/values per dbpath', async () => {
  const { svc, userData } = mkService();
  const dbpath = path.join(userData, 'iot_db', 'CONFIG');
  assert.deepEqual(await svc.handlers.insertDb({ dbpath, key: Buffer.from('"a"'), value: Buffer.from('eyJ4IjoxfQ==') }), { err: '' });
  const item = await svc.handlers.getItemFromDb({ dbpath, key: Buffer.from('"a"') });
  assert.equal(item.errStr, '');
  assert.equal(item.value.toString(), 'eyJ4IjoxfQ==');
  const missing = await svc.handlers.getItemFromDb({ dbpath, key: Buffer.from('"zz"') });
  assert.notEqual(missing.errStr, '');
  await svc.handlers.insertDb({ dbpath, key: Buffer.from('"b"'), value: Buffer.from('2') });
  const keys = await svc.handlers.getAllKeysFromDb({ dbpath });
  assert.deepEqual(keys.data.map(String), ['"a"', '"b"']);
  const values = await svc.handlers.getAllValuesFromDb({ dbpath });
  assert.deepEqual(values.data.map(String), ['eyJ4IjoxfQ==', '2']);
  assert.deepEqual(await svc.handlers.deleteItemFromDb({ dbpath, key: Buffer.from('"a"') }), { err: '' });
  assert.deepEqual((await svc.handlers.getAllKeysFromDb({ dbpath })).data.map(String), ['"b"']);
});

test('getWeather and upgradeOTAGATT are not supported on Linux', async () => {
  const { svc } = mkService();
  await assert.rejects(svc.handlers.getWeather({ language: 'en', address: 'x' }), GrpcError);
  const written = [];
  let ended;
  await svc.handlers.upgradeOTAGATT({ devpath: 'x', fileBuf: Buffer.alloc(1) }, { write: (o) => written.push(o), end: (e) => { ended = e; }, onClose() {}, open: true });
  assert.ok(ended instanceof GrpcError);
});

test('microphone mute uses wpctl on the default source', async () => {
  const { svc, calls } = mkService({ execResult: 'Volume: 1.00 [MUTED]\n' });
  assert.deepEqual(await svc.handlers.muteMicrophone({ needMute: true }), { err: '' });
  assert.deepEqual(calls.at(-1), ['wpctl', 'set-mute', '@DEFAULT_AUDIO_SOURCE@', '1']);
  await svc.handlers.toggleMicrophoneMute({});
  assert.deepEqual(calls.at(-1), ['wpctl', 'set-mute', '@DEFAULT_AUDIO_SOURCE@', 'toggle']);
  const st = await svc.handlers.getMicrophoneMute({});
  assert.deepEqual(calls.at(-1), ['wpctl', 'get-volume', '@DEFAULT_AUDIO_SOURCE@']);
  assert.equal(st.isMute, true);
  assert.equal(st.err, '');
});

test('watchSystemInfo streams samples until the client closes', async () => {
  const { svc } = mkService({ sysInfoIntervalMs: 5 });
  const written = [];
  let closeCb;
  const stream = { write: (o) => written.push(o), end() {}, onClose(cb) { closeCb = cb; }, open: true };
  await svc.handlers.watchSystemInfo({}, stream);
  await new Promise((r) => setTimeout(r, 40));
  closeCb();
  const n = written.length;
  assert.ok(n >= 2, `got ${n} samples`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(written.length, n, 'no samples after close');
  assert.ok(written[0].memTotal > 0);
});

test('setLightType, changeWirelessLoopStatus and cleanDev acknowledge without a device', async () => {
  const { svc } = mkService();
  assert.deepEqual(await svc.handlers.setLightType({ devicepath: 'x', lighttype: 2 }), {});
  assert.deepEqual(await svc.handlers.changeWirelessLoopStatus({ lock: true }), {});
  assert.deepEqual(await svc.handlers.cleanDev({ devicepath: 'x' }), { err: '' });
});
