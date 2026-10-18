#!/usr/bin/env node
'use strict';
// Re-apply the keyboard's OWN lighting parameters (the vendor UI does this at
// start-up: GET_LEDPARAM 0x87 → SET_LEDPARAM 0x07 with identical bytes). This is
// the one write the read-only gate refused; the user asked to restore the lights.
// Steps: wait until the keyboard is awake → read 0x87 → verify it matches the
// expected bytes (unless --force) → send 0x07 + same bytes → read 0x87 again.
// Usage: node tools/restore-lights.js [/dev/hidrawN] [maxMinutes] [--cs=0|2] [--force]
const { HidDevice } = require('../bridge/hid/hidasync');
const { build, CHECKSUM } = require('../bridge/hid/frame');
const dongle = require('../bridge/hid/dongle');

const EXPECTED = Buffer.from([0x08, 0x02, 0x04, 0x07, 0x00, 0xff, 0xff]); // read by the UI on 2026-10-18
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (b) => Buffer.from(b).subarray(0, 16).toString('hex');

async function getThroughDongle(dev, cmd, state) {
  await dongle.feNextLen(dev, 0x40, { wait });
  await dongle.sendToDongle(dev, build([cmd], CHECKSUM.BIT7), 0, state, { wait });
  await wait(10);
  return dongle.readFromDongle(dev, state, { wait });
}

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => a.startsWith('/dev/')) || '/dev/hidraw2';
  const maxMs = Number((args.find((a) => /^\d+$/.test(a)) || 20)) * 60000;
  const cs = Number((args.find((a) => a.startsWith('--cs=')) || '--cs=0').slice(5));
  const force = args.includes('--force');
  const dev = await HidDevice.open(path);
  const t0 = Date.now();
  let st;
  for (;;) {
    st = await dongle.f7Status(dev, { wait });
    if (st && st.keyboard && st.keyboard.online && st.keyboard.ready) break;
    if (Date.now() - t0 > maxMs) { console.log('RESULT: keyboard not awake within the wait window:', JSON.stringify(st)); await dev.close(); return; }
    await wait(1500);
  }
  console.log('keyboard awake:', JSON.stringify(st));
  const state = {};
  const before = await getThroughDongle(dev, 0x87, state);
  console.log('GET_LEDPARAM before ->', hx(before));
  if (before[0] !== 0x87) { console.log('RESULT: no reply to GET_LEDPARAM; nothing written'); await dev.close(); return; }
  const params = before.subarray(1, 8);
  if (!force && !params.equals(EXPECTED)) {
    console.log(`RESULT: stored lighting params ${params.toString('hex')} differ from the expected ${EXPECTED.toString('hex')}; nothing written (use --force to re-apply the current values anyway)`);
    await dev.close();
    return;
  }
  const msg = Buffer.concat([Buffer.from([0x07]), params]);
  const frame = build(msg, cs);
  console.log('SET_LEDPARAM (re-apply) ->', hx(frame));
  await dongle.sendToDongle(dev, frame, 0, state, { wait });
  await wait(50);
  const after = await getThroughDongle(dev, 0x87, state);
  console.log('GET_LEDPARAM after  ->', hx(after));
  console.log('RESULT:', after[0] === 0x87 && after.subarray(1, 8).equals(params) ? 'parameters unchanged and re-applied' : 'unexpected reply');
  await dev.close();
}
main().catch((e) => { console.error('restore-lights failed:', e.message); process.exit(1); });
