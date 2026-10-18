'use strict';
// Feature-report frame rules, recovered from the helper's
// DJDevice::send_feature (docs/protocol-re.md, Q1):
//   * the message is zero-padded to 64 bytes (byte 0 is the command byte);
//   * BIT7 / BIT8 add one checksum byte = bitwise NOT of the 8-bit wrapping sum
//     over a window:
//       USB devices: BIT7 → buf[7] = ~Σ buf[0..6];  BIT8 → buf[8] = ~Σ buf[0..7]
//       BLE devices: BIT7 → buf[8] = ~Σ buf[1..8];  BIT8 → buf[9] = ~Σ buf[1..9]
//   * NONE leaves the frame untouched.
// The Linux hidraw transport prepends the report-id byte (0) itself.
const CHECKSUM = { BIT7: 0, BIT8: 1, NONE: 2 };
const FRAME_LEN = 64;

function pad(msg) {
  const f = Buffer.alloc(FRAME_LEN);
  Buffer.from(msg).copy(f, 0, 0, Math.min(msg.length, FRAME_LEN));
  return f;
}

function notSum(buf, from, to) {
  let s = 0;
  for (let i = from; i <= to; i++) s = (s + buf[i]) & 0xff;
  return (~s) & 0xff;
}

function build(msg, checksumType = CHECKSUM.NONE, { ble = false } = {}) {
  const f = pad(msg);
  if (checksumType === CHECKSUM.NONE) return f;
  if (checksumType === CHECKSUM.BIT7) {
    if (ble) f[8] = notSum(f, 1, 8);
    else f[7] = notSum(f, 0, 6);
    return f;
  }
  if (checksumType === CHECKSUM.BIT8) {
    if (ble) f[9] = notSum(f, 1, 9);
    else f[8] = notSum(f, 0, 7);
    return f;
  }
  throw new Error(`unknown checksum type ${checksumType}`);
}

function parseRead(data) {
  return Buffer.from(data).subarray(0, FRAME_LEN);
}

module.exports = { build, parseRead, pad, notSum, FRAME_LEN, CHECKSUM };
