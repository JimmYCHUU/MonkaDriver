'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const proto = require('../bridge/proto');

const hex = (buf) => Buffer.from(buf).toString('hex');

test('encodes Status24 to the exact wire bytes', () => {
  const bytes = proto.encode('Status24', { battery: 80, isOnline: true });
  assert.equal(hex(bytes), '08501001');
});

test('encodes SendMsg with string, bytes and two enums', () => {
  const bytes = proto.encode('SendMsg', {
    devicepath: 'p',
    msg: Buffer.from([0xf1]),
    checksumtype: proto.enums.CheckSumType.BIT8,
    dangledevtype: proto.enums.DangleDevType.KEYBOARD,
  });
  assert.equal(hex(bytes), '0a0170' + '1201f1' + '1801' + '2001');
});

test('decodes SendMsg giving Buffer msg and numeric enums', () => {
  const msg = proto.decode('SendMsg', Buffer.from('0a01701201f118012001', 'hex'));
  assert.equal(msg.devicepath, 'p');
  assert.ok(Buffer.isBuffer(msg.msg));
  assert.equal(hex(msg.msg), 'f1');
  assert.equal(msg.checksumtype, 1);
  assert.equal(msg.dangledevtype, 1);
});

test('decoding fills proto3 defaults for absent fields', () => {
  const msg = proto.decode('SendMsg', Buffer.from('0a0170', 'hex'));
  assert.equal(msg.checksumtype, 0);
  assert.equal(msg.dangledevtype, 0);
  assert.equal(msg.msg.length, 0);
});

test('encodes a DeviceList with a dongle keyboard (nested oneofs, big uint32)', () => {
  const dc = {
    keyboard: { status: { battery: 80, isOnline: true } },
    path: '/d',
    keyboardId: 0x80000790,
    vid: 0x3151,
    pid: 0x4011,
  };
  const dcHex = '0a06' + '1204' + '08501001' + '1a022f64' + '28908f808008' + '38d162' + '40918001';
  assert.equal(hex(proto.encode('DangleCommon', dc)), dcHex);
  const list = proto.encode('DeviceList', { devlist: [{ danglecommondev: dc }], type: proto.enums.DeviceListChangeType.ADD });
  const djdevHex = '12' + (dcHex.length / 2).toString(16).padStart(2, '0') + dcHex;
  assert.equal(hex(list), '0a' + (djdevHex.length / 2).toString(16).padStart(2, '0') + djdevHex + '1001');
});

test('round-trips every message type with representative values', () => {
  const samples = {
    Empty: {},
    Device: { devtype: 1, is24: true, path: '/dev/hidraw2', id: -5, battery: 3, isonline: true, vid: 1, pid: 2 },
    ResRead: { err: '', msg: Buffer.alloc(64, 0xaa) },
    VenderMsg: { msg: Buffer.from([5, 15, 1, 0]) },
    SetLight: { devicepath: 'x', lighttype: 2, screenId: 7, dangledevtype: 2 },
    WirelessLoopStatus: { lock: true },
    OTAUpgrade: { devpath: 'x', fileBuf: Buffer.from([1, 2, 3]) },
    Progress: { progress: 0.5, err: 'e' },
    MicrophoneMuteStatus: { isMute: true, err: '' },
    InsertDb: { dbpath: '/db', key: Buffer.from('"k"'), value: Buffer.from('v') },
    AllList: { data: [Buffer.from('a'), Buffer.from('b')], errStr: '' },
    Version: { baseversion: '1.7.5', timestamp: '0' },
    WeatherRes: { res: '{}' },
    SystemInfo: { diskSpaceTotal: 1e12, diskSpceAvailable: 5e11, netWorkTotalUp: 1, netWorkTotalDown: 2, cpuTemperater: 42.5, memTotal: 6e9, memUsed: 3e9, cpuUsage: 12.5 },
  };
  for (const [type, value] of Object.entries(samples)) {
    const back = proto.decode(type, proto.encode(type, value));
    for (const [k, v] of Object.entries(value)) {
      if (Buffer.isBuffer(v)) assert.equal(hex(back[k]), hex(v), `${type}.${k}`);
      else if (Array.isArray(v)) assert.deepEqual(back[k].map(hex), v.map(hex), `${type}.${k}`);
      else assert.equal(back[k], v, `${type}.${k}`);
    }
  }
});

test('exposes the service method table with request/response types and streaming flag', () => {
  assert.deepEqual(proto.methods.sendRawFeature, { request: 'SendMsg', response: 'ResSend', stream: false });
  assert.deepEqual(proto.methods.watchDevList, { request: 'Empty', response: 'DeviceList', stream: true });
  assert.equal(Object.keys(proto.methods).length, 21);
});
