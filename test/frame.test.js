'use strict';
// Frame rules recovered from the helper's DJDevice::send_feature (docs/protocol-re.md):
// pad the message with zeros to 64 bytes; checksum = bitwise NOT of the 8-bit
// wrapping sum over a window that depends on CheckSumType and device kind.
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

test('BIT7 (normal device): byte 8 = ~(sum of bytes 1..7), command byte not covered', () => {
  const f = build(Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 0xaa, 0xbb]), CHECKSUM.BIT7);
  assert.equal(f[8], (~28) & 0xff); // 0xe3
  assert.equal(f[9], 0xbb, 'byte 9 untouched');
  assert.equal(f[0], 0x09);
  const wrap = build(Buffer.from([0x80, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), CHECKSUM.BIT7);
  assert.equal(wrap[8], 0x06); // sum 0x6f9 → 0xf9 → ~ = 0x06
});

test('BIT8 (normal device): byte 9 = ~(sum of bytes 1..8)', () => {
  const f = build(Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8]), CHECKSUM.BIT8);
  assert.equal(f[9], (~36) & 0xff); // 0xdb
  assert.equal(f[8], 8, 'byte 8 untouched');
});

test('short messages are padded before the checksum window is summed', () => {
  const f = build(Buffer.from([0xf1]), CHECKSUM.BIT7);
  assert.equal(f[0], 0xf1);
  assert.equal(f[8], 0xff); // ~0
  const g = build(Buffer.from([0xf1]), CHECKSUM.BIT8);
  assert.equal(g[9], 0xff);
});

test('boot devices sum from byte 0 and store one byte earlier', () => {
  const f = build(Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8]), CHECKSUM.BIT7, { devType: 'boot' });
  assert.equal(f[7], (~(0x09 + 1 + 2 + 3 + 4 + 5 + 6)) & 0xff);
  const g = build(Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8]), CHECKSUM.BIT8, { devType: 'boot' });
  assert.equal(g[8], (~(0x09 + 1 + 2 + 3 + 4 + 5 + 6 + 7)) & 0xff);
});

test('the input buffer is never mutated', () => {
  const msg = Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 0]);
  build(msg, CHECKSUM.BIT7);
  assert.equal(msg[8], 0);
});
