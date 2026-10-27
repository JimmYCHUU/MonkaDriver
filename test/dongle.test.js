'use strict';
// Dongle ("dangle common") protocol as recovered in docs/protocol-re.md Q2.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HidDevice } = require('../bridge/hid/hidasync');
const { FakeHidModule } = require('../bridge/hid/fake');
const dongle = require('../bridge/hid/dongle');

// scripted dongle: keyboard paired, battery 88, online, ready; answers 8F with the A75 id
function scriptedDongle({ online = true, ready = true, battery = 88, mouse = false, power = 0 } = {}) {
  const fake = new FakeHidModule();
  const dev = fake.addDevice('/dev/hidraw2');
  let pending = Buffer.alloc(64); // reply of the paired device, exposed after FC
  dev.responder = (frame) => {
    switch (frame[0]) {
      case 0xf7: {
        const r = Buffer.alloc(64);
        r[0] = 1; r[1] = battery; r[3] = online ? 0 : 1; r[4] = mouse && online ? 0 : 1; r[5] = ready ? 1 : 0; r[6] = mouse ? 2 : 1;
        return r;
      }
      case 0xf6: case 0xfe: return undefined; // housekeeping, no reply
      case 0xfc: return pending;
      case 0x8f: pending = Buffer.from([0x8f, 0x90, 0x07, 0x00, 0x00]); return undefined;
      case 0x83: pending = Buffer.from([0x83, battery, typeof power === 'function' ? power() : power]); return undefined;
      default: pending = Buffer.from([frame[0]]); return undefined; // echo
    }
  };
  return { fake, dev, setPending: (b) => { pending = Buffer.from(b); } };
}

const fast = { wait: async () => {} }; // no real sleeps in tests

test('F7 status parse: keyboard word populated, mouse absent', async () => {
  const { fake, dev } = scriptedDongle();
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  const st = await dongle.f7Status(hd, fast);
  assert.deepEqual(st, { battery: 88, keyboard: { flag: true, online: true, ready: true }, mouse: null });
  assert.equal(dev.sent.at(-1)[1], 0xf7);
});

test('F7 status parse: mouse word, offline keyboard, and all-zero reply', async () => {
  const { fake } = scriptedDongle({ mouse: true, online: true });
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  const st = await dongle.f7Status(hd, fast);
  assert.equal(st.keyboard, null);
  assert.deepEqual(st.mouse, { flag: true, online: true, ready: true });
  assert.equal(dongle.parseF7(Buffer.alloc(64)), null);
  const off = dongle.parseF7(Buffer.from([1, 50, 0, 1, 1, 0, 1]));
  assert.deepEqual(off.keyboard, { flag: true, online: false, ready: false });
});

test('sendToDongle: F7 until online+ready, then F6 select (cached) and the frame', async () => {
  const { fake, dev } = scriptedDongle();
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  const state = {};
  const frame = Buffer.alloc(64); frame[0] = 0x83; frame[7] = 0x7c;
  await dongle.sendToDongle(hd, frame, 0, state, fast);
  const seq = dev.sent.map((b) => b.subarray(1, 3).toString('hex'));
  assert.deepEqual(seq, ['f700', 'f60a', '8300']);
  await dongle.sendToDongle(hd, frame, 0, state, fast);
  assert.deepEqual(dev.sent.slice(3).map((b) => b.subarray(1, 3).toString('hex')), ['f700', '8300'], 'F6 skipped for the same selection');
  await dongle.sendToDongle(hd, frame, 1, state, fast);
  assert.ok(dev.sent.some((b) => b[1] === 0xf6 && b[2] === 0x05), 'mouse selection byte 0x05');
});

test('sendToDongle retries the ready flag 15 times when the dongle stays busy', async () => {
  const { fake, dev } = scriptedDongle({ ready: false });
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  await assert.rejects(dongle.sendToDongle(hd, Buffer.alloc(64), 0, {}, fast), /busy|ready/);
  assert.equal(dev.sent.filter((b) => b[1] === 0xf7).length, 15);
  assert.equal(dev.sent.filter((b) => b[1] === 0xf6).length, 0);
});

