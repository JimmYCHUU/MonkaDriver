'use strict';
// DriverGrpc method implementations. HID-related methods delegate to the HID
// manager (bridge/hid/manager.js); everything else is implemented here.
const { execFile } = require('node:child_process');
const { GrpcError, STATUS } = require('./grpcweb');
const { KvStore } = require('./kvstore');
const { SystemInfoSampler } = require('./sysinfo');

function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

function createService({ userData, exec = defaultExec, hid = null, readOnly = true, log = () => {}, sysInfoIntervalMs = 1000, version = '1.7.5' }) {
  const kv = new KvStore({ root: userData });
  const sampler = new SystemInfoSampler();
  const needHid = () => {
    if (!hid) throw new GrpcError(STATUS.UNAVAILABLE, 'HID layer not available');
    return hid;
  };

  const handlers = {
    // ---- device I/O (HID manager) ----
    watchDevList: (req, stream) => needHid().watchDevList(stream),
    watchVender: (req, stream) => needHid().watchVender(stream),
    sendMsg: (req) => needHid().sendMsg(req),
    readMsg: (req) => needHid().readMsg(req),
    sendRawFeature: (req) => needHid().sendRawFeature(req),
    readRawFeature: (req) => needHid().readRawFeature(req),
    cleanDev: async (req) => { if (hid && hid.cleanDev) await hid.cleanDev(req); return { err: '' }; },
    setLightType: async (req) => {
      log(`setLightType ${req.lighttype} for ${req.devicepath} (music/screen sync not supported on Linux; acknowledged)`);
      return {};
    },
    changeWirelessLoopStatus: async (req) => { if (hid && hid.setLoopLock) await hid.setLoopLock(Boolean(req.lock)); return {}; },

    // ---- misc ----
    getVersion: async () => ({ baseversion: version, timestamp: String(Math.floor(Date.now() / 1000)) }),
    getWeather: async () => { throw new GrpcError(STATUS.UNAVAILABLE, 'weather service not available on Linux'); },
    upgradeOTAGATT: async (req, stream) => { stream.end(new GrpcError(STATUS.UNIMPLEMENTED, 'BLE OTA upgrade is not supported on Linux')); },

    watchSystemInfo: async (req, stream) => {
      let timer = null;
      let closed = false;
      const tick = async () => {
        if (closed || !stream.open) return;
        try {
          const sample = await sampler.sample();
          if (!closed) stream.write(sample);
        } catch (e) { log('sysinfo sample failed', e); }
      };
      stream.onClose(() => {
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
        if (stream.end) stream.end();
      });
      await tick();
      timer = setInterval(tick, sysInfoIntervalMs);
      if (timer.unref) timer.unref();
    },

    // ---- microphone ----
    muteMicrophone: async (req) => {
      try { await exec('wpctl', ['set-mute', '@DEFAULT_AUDIO_SOURCE@', req.needMute ? '1' : '0']); return { err: '' }; } catch (e) { return { err: String(e.message || e) }; }
    },
    toggleMicrophoneMute: async () => {
      try { await exec('wpctl', ['set-mute', '@DEFAULT_AUDIO_SOURCE@', 'toggle']); return { err: '' }; } catch (e) { return { err: String(e.message || e) }; }
    },
    getMicrophoneMute: async () => {
      try {
        const out = await exec('wpctl', ['get-volume', '@DEFAULT_AUDIO_SOURCE@']);
        return { isMute: /\[MUTED\]/.test(out), err: '' };
      } catch (e) { return { isMute: false, err: String(e.message || e) }; }
    },

    // ---- key/value store ----
    insertDb: async (req) => {
      try { await kv.insert(req.dbpath, req.key, req.value); return { err: '' }; } catch (e) { return { err: String(e.message || e) }; }
    },
    deleteItemFromDb: async (req) => {
      try { await kv.delete(req.dbpath, req.key); return { err: '' }; } catch (e) { return { err: String(e.message || e) }; }
    },
    getItemFromDb: async (req) => {
      try {
        const v = await kv.get(req.dbpath, req.key);
        if (v === undefined) return { value: Buffer.alloc(0), errStr: 'not found' };
        return { value: v, errStr: '' };
      } catch (e) { return { value: Buffer.alloc(0), errStr: String(e.message || e) }; }
    },
    getAllKeysFromDb: async (req) => {
      try { return { data: await kv.keys(req.dbpath), errStr: '' }; } catch (e) { return { data: [], errStr: String(e.message || e) }; }
    },
    getAllValuesFromDb: async (req) => {
      try { return { data: await kv.values(req.dbpath), errStr: '' }; } catch (e) { return { data: [], errStr: String(e.message || e) }; }
    },
  };

  return { handlers, kv, readOnly, userData, close() { if (hid && hid.close) return hid.close(); } };
}

module.exports = { createService };
