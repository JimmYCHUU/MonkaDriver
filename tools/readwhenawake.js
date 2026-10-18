#!/usr/bin/env node
'use strict';
// Read-only: wait until the keyboard behind the dongle is awake, then read the
// given GET commands (each preceded by a GET_REV marker read so stale replies
// are detected) and print the replies.
//   node tools/readwhenawake.js 87 88 [--path=/dev/hidrawN] [--minutes=15]
const { HidDevice } = require('../bridge/hid/hidasync');
const { build, CHECKSUM } = require('../bridge/hid/frame');
const dongle = require('../bridge/hid/dongle');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (b) => Buffer.from(b).subarray(0, 16).toString('hex');

async function getCmd(dev, state, cmd) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await dongle.sendToDongle(dev, build([cmd], CHECKSUM.BIT7), 0, state, { wait });
    await wait(80);
    const r = await dongle.readFromDongle(dev, state, { wait });
    if (r[0] === cmd) return r;
    await wait(150);
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const path = (args.find((a) => a.startsWith('--path=')) || '--path=/dev/hidraw2').slice(7);
  const minutes = Number((args.find((a) => a.startsWith('--minutes=')) || '--minutes=15').slice(10));
  const cmds = args.filter((a) => !a.startsWith('--')).map((h) => parseInt(h, 16));
  for (const c of cmds) if (!(c >= 0x80)) throw new Error('GET commands only');
  const dev = await HidDevice.open(path);
  const t0 = Date.now();
  let st;
  for (;;) {
    st = await dongle.f7Status(dev, { wait });
    if (st && st.keyboard && st.keyboard.online && st.keyboard.ready) break;
    if (Date.now() - t0 > minutes * 60000) { console.log('RESULT: keyboard did not wake up within', minutes, 'min'); await dev.close(); return; }
    await wait(1500);
  }
  console.log('keyboard awake:', JSON.stringify(st));
  const state = {};
  for (const c of cmds) {
    await getCmd(dev, state, 0x80); // marker
    const r = await getCmd(dev, state, c);
    console.log(`GET 0x${c.toString(16)} ->`, r ? hx(r) : 'no reply');
  }
  await dev.close();
}
main().catch((e) => { console.error('readwhenawake failed:', e.message); process.exit(1); });
