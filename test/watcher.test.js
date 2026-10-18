'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DeviceWatcher } = require('../bridge/hid/watcher');

const RD_IF2 = '06ffff0902a1010902158025 7f954075 08b102c0'.replace(/ /g, '');
const RD_IF1 = '06ffff0901a101850509011500 26ff007508950381 02c0'.replace(/ /g, '');

function addNode(root, node, iface, rd, vid = 0x3151, pid = 0x4011) {
  const dir = path.join(root, node, 'device');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'uevent'), `HID_ID=0003:${vid.toString(16).padStart(8, '0')}:${pid.toString(16).padStart(8, '0')}\nHID_NAME=kb\nHID_PHYS=usb-1/input${iface}\n`);
  fs.writeFileSync(path.join(dir, 'report_descriptor'), Buffer.from(rd, 'hex'));
}

test('first poll emits INIT with the classified devices, later polls emit ADD/REMOVE on change', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monka-watch-'));
  addNode(root, 'hidraw2', 2, RD_IF2);
  const w = new DeviceWatcher({ sysRoot: root });
  const events = [];
  w.on('change', (e) => events.push(e));

  w.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'INIT');
  assert.deepEqual(events[0].devices.map((d) => [d.node, d.role.kind]), [['/dev/hidraw2', 'support']]);

  w.poll();
  assert.equal(events.length, 1, 'no change → no event');

  addNode(root, 'hidraw1', 1, RD_IF1);
  w.poll();
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'ADD');
  assert.deepEqual(events[1].added.map((d) => d.node), ['/dev/hidraw1']);
  assert.equal(events[1].devices.length, 2);

  fs.rmSync(path.join(root, 'hidraw2'), { recursive: true });
  w.poll();
  assert.equal(events[2].type, 'REMOVE');
  assert.deepEqual(events[2].removed.map((d) => d.node), ['/dev/hidraw2']);
  assert.deepEqual(events[2].devices.map((d) => d.node), ['/dev/hidraw1']);
});

test('unrelated hidraw nodes never produce events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monka-watch-'));
  const w = new DeviceWatcher({ sysRoot: root });
  const events = [];
  w.on('change', (e) => events.push(e));
  w.poll();
  assert.equal(events[0].type, 'INIT');
  assert.equal(events[0].devices.length, 0);
  addNode(root, 'hidraw5', 0, RD_IF2, 0x1234, 0x5678);
  w.poll();
  assert.equal(events.length, 1);
});

test('start()/stop() poll on an interval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monka-watch-'));
  const w = new DeviceWatcher({ sysRoot: root, intervalMs: 10 });
  const events = [];
  w.on('change', (e) => events.push(e));
  w.start();
  await new Promise((r) => setTimeout(r, 5));
  addNode(root, 'hidraw2', 2, RD_IF2);
  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(events.map((e) => e.type), ['INIT', 'ADD']);
});
