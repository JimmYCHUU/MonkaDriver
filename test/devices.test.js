'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listHidraw, classify, parseTopLevelCollections } = require('../bridge/hid/devices');

// report descriptors captured from the real A75 dongle (hidraw0/1/2)
const RD_IF0 = '05010906a1010508150025011901290575019505910295039101050719e029e775019508810295088101150026ff00190029ff0075089506810000c0';
const RD_IF1 = '050c0901a10185031900293c031500263c03950175108100c0050109 80a10185020501198129831500250195037501810295017505810 1c0050109 06a10185010507150025011900297795787501810 2c005010902a101850609 01a1000509150025011901290575019505810295038101050116 0180 26ff7f09300931751095028106158125 7f09387508950181 06050c0a3802950181 06c0c006ffff0901a101850509011500 26ff007508950381 02c0'.replace(/ /g, '');
const RD_IF2 = '06ffff0902a1010902158025 7f954075 08b102c0'.replace(/ /g, '');

function fakeSysfs(devs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monka-sysfs-'));
  for (const d of devs) {
    const dir = path.join(root, d.node, 'device');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'uevent'),
      `DRIVER=hid-generic\nHID_ID=0003:${d.vid.toString(16).padStart(8, '0').toUpperCase()}:${d.pid.toString(16).padStart(8, '0').toUpperCase()}\nHID_NAME=${d.name}\nHID_PHYS=usb-0000:09:00.3-3/input${d.iface}\nHID_UNIQ=\n`);
    fs.writeFileSync(path.join(dir, 'report_descriptor'), Buffer.from(d.rd, 'hex'));
  }
  return root;
}

const A75 = [
  { node: 'hidraw0', vid: 0x3151, pid: 0x4011, name: 'ROYUAN 2.4G Wireless Keyboard', iface: 0, rd: RD_IF0 },
  { node: 'hidraw1', vid: 0x3151, pid: 0x4011, name: 'ROYUAN 2.4G Wireless Keyboard', iface: 1, rd: RD_IF1 },
  { node: 'hidraw2', vid: 0x3151, pid: 0x4011, name: 'ROYUAN 2.4G Wireless Keyboard', iface: 2, rd: RD_IF2 },
  { node: 'hidraw3', vid: 0x09da, pid: 0x8736, name: 'SIGMACHIP USB Mouse', iface: 0, rd: RD_IF0 },
];

test('parses top-level (usagePage, usage) collections from a report descriptor', () => {
  assert.deepEqual(parseTopLevelCollections(Buffer.from(RD_IF2, 'hex')), [{ usagePage: 0xffff, usage: 2, reportIds: [] }]);
  const if1 = parseTopLevelCollections(Buffer.from(RD_IF1, 'hex'));
  assert.deepEqual(if1.at(-1), { usagePage: 0xffff, usage: 1, reportIds: [5] });
  assert.deepEqual(if1[0], { usagePage: 0x0c, usage: 1, reportIds: [3] });
  assert.equal(if1.length, 5);
});

test('lists hidraw nodes with vid/pid/interface/collections from sysfs', () => {
  const root = fakeSysfs(A75);
  const list = listHidraw(root);
  assert.equal(list.length, 4);
  const if2 = list.find((d) => d.node === '/dev/hidraw2');
  assert.equal(if2.vid, 0x3151);
  assert.equal(if2.pid, 0x4011);
  assert.equal(if2.interface, 2);
  assert.deepEqual(if2.collections, [{ usagePage: 0xffff, usage: 2, reportIds: [] }]);
  assert.equal(if2.name, 'ROYUAN 2.4G Wireless Keyboard');
});

test('classifies the A75 dongle command interface as a dongle_common support device', () => {
  const list = listHidraw(fakeSysfs(A75));
  const roles = Object.fromEntries(list.map((d) => [d.node, classify(d)]));
  assert.deepEqual(roles['/dev/hidraw2'], { kind: 'support', dongleCommon: true, ble: false, usagePage: 0xffff, usage: 2, reportIds: [] });
  assert.deepEqual(roles['/dev/hidraw1'], { kind: 'vender', usagePage: 0xffff, usage: 1, reportIds: [5] });
  assert.equal(roles['/dev/hidraw0'], undefined);
  assert.equal(roles['/dev/hidraw3'], undefined);
});
