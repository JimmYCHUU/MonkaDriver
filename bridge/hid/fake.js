'use strict';
// In-memory stand-in for node-hid (HIDAsync subset) used by tests and by the
// bridge when MONKA_FAKE_HID=1. Records sent reports; answers feature reads
// from canned responses or a responder callback.
const { EventEmitter } = require('node:events');

class FakeHidDevice extends EventEmitter {
  constructor(path, { latencyMs = 0 } = {}) {
    super();
    this.path = path;
    this.latencyMs = latencyMs;
    this.sent = [];
    this._feature = Buffer.alloc(65);
    this.responder = null; // (frame64) => response64 | undefined
    this.isOpen = true;
  }

  _delay() { return this.latencyMs ? new Promise((r) => setTimeout(r, this.latencyMs)) : Promise.resolve(); }

  async sendFeatureReport(data) {
    await this._delay();
    const buf = Buffer.from(data);
    this.sent.push(buf);
    if (this.responder) {
      const resp = this.responder(buf.subarray(1));
      if (resp) this.setFeatureResponse(resp);
    }
    return buf.length;
  }

  async getFeatureReport(reportId, len) {
    await this._delay();
    return Buffer.from(this._feature.subarray(0, len));
  }

  setFeatureResponse(bytes) {
    this._feature = Buffer.alloc(65);
    Buffer.from(bytes).copy(this._feature, 1);
  }

  emitInput(bytes) { this.emit('data', Buffer.from(bytes)); }

  async close() { this.isOpen = false; }
}

class FakeHidModule {
  constructor() {
    this.devices = {};
    const self = this;
    this.HIDAsync = {
      async open(path) {
        const d = self.devices[path];
        if (!d) throw new Error(`cannot open device with path ${path}`);
        return d;
      },
    };
  }

  addDevice(path, opts) {
    const d = new FakeHidDevice(path, opts);
    this.devices[path] = d;
    return d;
  }
}

module.exports = { FakeHidModule, FakeHidDevice };
