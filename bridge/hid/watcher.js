'use strict';
// Hotplug watcher: polls sysfs (cheap) and emits 'change' events with the
// classified set of hidraw devices we care about.
const { EventEmitter } = require('node:events');
const { listHidraw, classify } = require('./devices');

class DeviceWatcher extends EventEmitter {
  constructor({ sysRoot = '/sys/class/hidraw', intervalMs = 1000, table } = {}) {
    super();
    this.sysRoot = sysRoot;
    this.intervalMs = intervalMs;
    this.table = table;
    this.devices = new Map(); // node -> device (with .role)
    this._initialized = false;
    this._timer = null;
  }

  scan() {
    const found = [];
    for (const dev of listHidraw(this.sysRoot)) {
      const role = classify(dev, this.table);
      if (role) found.push({ ...dev, role });
    }
    return found;
  }

  poll() {
    let found;
    try { found = this.scan(); } catch (e) { this.emit('error', e); return; }
    const next = new Map(found.map((d) => [d.node, d]));
    if (!this._initialized) {
      this._initialized = true;
      this.devices = next;
      this.emit('change', { type: 'INIT', devices: [...next.values()], added: [...next.values()], removed: [] });
      return;
    }
    const added = [...next.values()].filter((d) => !this.devices.has(d.node) || this.devices.get(d.node).vid !== d.vid || this.devices.get(d.node).pid !== d.pid);
    const removed = [...this.devices.values()].filter((d) => !next.has(d.node) || next.get(d.node).vid !== d.vid || next.get(d.node).pid !== d.pid);
    if (added.length === 0 && removed.length === 0) return;
    this.devices = next;
    const devices = [...next.values()];
    if (removed.length) this.emit('change', { type: 'REMOVE', devices: devices.filter((d) => !added.includes(d)), added: [], removed });
    if (added.length) this.emit('change', { type: 'ADD', devices, added, removed: [] });
  }

  start() {
    if (this._timer) return;
    this.poll();
    this._timer = setInterval(() => this.poll(), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { DeviceWatcher };
