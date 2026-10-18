#!/usr/bin/env node
'use strict';
// Controlled, reversible WRITE test of the lighting parameters (authorized by the
// user on 2026-10-18): read 0x87, write the same parameters with the brightness
// changed by one step (exactly as the vendor UI's setLightSetting does, checksum
// NONE), read back, hold a few seconds so the change is visible, then write the
// ORIGINAL bytes back and read again. Prints PASS only if the final read equals
// the original. Usage: node tools/write-test-light.js [/dev/hidrawN] [holdMs]
const { HidDevice } = require('../bridge/hid/hidasync');
const { build, CHECKSUM } = require('../bridge/hid/frame');
const dongle = require('../bridge/hid/dongle');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (b) => Buffer.from(b).subarray(0, 8).toString('hex');

async function getCmd(dev, state, cmd) {
  // right after a SET the first reply can come back with byte 0 cleared; retry a few times
  for (let attempt = 0; attempt < 4; attempt++) {
    await dongle.sendToDongle(dev, build([cmd], CHECKSUM.BIT7), 0, state, { wait });
    await wait(80); // let the dongle forward the request and flag "busy" before we wait for "ready"
    const r = await dongle.readFromDongle(dev, state, { wait });
    if (r[0] === cmd) return r;
    await wait(150);
  }
  throw new Error(`GET 0x${cmd.toString(16)} not answered`);
}

// Fresh read of the lighting parameters: a different GET first (0x80 GET_REV) so a
// stale 0x87 reply left in the dongle's buffer cannot be mistaken for a new one.
async function getLed(dev, state) {
  await getCmd(dev, state, 0x80);
  const r = await getCmd(dev, state, 0x87);
  return Buffer.from(r.subarray(1, 8)); // type, 5-speed, brightness, option, r, g, b
}

async function setLed(dev, state, params, cs = CHECKSUM.BIT8) {
  const msg = Buffer.concat([Buffer.from([0x07]), params]);
  // exactly what the Windows helper does for sendMsg: F7 wait → F6 select → frame
  await dongle.sendToDongle(dev, build(msg, cs), 0, state, { wait });
  await wait(600);
}

async function main() {
  const path = process.argv[2] || '/dev/hidraw2';
  const holdMs = Number(process.argv[3] || 4000);
  const dev = await HidDevice.open(path);
  const st = await dongle.f7Status(dev, { wait });
  if (!st || !st.keyboard || !st.keyboard.online) { console.log('keyboard asleep; press a key and retry'); process.exit(2); }
  const state = {};
  const original = await getLed(dev, state);
  console.log('original  ->', original.toString('hex'), `(type ${original[0]}, speed ${5 - original[1]}, brightness ${original[2]}, option ${original[3]}, rgb ${original.subarray(4).toString('hex')})`);
  const changed = Buffer.from(original);
  changed[2] = original[2] > 1 ? original[2] - 1 : original[2] + 1; // one brightness step
  console.log('writing   ->', changed.toString('hex'));
  await setLed(dev, state, changed);
  const mid = await getLed(dev, state);
  console.log('read back ->', mid.toString('hex'), mid.equals(changed) ? '(write accepted)' : '(NOT what was written)');
  await wait(holdMs);
  console.log('restoring ->', original.toString('hex'));
  await setLed(dev, state, original);
  const after = await getLed(dev, state);
  console.log('read back ->', after.toString('hex'));
  console.log(after.equals(original) ? 'PASS: lighting parameters restored byte-for-byte' : 'FAIL: restore mismatch');
  await dev.close();
  process.exit(after.equals(original) ? 0 : 1);
}
main().catch((e) => { console.error('write test failed:', e.message); process.exit(1); });
