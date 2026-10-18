'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HidDevice } = require('../bridge/hid/hidasync');
const { FakeHidModule } = require('../bridge/hid/fake');

test('writeFeature prepends report id 0 and sends 65 bytes; readFeature strips the report id', async () => {
  const fake = new FakeHidModule();
  fake.addDevice('/dev/hidraw2');
  const dev = await HidDevice.open('/dev/hidraw2', fake);
  const frame = Buffer.alloc(64, 0);
  frame[0] = 0x80;
  await dev.writeFeature(frame);
  assert.equal(fake.devices['/dev/hidraw2'].sent.length, 1);
  const sent = fake.devices['/dev/hidraw2'].sent[0];
  assert.equal(sent.length, 65);
  assert.equal(sent[0], 0);
  assert.equal(sent[1], 0x80);

  fake.devices['/dev/hidraw2'].setFeatureResponse(Buffer.from([0x80, 1, 2, 3]));
  const got = await dev.readFeature();
  assert.equal(got.length, 64);
  assert.equal(got[0], 0x80);
  assert.equal(got[3], 3);
  await dev.close();
});

test('operations on one device are serialized in call order', async () => {
  const fake = new FakeHidModule();
  fake.addDevice('/dev/hidraw2', { latencyMs: 5 });
  const dev = await HidDevice.open('/dev/hidraw2', fake);
  const order = [];
  await Promise.all([
    dev.run(async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 10)); order.push('a2'); }),
    dev.run(async () => { order.push('b'); }),
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b']);
});

test('input reports are delivered to listeners with the report id included', async () => {
  const fake = new FakeHidModule();
  fake.addDevice('/dev/hidraw1');
  const dev = await HidDevice.open('/dev/hidraw1', fake);
  const got = [];
  dev.onInput((buf) => got.push(Buffer.from(buf)));
  fake.devices['/dev/hidraw1'].emitInput(Buffer.from([5, 15, 1, 0]));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got.map((b) => b.toString('hex')), ['050f0100']);
});

test('open failure surfaces as a rejected promise', async () => {
  const fake = new FakeHidModule();
  await assert.rejects(HidDevice.open('/dev/hidraw9', fake), /hidraw9/);
});
