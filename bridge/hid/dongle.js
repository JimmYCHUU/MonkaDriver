'use strict';
// Dongle ("dangle common") protocol, recovered from the helper
// (docs/protocol-re.md, Q2). All housekeeping frames use CheckSumType NONE.
//
//   F7        status: r[1]=battery, r[6] selects the populated word
//             (1/3 → keyboard: online=(r[3]==0); 2 → mouse: online=(r[4]==0)),
//             flag=(r[0]==1), ready=(r[5]==1); all-zero reply = nothing paired
//   F6 sel    select target: byte {0:0x0A keyboard, 1:0x05 mouse, 2:0x0D}; cached
//   FE len    announce next packet length (10 ms after)
//   FC        prelude before reading a reply through the dongle
//   8F        GET_INFOR through the dongle → device id = LE(r[1..4]) | 0x80000000
const { build, pad, CHECKSUM } = require('./frame');

const F6_BYTES = [0x0a, 0x05, 0x0d];
const ONLINE_TRIES = 15;
const RETRY_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseF7(r) {
  if (!r || r.length < 7 || r.every((b) => b === 0)) return null;
  const word = (onlineByte) => ({ flag: r[0] === 1, online: r[onlineByte] === 0, ready: r[5] === 1 });
  let keyboard = null;
  let mouse = null;
  if (r[6] === 1 || r[6] === 3) keyboard = word(3);
  else if (r[6] === 2) mouse = word(4);
  return { battery: r[1], keyboard, mouse };
}

async function f7Status(dev, { wait = sleep } = {}) {
  await dev.writeFeature(pad([0xf7]));
  await wait(1);
  let r = await dev.readFeature();
  let st = parseF7(r);
  if (!st) { // the helper re-issues the query once when the reply is empty
    await dev.writeFeature(pad([0xf7]));
    await wait(1);
    r = await dev.readFeature();
    st = parseF7(r);
  }
  return st;
}

async function waitOnline(dev, { wait = sleep, needReady = true } = {}) {
  let last = null;
  for (let i = 0; i < ONLINE_TRIES; i++) {
    const st = await f7Status(dev, { wait });
    last = st;
    if (st) {
      const online = (st.keyboard && st.keyboard.online) || (st.mouse && st.mouse.online);
      const ready = (st.keyboard && st.keyboard.ready) || (st.mouse && st.mouse.ready);
      if (online && (!needReady || ready)) return st;
    }
    await wait(RETRY_MS);
  }
  const online = last && ((last.keyboard && last.keyboard.online) || (last.mouse && last.mouse.online));
  throw new Error(online ? 'dongle busy: F7 ready flag never set' : 'dev is not online');
}

async function f6Select(dev, sel, state, { wait = sleep } = {}) {
  if (state.lastSel === sel) return;
  await dev.writeFeature(pad([0xf6, F6_BYTES[sel] || F6_BYTES[0]]));
  await wait(10);
  state.lastSel = sel;
}

async function feNextLen(dev, len, { wait = sleep } = {}) {
  await dev.writeFeature(pad([0xfe, len & 0xff]));
  await wait(10);
}

// Send a (checksummed) 64-byte frame to the device paired with the dongle.
async function sendToDongle(dev, frame, sel, state, { wait = sleep } = {}) {
  state.pausedUntil = Date.now() + 5000;
  await waitOnline(dev, { wait });
  await wait(1);
  await f6Select(dev, sel, state, { wait });
  await dev.writeFeature(frame);
}

// Read the reply of the previously sent command through the dongle.
async function readFromDongle(dev, state, { wait = sleep } = {}) {
  state.pausedUntil = Date.now() + 5000;
  await waitOnline(dev, { wait });
  await dev.writeFeature(pad([0xfc]));
  await wait(10);
  await wait(10);
  return dev.readFeature();
}

async function getDevId(dev, sel, state, { wait = sleep } = {}) {
  await feNextLen(dev, 0x40, { wait });
  await sendToDongle(dev, build([0x8f], CHECKSUM.BIT7), sel, state, { wait });
  await wait(10);
  const r = await readFromDongle(dev, state, { wait });
  if (!r || r.length < 5) return 0;
  return ((r[1] | (r[2] << 8) | (r[3] << 16) | ((r[4] | 0x80) << 24)) >>> 0);
}

// One polling round for a dongle_common device (called by the HID manager).
async function pollStatus(dev, info, { state, wait = sleep, log = () => {} } = {}) {
  if (state.pausedUntil && Date.now() < state.pausedUntil) return state.last === undefined ? null : state.last;
  const st = await f7Status(dev, { wait });
  if (!st) { state.last = null; return null; }
  // ids can only be read while the device is awake (the helper fetches them when a device appears online)
  if (st.keyboard && st.keyboard.online && !state.keyboardId) {
    try { state.keyboardId = await getDevId(dev, 0, state, { wait }); log(`dongle ${dev.path}: keyboard id 0x${state.keyboardId.toString(16)}`); } catch (e) { log(`keyboard id query failed: ${e.message}`); }
  }
  if (st.mouse && st.mouse.online && !state.mouseId) {
    try { state.mouseId = await getDevId(dev, 1, state, { wait }); log(`dongle ${dev.path}: mouse id 0x${state.mouseId.toString(16)}`); } catch (e) { log(`mouse id query failed: ${e.message}`); }
  }
  const result = {
    keyboardId: state.keyboardId || 0,
    mouseId: state.mouseId || 0,
    keyboard: st.keyboard ? { battery: st.battery, isOnline: st.keyboard.online } : null,
    mouse: st.mouse ? { battery: st.battery, isOnline: st.mouse.online } : null,
  };
  state.last = result;
  return result;
}

// Emulated A75 dongle for MONKA_FAKE_HID=1 (keyboard paired, 88 %, online).
// Forwarded commands are answered after the FC prelude, like the real dongle.
function createFakeResponder() {
  let pending = Buffer.alloc(64);
  return (frame) => {
    switch (frame[0]) {
      case 0xf7: { const r = Buffer.alloc(64); r[0] = 1; r[1] = 88; r[3] = 0; r[4] = 1; r[5] = 1; r[6] = 1; return r; }
      case 0xf6: case 0xfe: return undefined;
      case 0xfc: return pending;
      case 0x8f: pending = Buffer.from([0x8f, 0x90, 0x07, 0x00, 0x00]); return undefined;
      case 0x83: pending = Buffer.from([0x83, 88]); return undefined;
      case 0x80: pending = Buffer.from([0x80, 1, 0, 2, 0]); return undefined;
      default: pending = Buffer.from([frame[0]]); return undefined;
    }
  };
}
const fakeResponder = createFakeResponder();

module.exports = { parseF7, f7Status, waitOnline, f6Select, feNextLen, sendToDongle, readFromDongle, getDevId, pollStatus, fakeResponder, createFakeResponder, F6_BYTES };
