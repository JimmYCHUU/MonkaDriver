#!/usr/bin/env node
'use strict';
// Read-only dongle status probe: sends only the F7 status query and prints the
// raw reply bytes, a few times. Usage: node tools/hidprobe.js [/dev/hidrawN] [count]
const { HidDevice } = require('../bridge/hid/hidasync');
const { pad } = require('../bridge/hid/frame');
const { parseF7 } = require('../bridge/hid/dongle');

async function main() {
  const path = process.argv[2] || '/dev/hidraw2';
  const count = Number(process.argv[3] || 5);
  const dev = await HidDevice.open(path);
  for (let i = 0; i < count; i++) {
    await dev.writeFeature(pad([0xf7]));
    await new Promise((r) => setTimeout(r, 5));
    const r = await dev.readFeature();
    console.log(new Date().toISOString().slice(11, 19), 'F7 ->', r.subarray(0, 16).toString('hex'), JSON.stringify(parseF7(r)));
    await new Promise((r) => setTimeout(r, 1500));
  }
  await dev.close();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
