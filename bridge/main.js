'use strict';
// Bridge entry point: a plain Node program (also run by Electron's utilityProcess)
// serving the vendor renderer's gRPC-web API on 127.0.0.1:3814.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proto = require('./proto');
const { createGrpcWebServer } = require('./grpcweb');
const { createService } = require('./service');

const env = process.env;
const argv = process.argv.slice(2);
const PORT = Number(env.MONKA_PORT || 3814);
const userData = env.MONKA_USERDATA || path.join(os.homedir(), '.config', 'monkey-wrench');
const readOnly = !(env.MONKA_READ_ONLY === '0' || env.MONKA_READ_ONLY === 'false' || argv.includes('--rw'));
const fake = env.MONKA_FAKE_HID === '1' || argv.includes('--fake-hid');
const logFile = env.MONKA_LOG || path.join(os.homedir(), '.cache', 'monkey-wrench', 'bridge.log');
const token = env.MONKA_TOKEN || undefined;

try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch { /* ignore */ }
function log(...args) {
  const line = `${new Date().toISOString()} ${args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  process.stderr.write(line + '\n');
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
}

function notifyParent(msg) {
  if (process.parentPort) process.parentPort.postMessage(msg);
}

async function main() {
  fs.mkdirSync(userData, { recursive: true });
  let hid = null;
  try {
    const { createHidManager } = require('./hid/manager');
    hid = await createHidManager({ readOnly, fake, log });
    hid.onBattery((b) => notifyParent({ type: 'battery', state: b }));
  } catch (e) {
    log('HID manager unavailable:', e.message);
  }
  const service = createService({ userData, hid, readOnly, log });
  const server = createGrpcWebServer({ proto, handlers: service.handlers, log, token });
  try {
    await server.listen(PORT, '127.0.0.1');
  } catch (e) {
    log(`cannot listen on 127.0.0.1:${PORT}: ${e.message}`);
    notifyParent({ type: 'error', message: e.message });
    process.exit(2);
  }
  log(`bridge listening on 127.0.0.1:${server.port} readOnly=${readOnly} fakeHid=${fake} auth=${token ? 'token' : 'none'} userData=${userData}`);
  process.stdout.write(`listening ${server.port}\n`);
  notifyParent({ type: 'listening', port: server.port, readOnly, fake });

  const shutdown = async (why) => {
    log(`bridge shutting down (${why})`);
    try { await service.close(); } catch { /* ignore */ }
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  if (process.parentPort) {
    process.parentPort.on('message', (e) => { if (e.data && e.data.type === 'shutdown') shutdown('parent'); });
  }
}

main().catch((e) => { log('bridge fatal:', e); process.exit(1); });