test('readFromDongle: F7 wait, FC prelude, then the feature read', async () => {
  const { fake, dev, setPending } = scriptedDongle();
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  setPending([0x83, 88]);
  const r = await dongle.readFromDongle(hd, {}, fast);
  assert.equal(r.length, 64);
  assert.equal(r[0], 0x83);
  assert.equal(r[1], 88);
  const seq = dev.sent.map((b) => b[1]);
  assert.deepEqual(seq.slice(-2), [0xf7, 0xfc]);
});

test('getDevId: FE 40, then 8F with BIT7 checksum through the dongle, id = LE bytes 1..4 | 0x80000000', async () => {
  const { fake, dev } = scriptedDongle();
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  const id = await dongle.getDevId(hd, 0, {}, fast);
  assert.equal(id, 0x80000790);
  const frames = dev.sent.map((b) => b.subarray(1));
  const fe = frames.find((f) => f[0] === 0xfe);
  assert.equal(fe[1], 0x40);
  const q = frames.find((f) => f[0] === 0x8f);
  assert.equal(q[7], 0x70, 'BIT7 checksum on the 8F query');
});

test('pollStatus reports battery/online and resolves the keyboard id once', async () => {
  const { fake, dev } = scriptedDongle({ battery: 77 });
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  const state = {};
  const st = await dongle.pollStatus(hd, { role: { dongleCommon: true } }, { state, wait: fast.wait, log: () => {} });
  assert.deepEqual(st, { keyboardId: 0x80000790, mouseId: 0, keyboard: { battery: 77, isOnline: true, charging: false }, mouse: null });
  const n8f = () => dev.sent.filter((b) => b[1] === 0x8f).length;
  assert.equal(n8f(), 1);
  await dongle.pollStatus(hd, { role: { dongleCommon: true } }, { state, wait: fast.wait, log: () => {} });
  assert.equal(n8f(), 1, 'id cached');
});

test('pollStatus returns null when the dongle has nothing paired (all-zero F7)', async () => {
  const fake = new FakeHidModule();
  fake.addDevice('/dev/hidraw2');
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  const st = await dongle.pollStatus(hd, { role: { dongleCommon: true } }, { state: {}, wait: fast.wait, log: () => {} });
  assert.equal(st, null);
});

test('the fake responder emulates an A75 dongle for MONKA_FAKE_HID runs', () => {
  const resp = dongle.createFakeResponder();
  const f7 = resp(Buffer.from([0xf7]));
  assert.deepEqual(dongle.parseF7(f7).keyboard, { flag: true, online: true, ready: true });
  assert.equal(resp(Buffer.from([0x8f])), undefined, 'forwarded command: reply arrives after FC');
  const id = resp(Buffer.from([0xfc]));
  assert.deepEqual([...id.subarray(0, 5)], [0x8f, 0x90, 0x07, 0, 0]);
});

test('pollStatus does not query the device id while the keyboard is asleep (offline)', async () => {
  const { fake, dev } = scriptedDongle({ online: false });
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  const st = await dongle.pollStatus(hd, { role: { dongleCommon: true } }, { state: {}, wait: fast.wait, log: () => {} });
  assert.deepEqual(st, { keyboardId: 0, mouseId: 0, keyboard: { battery: 88, isOnline: false, charging: false }, mouse: null });
  assert.equal(dev.sent.filter((b) => b[1] === 0x8f).length, 0, 'no 8F while offline');
  assert.equal(dev.sent.filter((b) => b[1] === 0xf7).length, 1, 'a single F7');
});

