'use strict';
// Frame rules recovered from the helper's DJDevice::send_feature (docs/protocol-re.md, Q1):
// zero-pad the message to 64 bytes; checksum = bitwise NOT of the 8-bit wrapping sum
// over a window: USB devices sum from the command byte (BIT7 → byte 7 = ~Σ[0..6],
// BIT8 → byte 8 = ~Σ[0..7]); BLE devices use the window shifted by one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, CHECKSUM } = require('../bridge/hid/frame');

test('NONE: message is zero-padded to 64 bytes and otherwise untouched', () => {
  const f = build(Buffer.from([0x80]), CHECKSUM.NONE);
  assert.equal(f.length, 64);
  assert.equal(f[0], 0x80);
  assert.ok(f.subarray(1).every((b) => b === 0));
  const full = build(Buffer.alloc(64, 0x11), CHECKSUM.NONE);
  assert.ok(full.every((b) => b === 0x11));
});

test('BIT7 (USB device): byte 7 = ~(sum of bytes 0..6), command byte included', () => {
  // worked example from the recovered helper: GET_BATTERY → 83 00 00 00 00 00 00 7C
  const bat = build(Buffer.from([0x83]), CHECKSUM.BIT7);
  assert.equal(bat[7], 0x7c);
  const f = build(Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 0xaa, 0xbb]), CHECKSUM.BIT7);
  assert.equal(f[7], (~(0x09 + 21)) & 0xff);
  assert.equal(f[8], 0xbb, 'byte 8 untouched');
  const wrap = build(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), CHECKSUM.BIT7);
  assert.equal(wrap[7], 0x06); // sum 0x6f9 → 0xf9 → ~ = 0x06
});

test('BIT8 (USB device): byte 8 = ~(sum of bytes 0..7)', () => {
  const f = build(Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 0xcc]), CHECKSUM.BIT8);
  assert.equal(f[8], (~(0x09 + 28)) & 0xff);
  assert.equal(f[7], 7, 'byte 7 untouched');
});

test('short messages are padded before the window is summed', () => {
  const f = build(Buffer.from([0x8f]), CHECKSUM.BIT7);
  assert.equal(f[7], 0x70);
  const g = build(Buffer.from([0xf1]), CHECKSUM.BIT8);
  assert.equal(g[8], (~0xf1) & 0xff);
});

test('BLE devices use the window shifted by one (byte 8 = ~Σ[1..8], byte 9 = ~Σ[1..9])', () => {
  const f = build(Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8, 9]), CHECKSUM.BIT7, { ble: true });
  assert.equal(f[8], (~36) & 0xff);
  const g = build(Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8, 9]), CHECKSUM.BIT8, { ble: true });
  assert.equal(g[9], (~45) & 0xff);
});

test('the input buffer is never mutated', () => {
  const msg = Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 0]);
  build(msg, CHECKSUM.BIT7);
  assert.equal(msg[7], 0);
});
