'use strict';
// System information for the renderer's watchSystemInfo stream (used by
// keyboards with screens); sourced from /proc and statfs.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');

async function readFile(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return ''; }
}

class SystemInfoSampler {
  constructor({ root = '/', procRoot = '/proc' } = {}) {
    this.root = root;
    this.procRoot = procRoot;
    this._lastCpu = null;
  }

  async _mem() {
    const text = await readFile(`${this.procRoot}/meminfo`);
    const kv = {};
    for (const line of text.split('\n')) {
      const m = /^(\w+):\s+(\d+)/.exec(line);
      if (m) kv[m[1]] = Number(m[2]) * 1024;
    }
    const total = kv.MemTotal || 0;
    const avail = kv.MemAvailable !== undefined ? kv.MemAvailable : (kv.MemFree || 0);
    return { memTotal: total, memUsed: Math.max(0, total - avail) };
  }

  async _disk() {
    try {
      const st = await fs.statfs(this.root);
      return { diskSpaceTotal: st.blocks * st.bsize, diskSpceAvailable: st.bavail * st.bsize };
    } catch {
      return { diskSpaceTotal: 0, diskSpceAvailable: 0 };
    }
  }

  async _net() {
    const text = await readFile(`${this.procRoot}/net/dev`);
    let rx = 0, tx = 0;
    for (const line of text.split('\n').slice(2)) {
      const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
      if (!m || m[1].trim() === 'lo') continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      rx += f[0] || 0;
      tx += f[8] || 0;
    }
    return { netWorkTotalUp: tx, netWorkTotalDown: rx };
  }

  async _cpu() {
    const text = await readFile(`${this.procRoot}/stat`);
    const line = text.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return { cpuUsage: 0 };
    const f = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (f[3] || 0) + (f[4] || 0);
    const total = f.reduce((a, b) => a + b, 0);
    let usage = 0;
    if (this._lastCpu) {
      const dt = total - this._lastCpu.total;
      const di = idle - this._lastCpu.idle;
      if (dt > 0) usage = Math.min(100, Math.max(0, (100 * (dt - di)) / dt));
    }
    this._lastCpu = { total, idle };
    return { cpuUsage: usage };
  }

  _temp() {
    try {
      const base = '/sys/class/thermal';
      for (const z of fsSync.readdirSync(base)) {
        if (!z.startsWith('thermal_zone')) continue;
        const type = fsSync.readFileSync(`${base}/${z}/type`, 'utf8').trim();
        if (/x86_pkg_temp|cpu|k10temp|coretemp|acpitz/i.test(type)) {
          return { cpuTemperater: Number(fsSync.readFileSync(`${base}/${z}/temp`, 'utf8')) / 1000 };
        }
      }
    } catch { /* no thermal info */ }
    return { cpuTemperater: 0 };
  }

  async sample() {
    const [mem, disk, net, cpu] = await Promise.all([this._mem(), this._disk(), this._net(), this._cpu()]);
    return { ...mem, ...disk, ...net, ...cpu, ...this._temp() };
  }
}

module.exports = { SystemInfoSampler };
