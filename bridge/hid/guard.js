'use strict';
// Read-only gate: decides whether a feature-report frame can be sent to the
// keyboard without changing its configuration. Used while MONKA_READ_ONLY=1.

// Command byte names used by the vendor renderer for the A75's keyboard class
// (yc3121): GET = SET | 0x80. Other classes number a few commands differently.
const NAMES = {
  0x00: 'SET_REV', 0x80: 'GET_REV', 0x8f: 'GET_INFOR', 0x83: 'GET_BATTERY', 0x02: 'SET_RESET',
  0x04: 'SET_REPORT', 0x84: 'GET_REPORT', 0x05: 'SET_PROFILE', 0x85: 'GET_PROFILE',
  0x06: 'SET_KBOPTION', 0x86: 'GET_KBOPTION', 0x07: 'SET_LEDPARAM', 0x87: 'GET_LEDPARAM',
  0x08: 'SET_SLEDPARAM', 0x88: 'GET_SLEDPARAM', 0x09: 'SET_KEYMATRIX', 0x89: 'GET_KEYMATRIX',
  0x0a: 'SET_KEYENABLE', 0x8a: 'GET_KEYENABLE', 0x0b: 'SET_MACRO', 0x8b: 'GET_MACRO',
  0x0c: 'SET_USERPIC', 0x8c: 'GET_USERPIC', 0x0d: 'SET_AUDIO', 0x0e: 'SET_WINDOS',
  0x10: 'SET_FN', 0x90: 'GET_FN', 0x11: 'SET_DEBOUNCE', 0x91: 'GET_DEBOUNCE',
  0x12: 'SET_SLEEPTIME', 0x92: 'GET_SLEEPTIME', 0x13: 'SET_KEYMATRIX_SIMPLE', 0x93: 'GET_KEYMATRIX_SIMPLE',
  0x14: 'SET_USERPIC_SIMPLE', 0x94: 'GET_USERPIC_SIMPLE', 0x15: 'SET_FN_SIMPLE', 0x95: 'GET_FN_SIMPLE',
  0x97: 'GET_0x97',
  0xf1: 'QUERY_ID', 0xf6: 'DONGLE_SET_DEVICE', 0xf7: 'DONGLE_CHECK_STATUS', 0xfb: 'DONGLE_FB_STATUS',
  0xfc: 'DONGLE_READ_PRELUDE', 0xfd: 'DONGLE_FD_IS24', 0xfe: 'DONGLE_NEXT_PACK_LENGTH',
};

const TRANSPORT_ALLOW = new Set([0xf1, 0xf6, 0xf7, 0xfb, 0xfc, 0xfd, 0xfe]);

function isReadOnlyFrame(msg) {
  if (!msg || msg.length === 0) return false;
  const cmd = msg[0];
  if (cmd >= 0x80 && cmd <= 0xbf) return true;
  return TRANSPORT_ALLOW.has(cmd);
}

function describeCommand(cmd) {
  return NAMES[cmd] || `CMD_0x${cmd.toString(16).padStart(2, '0')}`;
}

module.exports = { isReadOnlyFrame, describeCommand, NAMES };
