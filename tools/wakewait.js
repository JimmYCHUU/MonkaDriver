#!/usr/bin/env node
'use strict';
// Read-only verification helper: polls the dongle (F7) until the keyboard is
// awake (online), then runs one GET_BATTERY round trip through the dongle and
// reports whether the reply echoes the command (which validates the checksum
// and the F7/F6/FC flow). Usage: node tools/wakewait.js [/dev/hidrawN] [maxMinutes]
const { HidDevice } = require('../bridge/hid/hidasync');
const { pad, build, CHECKSUM } = require('../bridge/hid/frame');
const dongle = require('../bridge/hid/dongle');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (b) => Buffer.from(b).subarray(0, 16).toString('hex');

async function main() {
  const path = process.argv[2] || '/dev/hidraw2';
  const maxMs = Number(process.argv[3] || 25) * 60000;
  const dev = await HidDevice.open(path);
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < maxMs) {
    st = await dongle.f7Status(dev, { wait });
    if (st && st.keyboard && st.keyboard.online) break;
    await wait(2000);
  }
  if (!st || !st.keyboard || !st.keyboard.online) {
    console.log('RESULT: keyboard stayed asleep for the whole wait window; last status', JSON.stringify(st));
    await dev.close();
    return;
  }
  console.log('keyboard awake:', JSON.stringify(st));
  const state = {};
  for (const cmd of [0x83, 0x8f]) {
    try {
      if (cmd === 0x8f) await dongle.feNextLen(dev, 0x40, { wait });
      await dongle.sendToDongle(dev, build([cmd], CHECKSUM.BIT7), 0, state, { wait });
      await wait(10);
      const r = await dongle.readFromDongle(dev, state, { wait });
      console.log(`cmd 0x${cmd.toString(16)} reply ->`, hx(r), r[0] === cmd ? 'ECHO OK' : 'no echo');
      if (cmd === 0x8f && r[0] === cmd) console.log('device id 0x' + (((r[1] | (r[2] << 8) | (r[3] << 16) | ((r[4] | 0x80) << 24)) >>> 0).toString(16)));
    } catch (e) {
      console.log(`cmd 0x${cmd.toString(16)} failed: ${e.message}`);
    }
  }
  const id = await dongle.getDevId(dev, 0, {}, { wait }).catch((e) => `failed: ${e.message}`);
  console.log('RESULT: getDevId ->', typeof id === 'number' ? '0x' + id.toString(16) : id);
  await dev.close();
}
main().catch((e) => { console.error('wakewait failed:', e.message); process.exit(1); });
