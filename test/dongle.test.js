'use strict';
// Dongle ("dangle common") protocol as recovered in docs/protocol-re.md Q2.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HidDevice } = require('../bridge/hid/hidasync');
const { FakeHidModule } = require('../bridge/hid/fake');
const dongle = require('../bridge/hid/dongle');

// scripted dongle: keyboard paired, battery 88, online, ready; answers 8F with the A75 id
function scriptedDongle({ online = true, ready = true, battery = 88, mouse = false } = {}) {
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
      case 0x83: pending = Buffer.from([0x83, battery]); return undefined;
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

test('sendToDongle gives up after 15 F7 attempts when the device is offline', async () => {
  const { fake, dev } = scriptedDongle({ online: false });
  const hd = await HidDevice.open('/dev/hidraw2', fake);
  await assert.rejects(dongle.sendToDongle(hd, Buffer.alloc(64), 0, {}, fast), /not online/);
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
  assert.deepEqual(st, { keyboardId: 0x80000790, mouseId: 0, keyboard: { battery: 77, isOnline: true }, mouse: null });
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
