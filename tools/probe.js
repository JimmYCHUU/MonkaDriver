#!/usr/bin/env node
'use strict';
// Developer probe for the bridge (gRPC-web text mode, like the renderer).
//   node tools/probe.js devlist            # print the first DeviceList events
//   node tools/probe.js read <path> <cmdhex> [cs]   # sendMsg + readMsg of a GET command (read-only)
//   node tools/probe.js raw <path> <cmdhex> [cs]    # sendRawFeature + readRawFeature
//   node tools/probe.js version
// Env: MONKA_PORT (3814), MONKA_TOKEN (bearer token when the bridge requires one)
const proto = require('../bridge/proto');
const { frame, parseFrames } = require('../bridge/grpcweb');

const port = process.env.MONKA_PORT || 3814;
const base = `http://127.0.0.1:${port}/driver.DriverGrpc/`;
const headers = { 'content-type': 'application/grpc-web-text', accept: 'application/grpc-web-text', 'x-grpc-web': '1' };
if (process.env.MONKA_TOKEN) headers.authorization = `Bearer ${process.env.MONKA_TOKEN}`;

function b64groups(text) {
  const parts = [];
  for (let i = 0; i < text.length; i += 4) parts.push(Buffer.from(text.slice(i, i + 4), 'base64'));
  return Buffer.concat(parts);
}

async function unary(method, reqType, resType, req) {
  const res = await fetch(base + method, { method: 'POST', headers, body: frame(0, proto.encode(reqType, req)).toString('base64') });
  if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status}`);
  const frames = parseFrames(b64groups(await res.text()));
  const trailer = frames.find((f) => f.flag & 0x80);
  const data = frames.find((f) => !(f.flag & 0x80));
  const status = /grpc-status:(\d+)/.exec(trailer ? trailer.payload.toString() : '');
  if (!status || status[1] !== '0') throw new Error(`${method}: ${trailer ? trailer.payload.toString().trim() : 'no trailer'}`);
  return proto.decode(resType, data.payload);
}

async function stream(method, resType, onMsg, maxMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), maxMs);
  const res = await fetch(base + method, { method: 'POST', headers, body: frame(0, proto.encode('Empty', {})).toString('base64'), signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let seen = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      text += dec.decode(r.value);
      const frames = parseFrames(b64groups(text));
      for (; seen < frames.length; seen++) {
        const f = frames[seen];
        if (f.flag & 0x80) { console.log('trailer:', f.payload.toString().trim()); break; }
        if (onMsg(proto.decode(resType, f.payload)) === false) { ac.abort(); clearTimeout(t); return; }
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  clearTimeout(t);
}

const hex = (b) => Buffer.from(b).toString('hex');

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'version') {
    console.log(await unary('getVersion', 'Empty', 'Version', {}));
  } else if (cmd === 'devlist') {
    let n = 0;
    await stream('watchDevList', 'DeviceList', (m) => {
      console.log(JSON.stringify(m, (k, v) => (typeof v === 'number' && k.endsWith('Id') ? '0x' + v.toString(16) : v), 1));
      return ++n < 2;
    });
  } else if (cmd === 'read' || cmd === 'raw') {
    const path = a;
    const msg = Buffer.from(b, 'hex');
    const cs = c === undefined ? 0 : Number(c);
    const send = cmd === 'raw' ? 'sendRawFeature' : 'sendMsg';
    const read = cmd === 'raw' ? 'readRawFeature' : 'readMsg';
    const s = await unary(send, 'SendMsg', 'ResSend', { devicepath: path, msg, checksumtype: cs, dangledevtype: 1 });
    console.log(send, s);
    await new Promise((r) => setTimeout(r, 30));
    const r = await unary(read, 'ReadMsg', 'ResRead', { devicepath: path });
    console.log(read, r.err || 'ok', hex(r.msg));
  } else {
    console.error('usage: probe.js version | devlist | read <path> <cmdhex> [cs] | raw <path> <cmdhex> [cs]');
    process.exit(2);
  }
}
main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