test('getDevId rejects a reply that is not an 8F echo so the next poll retries', async () => {
  const { fake, dev, setPending } = scriptedDongle();
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  fake.devices['/dev/hidraw2'].responder = ((orig) => (frame) => (frame[0] === 0x8f ? undefined : orig(frame)))(dev.responder);
  setPending(Buffer.from([0x00, 0x64, 0x00, 0x00, 0x01, 0x01, 0x01])); // stale F7 buffer
  assert.equal(await dongle.getDevId(hd, 0, {}, fast), 0);
  const state = {};
  const st = await dongle.pollStatus(hd, { role: { dongleCommon: true } }, { state, wait: fast.wait, log: () => {} });
  assert.equal(st.keyboardId, 0);
  state.pausedUntil = 0; // the id query pauses polling for 5 s, like the helper's pasue24loop
  await dongle.pollStatus(hd, { role: { dongleCommon: true } }, { state, wait: fast.wait, log: () => {} });
  assert.equal(dev.sent.filter((b) => b[1] === 0x8f).length, 3, '8F re-sent on every poll until it is answered');
});

test('the keyboard id is re-queried after the keyboard slept', async () => {
  let online = true;
  const { fake, dev } = scriptedDongle();
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  const base = dev.responder;
  dev.responder = (frame) => { const r = base(frame); if (frame[0] === 0xf7) r[3] = online ? 0 : 1; return r; };
  const state = {};
  const ctx = { state, wait: fast.wait, log: () => {} };
  assert.equal((await dongle.pollStatus(hd, { role: { dongleCommon: true } }, ctx)).keyboardId, 0x80000790);
  online = false;
  state.pausedUntil = 0;
  const asleep = await dongle.pollStatus(hd, { role: { dongleCommon: true } }, ctx);
  assert.equal(asleep.keyboard.isOnline, false);
  online = true;
  state.pausedUntil = 0;
  await dongle.pollStatus(hd, { role: { dongleCommon: true } }, ctx);
  assert.equal(dev.sent.filter((b) => b[1] === 0x8f).length, 2, 'id queried again after wake-up');
});

test('an offline keyboard fails sendToDongle immediately (no 15 retries)', async () => {
  const { fake, dev } = scriptedDongle({ online: false });
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  await assert.rejects(dongle.sendToDongle(hd, Buffer.alloc(64), 0, {}, fast), /not online/);
  assert.equal(dev.sent.filter((b) => b[1] === 0xf7).length, 1);
});

test('charging comes from byte 2 of the keyboard\'s GET_BATTERY reply, not the status byte (verified on the A75)', async () => {
  // 2026-10-27: unplugged at 23:27 -> 83 64 00; plugged in at 23:29 -> 83 64 01; long on the charger -> 83 64 02.
  // The F7 status byte 0 pulses with typing and says nothing about power.
  let power = 1;
  const { fake, dev } = scriptedDongle({ battery: 100, power: () => power });
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  const base = dev.responder;
  dev.responder = (frame) => { const r = base(frame); if (frame[0] === 0xf7) r[0] = 0; return r; };
  const state = {};
  const ctx = { state, wait: fast.wait, log: () => {}, batteryEveryMs: 0 };
  assert.equal((await dongle.pollStatus(hd, { role: { dongleCommon: true } }, ctx)).keyboard.charging, true, 'byte 2 = 1: charging');
  power = 2;
  assert.equal((await dongle.pollStatus(hd, { role: { dongleCommon: true } }, ctx)).keyboard.charging, true, 'byte 2 = 2: on the charger, full');
  power = 0;
  dev.responder = (frame) => { const r = base(frame); if (frame[0] === 0xf7) r[0] = 1; return r; }; // a typing pulse
  assert.equal((await dongle.pollStatus(hd, { role: { dongleCommon: true } }, ctx)).keyboard.charging, false, 'byte 2 = 0: on battery');
});

test('the battery query runs at most once per interval, never while asleep, and does not pause status polling', async () => {
  const { fake, dev } = scriptedDongle({ battery: 50, power: 0 });
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  const state = {};
  const ctx = { state, wait: fast.wait, log: () => {}, batteryEveryMs: 60000 };
  await dongle.pollStatus(hd, { role: { dongleCommon: true } }, ctx);
  await dongle.pollStatus(hd, { role: { dongleCommon: true } }, ctx);
  assert.equal(dev.sent.filter((b) => b[1] === 0x83).length, 1, 'once within the interval');
  assert.equal(dev.sent.filter((b) => b[1] === 0xf7).length > 4, true, 'status still polled on the second call');
});
