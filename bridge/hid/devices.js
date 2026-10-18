'use strict';
// Enumerates hidraw nodes from sysfs (cheap, no USB traffic) and classifies them
// against the helper's embedded support table (support_devices.json).
const fs = require('node:fs');
const path = require('node:path');

const TABLE = require('./support_devices.json');

// Returns the (usagePage, usage) of every top-level collection in a HID report descriptor.
function parseTopLevelCollections(desc) {
  const out = [];
  let usagePage = 0;
  let pendingUsage;
  let depth = 0;
  let i = 0;
  while (i < desc.length) {
    const prefix = desc[i];
    if (prefix === 0xfe) { // long item
      const len = desc[i + 1];
      i += 3 + len;
      continue;
    }
    const size = [0, 1, 2, 4][prefix & 0x3];
    const type = (prefix >> 2) & 0x3; // 0 main, 1 global, 2 local
    const tag = prefix >> 4;
    let value = 0;
    for (let k = 0; k < size; k++) value |= desc[i + 1 + k] << (8 * k);
    value >>>= 0;
    if (type === 1 && tag === 0x0) usagePage = value;
    else if (type === 1 && tag === 0x8) { // report id (global): belongs to the enclosing top-level collection
      const cur = out[out.length - 1];
      if (depth > 0 && cur && !cur.reportIds.includes(value)) cur.reportIds.push(value);
    } else if (type === 2 && tag === 0x0) pendingUsage = size === 4 ? value & 0xffff : value;
    else if (type === 0) {
      if (tag === 0xa) { // collection
        if (depth === 0) out.push({ usagePage, usage: pendingUsage === undefined ? 0 : pendingUsage, reportIds: [] });
        depth++;
      } else if (tag === 0xc) depth--;
      pendingUsage = undefined;
    }
    i += 1 + size;
  }
  return out;
}

function parseUevent(text) {
  const kv = {};
  for (const line of text.split('\n')) {
    const j = line.indexOf('=');
    if (j > 0) kv[line.slice(0, j)] = line.slice(j + 1);
  }
  return kv;
}

// List hidraw devices: [{ node:'/dev/hidrawN', vid, pid, name, interface, collections }]
function listHidraw(sysRoot = '/sys/class/hidraw') {
  let names;
  try { names = fs.readdirSync(sysRoot); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!/^hidraw\d+$/.test(n)) continue;
    try {
      const dev = path.join(sysRoot, n, 'device');
      const ue = parseUevent(fs.readFileSync(path.join(dev, 'uevent'), 'utf8'));
      const [, vidHex, pidHex] = (ue.HID_ID || '').split(':');
      const phys = ue.HID_PHYS || '';
      const im = /input(\d+)$/.exec(phys);
      const desc = fs.readFileSync(path.join(dev, 'report_descriptor'));
      out.push({
        node: `/dev/${n}`,
        vid: parseInt(vidHex, 16) || 0,
        pid: parseInt(pidHex, 16) || 0,
        name: ue.HID_NAME || '',
        phys,
        interface: im ? Number(im[1]) : -1,
        collections: parseTopLevelCollections(desc),
      });
    } catch {
      // device vanished while scanning
    }
  }
  return out;
}

function matches(entry, dev, col) {
  if (entry.vid !== undefined && entry.vid !== dev.vid) return false;
  if (entry.pid !== undefined && entry.pid !== dev.pid) return false;
  if (entry.usage_page !== col.usagePage || entry.usage !== col.usage) return false;
  if (entry.interface_number !== undefined && entry.interface_number >= 0 && entry.interface_number !== dev.interface) return false;
  return true;
}

// Classify a hidraw device: { kind: 'support'|'boot'|'vender', ... } or undefined when not ours.
function classify(dev, table = TABLE) {
  for (const col of dev.collections) {
    for (const e of table.support || []) {
      if (matches(e, dev, col)) return { kind: 'support', dongleCommon: Boolean(e.dongle_common), ble: Boolean(e.ble), usagePage: col.usagePage, usage: col.usage, reportIds: [...col.reportIds] };
    }
    for (const e of table.boot || []) {
      if (matches(e, dev, col)) return { kind: 'boot', usagePage: col.usagePage, usage: col.usage, reportIds: [...col.reportIds] };
    }
    for (const e of table.vender || []) {
      if (matches(e, dev, col)) return { kind: 'vender', usagePage: col.usagePage, usage: col.usage, reportIds: [...col.reportIds] };
    }
  }
  return undefined;
}

module.exports = { listHidraw, classify, parseTopLevelCollections, TABLE };
