'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isReadOnlyFrame, describeCommand } = require('../bridge/hid/guard');

test('GET-style commands (0x80-0xBF) are allowed in read-only mode', () => {
  for (const cmd of [0x80, 0x83, 0x89, 0x8f, 0xb0]) assert.equal(isReadOnlyFrame(Buffer.from([cmd])), true, cmd.toString(16));
});

test('SET-style commands (< 0x80) are rejected in read-only mode', () => {
  for (const cmd of [0x00, 0x02, 0x09, 0x0a, 0x31, 0x7f]) assert.equal(isReadOnlyFrame(Buffer.from([cmd, 1, 2, 3])), false, cmd.toString(16));
});

test('dongle transport and identity queries are allowed', () => {
  for (const cmd of [0xf1, 0xf6, 0xf7, 0xfb, 0xfc, 0xfd, 0xfe]) assert.equal(isReadOnlyFrame(Buffer.from([cmd])), true, cmd.toString(16));
});

test('unknown high commands and empty frames are rejected', () => {
  for (const cmd of [0xc0, 0xe0, 0xf0, 0xf2, 0xf8, 0xff]) assert.equal(isReadOnlyFrame(Buffer.from([cmd])), false, cmd.toString(16));
  assert.equal(isReadOnlyFrame(Buffer.alloc(0)), false);
});

test('describeCommand names known commands for the log', () => {
  assert.equal(describeCommand(0x89), 'GET_KEYMATRIX');
  assert.equal(describeCommand(0x09), 'SET_KEYMATRIX');
  assert.equal(describeCommand(0xf1), 'QUERY_ID');
  assert.equal(describeCommand(0xc3), 'CMD_0xc3');
});
