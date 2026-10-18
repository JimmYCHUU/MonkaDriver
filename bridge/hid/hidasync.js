'use strict';
// Thin wrapper over node-hid's HIDAsync: one serialized queue per device,
// feature report write/read with the report-id byte handled, input listener.

const FEATURE_LEN = 64; // the vendor interface's single feature report (no report id)

class HidDevice {
  static async open(path, hidModule = require('node-hid')) {
    let raw;
    try {
      raw = await hidModule.HIDAsync.open(path);
    } catch (e) {
      throw new Error(`cannot open HID device ${path}: ${e.message || e}`);
    }
    return new HidDevice(path, raw);
  }

  constructor(path, raw) {
    this.path = path;
    this._raw = raw;
    this._queue = Promise.resolve();
    this._listeners = [];
    this.closed = false;
    raw.on('data', (buf) => { for (const cb of this._listeners) { try { cb(buf); } catch { /* listener error */ } } });
    raw.on('error', (e) => { this.lastError = e; for (const cb of this._errorListeners || []) cb(e); });
  }

  run(fn) {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }

  writeFeature(frame) {
    const body = Buffer.from(frame);
    const report = Buffer.alloc(1 + FEATURE_LEN);
    body.copy(report, 1, 0, Math.min(body.length, FEATURE_LEN));
    return this.run(() => this._raw.sendFeatureReport(report));
  }

  readFeature() {
    return this.run(async () => {
      const data = Buffer.from(await this._raw.getFeatureReport(0, 1 + FEATURE_LEN));
      const out = Buffer.alloc(FEATURE_LEN);
      data.copy(out, 0, 1, Math.min(data.length, 1 + FEATURE_LEN));
      return out;
    });
  }

  onInput(cb) { this._listeners.push(cb); }
  onError(cb) { (this._errorListeners = this._errorListeners || []).push(cb); }

  close() {
    this.closed = true;
    return this.run(() => this._raw.close()).catch(() => {});
  }
}

module.exports = { HidDevice, FEATURE_LEN };
