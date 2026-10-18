'use strict';
// Feature-report frame rules (padding / checksum). The exact checksum
// algorithms are filled in from docs/protocol-re.md; until then only NONE is
// implemented and the others throw rather than guess.
const { CHECKSUM } = { CHECKSUM: { BIT7: 0, BIT8: 1, NONE: 2 } };

const FRAME_LEN = 64;

function pad(msg) {
  const f = Buffer.alloc(FRAME_LEN);
  Buffer.from(msg).copy(f, 0, 0, Math.min(msg.length, FRAME_LEN));
  return f;
}

function build(msg, checksumType = CHECKSUM.NONE) {
  const f = pad(msg);
  if (checksumType === CHECKSUM.NONE) return f;
  throw new Error(`checksum type ${checksumType} not implemented yet (see docs/protocol-re.md)`);
}

function parseRead(data) {
  return Buffer.from(data).subarray(0, FRAME_LEN);
}

module.exports = { build, parseRead, pad, FRAME_LEN, CHECKSUM };
