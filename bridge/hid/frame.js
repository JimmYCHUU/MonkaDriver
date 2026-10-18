'use strict';
// Feature-report frame rules, recovered from the helper's
// DJDevice::send_feature (docs/protocol-re.md, Q1):
//   * the message is zero-padded to 64 bytes (the helper pads to 66 and sends
//     the first 64; byte 0 is the command byte);
//   * BIT7 / BIT8 add one checksum byte = bitwise NOT of the 8-bit wrapping sum
//     over a window; the window depends on the device kind:
//       normal/vender device: BIT7 → buf[8] = ~sum(buf[1..7]); BIT8 → buf[9] = ~sum(buf[1..8])
//       boot device:          BIT7 → buf[7] = ~sum(buf[0..6]); BIT8 → buf[8] = ~sum(buf[0..7])
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

function build(msg, checksumType = CHECKSUM.NONE, { devType = 'normal' } = {}) {
  const f = pad(msg);
  if (checksumType === CHECKSUM.NONE) return f;
  const boot = devType === 'boot';
  if (checksumType === CHECKSUM.BIT7) {
    if (boot) f[7] = notSum(f, 0, 6);
    else f[8] = notSum(f, 1, 7);
    return f;
  }
  if (checksumType === CHECKSUM.BIT8) {
    if (boot) f[8] = notSum(f, 0, 7);
    else f[9] = notSum(f, 1, 8);
    return f;
  }
  throw new Error(`unknown checksum type ${checksumType}`);
}

function parseRead(data) {
  return Buffer.from(data).subarray(0, FRAME_LEN);
}

module.exports = { build, parseRead, pad, notSum, FRAME_LEN, CHECKSUM };
