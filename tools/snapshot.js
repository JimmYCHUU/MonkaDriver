#!/usr/bin/env node
'use strict';
// Configuration snapshot of a keyboard behind the A75 dongle, using GET commands
// only. Reads the frames listed in a text file (one hex message per line, e.g.
// "89 00 03" = GET_KEYMATRIX layer 0 page 3) through the dongle and writes a
// JSON map { "<msghex>": "<reply64hex>" }.
//   node tools/snapshot.js <frames.txt> <out.json> [/dev/hidrawN]
//   node tools/snapshot.js --diff <a.json> <b.json>
const fs = require('node:fs');
const { HidDevice } = require('../bridge/hid/hidasync');
const { build, CHECKSUM } = require('../bridge/hid/frame');
const dongle = require('../bridge/hid/dongle');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function diff(a, b) {
  const A = JSON.parse(fs.readFileSync(a, 'utf8'));
  const B = JSON.parse(fs.readFileSync(b, 'utf8'));
  let changed = 0;
  for (const k of Object.keys(A)) {
    if (!(k in B)) { console.log(`missing in ${b}: ${k}`); changed++; continue; }
    if (A[k] !== B[k]) {
      changed++;
      console.log(`DIFF ${k}\n  a: ${A[k]}\n  b: ${B[k]}`);
    }
  }
  console.log(changed === 0 ? `IDENTICAL (${Object.keys(A).length} frames)` : `${changed} frame(s) differ`);
  process.exit(changed === 0 ? 0 : 1);
}

async function main() {
  if (process.argv[2] === '--diff') return diff(process.argv[3], process.argv[4]);
  const [listFile, outFile, path = '/dev/hidraw2'] = process.argv.slice(2);
  const msgs = fs.readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => Buffer.from(l.replace(/\s+/g, ''), 'hex'));
  for (const m of msgs) if (m[0] < 0x80) throw new Error(`refusing non-GET frame ${m.toString('hex')}`);
  const dev = await HidDevice.open(path);
  const st = await dongle.f7Status(dev, { wait });
  if (!st || !st.keyboard || !st.keyboard.online) { console.error('keyboard is asleep; press a key and retry'); process.exit(2); }
  const state = {};
  const out = {};
  for (const m of msgs) {
    let reply = null;
    for (let attempt = 0; attempt < 3 && !reply; attempt++) {
      await dongle.feNextLen(dev, 0x40, { wait });
      await dongle.sendToDongle(dev, build(m, CHECKSUM.BIT7), 0, state, { wait });
      await wait(15);
      const r = await dongle.readFromDongle(dev, state, { wait });
      // key-matrix / fn pages reply with raw data (no command echo); others echo the command
      if (r.some((b) => b !== 0) || m[0] === 0x89 || m[0] === 0x90) reply = r;
      else await wait(50);
    }
    out[m.toString('hex')] = reply ? reply.toString('hex') : null;
    process.stdout.write(`${m.toString('hex').padEnd(8)} -> ${reply ? reply.subarray(0, 24).toString('hex') : 'no reply'}\n`);
    await wait(20);
  }
  await dev.close();
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log(`saved ${Object.keys(out).length} frames to ${outFile}`);
}
main().catch((e) => { console.error('snapshot failed:', e.message); process.exit(1); });
