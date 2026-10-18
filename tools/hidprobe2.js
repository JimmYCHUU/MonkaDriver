#!/usr/bin/env node
'use strict';
// Read-only dongle flow probe: F7 → F6 0A → GET command (BIT7) → FC → read.
// Only GET commands are used. Usage: node tools/hidprobe2.js [/dev/hidrawN] [cmdhex=83]
const { HidDevice } = require('../bridge/hid/hidasync');
const { pad, build, CHECKSUM } = require('../bridge/hid/frame');
const { parseF7 } = require('../bridge/hid/dongle');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (b) => Buffer.from(b).subarray(0, 16).toString('hex');

async function main() {
  const path = process.argv[2] || '/dev/hidraw2';
  const cmd = parseInt(process.argv[3] || '83', 16);
  if (cmd < 0x80) throw new Error('GET commands only');
  const dev = await HidDevice.open(path);
  const f7 = async (label) => { await dev.writeFeature(pad([0xf7])); await wait(2); const r = await dev.readFeature(); console.log(label, 'F7 ->', hx(r), JSON.stringify(parseF7(r))); return r; };
  await f7('before');
  await dev.writeFeature(pad([0xfe, 0x40])); await wait(10);
  await dev.writeFeature(pad([0xf6, 0x0a])); await wait(10);
  const frame = build([cmd], CHECKSUM.BIT7);
  console.log('send', hx(frame));
  await dev.writeFeature(frame);
  await wait(10);
  await f7('after-send');
  await dev.writeFeature(pad([0xfc])); await wait(10); await wait(10);
  const r = await dev.readFeature();
  console.log('reply ->', hx(r), r[0] === cmd ? '(command echoed: keyboard answered)' : '(no echo)');
  await wait(200);
  const r2 = await dev.readFeature();
  console.log('reply again ->', hx(r2));
  await dev.close();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
