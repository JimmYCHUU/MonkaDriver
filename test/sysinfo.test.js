'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SystemInfoSampler } = require('../bridge/sysinfo');

test('samples memory, disk, network and cpu figures from /proc', async () => {
  const s = new SystemInfoSampler();
  const a = await s.sample();
  await new Promise((r) => setTimeout(r, 30));
  const b = await s.sample();
  assert.ok(b.memTotal > 0);
  assert.ok(b.memUsed > 0 && b.memUsed <= b.memTotal);
  assert.ok(b.diskSpaceTotal > 0);
  assert.ok(b.diskSpceAvailable >= 0 && b.diskSpceAvailable <= b.diskSpaceTotal);
  assert.ok(b.netWorkTotalUp >= 0 && b.netWorkTotalDown >= 0);
  assert.ok(b.cpuUsage >= 0 && b.cpuUsage <= 100, `cpuUsage ${b.cpuUsage}`);
  assert.equal(typeof b.cpuTemperater, 'number');
  assert.equal(typeof a.cpuUsage, 'number');
});
