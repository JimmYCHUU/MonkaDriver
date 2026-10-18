'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const proto = require('../bridge/proto');
const { createGrpcWebServer, GrpcError } = require('../bridge/grpcweb');

// --- helpers mirroring what the grpc-web JS client does on the wire ---------
function frame(flag, payload) {
  const h = Buffer.alloc(5);
  h[0] = flag;
  h.writeUInt32BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}
// the grpc-web client decodes text responses in 4-char base64 groups, so padded
// frames may be concatenated; Node's Buffer.from(..,'base64') stops at '=' instead.
function b64groups(text) {
  const parts = [];
  for (let i = 0; i < text.length; i += 4) parts.push(Buffer.from(text.slice(i, i + 4), 'base64'));
  return Buffer.concat(parts);
}
function parseFrames(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const flag = buf[i];
    const len = buf.readUInt32BE(i + 1);
    out.push({ flag, payload: buf.subarray(i + 5, i + 5 + len) });
    i += 5 + len;
  }
  return out;
}

async function startServer(handlers) {
  const server = createGrpcWebServer({ proto, handlers });
  await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.port}`;
  return { server, base };
}

test('unary call in binary (+proto) mode returns response frame and OK trailer', async (t) => {
  const { server, base } = await startServer({
    getVersion: async () => ({ baseversion: '1.7.5', timestamp: '0' }),
  });
  t.after(() => server.close());
  const res = await fetch(`${base}/driver.DriverGrpc/getVersion`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: frame(0, proto.encode('Empty', {})),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/grpc-web+proto');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const frames = parseFrames(Buffer.from(await res.arrayBuffer()));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].flag, 0);
  assert.equal(proto.decode('Version', frames[0].payload).baseversion, '1.7.5');
  assert.equal(frames[1].flag, 0x80);
  assert.equal(frames[1].payload.toString(), 'grpc-status:0\r\n');
});

test('unary call in text mode: request and response are base64 per frame', async (t) => {
  const { server, base } = await startServer({
    readRawFeature: async (req) => {
      assert.equal(req.devicepath, '/dev/hidraw2');
      return { err: '', msg: Buffer.from([0xf1, 0x90, 0x07]) };
    },
  });
  t.after(() => server.close());
  const body = frame(0, proto.encode('ReadMsg', { devicepath: '/dev/hidraw2' })).toString('base64');
  const res = await fetch(`${base}/driver.DriverGrpc/readRawFeature`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web-text', 'x-grpc-web': '1', accept: 'application/grpc-web-text' },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/grpc-web-text+proto');
  const text = await res.text();
  // each frame is base64-encoded independently (padded), then concatenated
  const frames = parseFrames(Buffer.from(text, 'base64'));
  assert.equal(frames.length, 2);
  assert.equal(Buffer.from(proto.decode('ResRead', frames[0].payload).msg).toString('hex'), 'f19007');
  assert.equal(frames[1].payload.toString(), 'grpc-status:0\r\n');
  // the client decodes base64 in 4-char groups per frame: every frame must be a padded multiple of 4
  const f0 = frame(0, proto.encode('ResRead', { err: '', msg: Buffer.from([0xf1, 0x90, 0x07]) })).toString('base64');
  assert.ok(text.startsWith(f0));
});

test('handler errors become a non-zero grpc-status trailer with the message', async (t) => {
  const { server, base } = await startServer({
    sendRawFeature: async () => { throw new GrpcError(13, 'device is read-only'); },
  });
  t.after(() => server.close());
  const res = await fetch(`${base}/driver.DriverGrpc/sendRawFeature`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto' },
    body: frame(0, proto.encode('SendMsg', { devicepath: 'x', msg: Buffer.from([0x80]) })),
  });
  assert.equal(res.status, 200);
  const frames = parseFrames(Buffer.from(await res.arrayBuffer()));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].flag, 0x80);
  assert.equal(frames[0].payload.toString(), 'grpc-status:13\r\ngrpc-message:device%20is%20read-only\r\n');
});

test('unknown method yields grpc-status 12 (UNIMPLEMENTED)', async (t) => {
  const { server, base } = await startServer({});
  t.after(() => server.close());
  const res = await fetch(`${base}/driver.DriverGrpc/nope`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto' },
    body: frame(0, Buffer.alloc(0)),
  });
  const frames = parseFrames(Buffer.from(await res.arrayBuffer()));
  assert.match(frames[0].payload.toString(), /^grpc-status:12\r\n/);
});

test('CORS preflight allows the headers the grpc-web client sends', async (t) => {
  const { server, base } = await startServer({});
  t.after(() => server.close());
  const res = await fetch(`${base}/driver.DriverGrpc/getVersion`, {
    method: 'OPTIONS',
    headers: {
      origin: 'null',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-grpc-web,x-user-agent',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'null');
  const allowed = res.headers.get('access-control-allow-headers').toLowerCase();
  for (const h of ['content-type', 'x-grpc-web', 'x-user-agent', 'grpc-timeout']) assert.ok(allowed.includes(h), h);
  assert.ok(res.headers.get('access-control-expose-headers').toLowerCase().includes('grpc-status'));
});

test('server-streaming call in text mode delivers frames as they are written and ends with a trailer', async (t) => {
  let streamRef;
  const { server, base } = await startServer({
    watchDevList: (req, stream) => {
      streamRef = stream;
      stream.write({ devlist: [], type: proto.enums.DeviceListChangeType.INIT });
    },
  });
  t.after(() => server.close());
  const res = await fetch(`${base}/driver.DriverGrpc/watchDevList`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web-text', accept: 'application/grpc-web-text' },
    body: frame(0, proto.encode('Empty', {})).toString('base64'),
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  // first chunk: the INIT frame written synchronously by the handler
  const first = await reader.read();
  text += dec.decode(first.value);
  assert.equal(parseFrames(b64groups(text)).length, 1);
  streamRef.write({ devlist: [], type: proto.enums.DeviceListChangeType.ADD });
  const second = await reader.read();
  text += dec.decode(second.value);
  const frames = parseFrames(b64groups(text));
  assert.equal(frames.length, 2);
  assert.equal(proto.decode('DeviceList', frames[1].payload).type, 1);
  streamRef.end();
  let rest = '';
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    rest += dec.decode(r.value);
  }
  const all = parseFrames(b64groups(text + rest));
  assert.equal(all.at(-1).flag, 0x80);
  assert.equal(all.at(-1).payload.toString(), 'grpc-status:0\r\n');
});

test('stream handlers are told when the client goes away', async (t) => {
  let closed = false;
  const { server, base } = await startServer({
    watchVender: (req, stream) => { stream.onClose(() => { closed = true; }); },
  });
  t.after(() => server.close());
  const ac = new AbortController();
  const p = fetch(`${base}/driver.DriverGrpc/watchVender`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web-text' },
    body: frame(0, Buffer.alloc(0)).toString('base64'),
    signal: ac.signal,
  });
  const res = await p;
  const reader = res.body.getReader();
  ac.abort();
  await reader.read().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(closed, true);
});

test('requests from a web origin are refused; file:// (Origin: null) and no Origin are accepted', async (t) => {
  const { server, base } = await startServer({ getVersion: async () => ({ baseversion: '1', timestamp: '0' }) });
  t.after(() => server.close());
  const call = (headers) => fetch(`${base}/driver.DriverGrpc/getVersion`, {
    method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', ...headers }, body: frame(0, Buffer.alloc(0)),
  });
  assert.equal((await call({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await call({ origin: 'null' })).status, 200);
  assert.equal((await call({})).status, 200);
  const pre = await fetch(`${base}/driver.DriverGrpc/getVersion`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 403);
});

test('requests with a foreign Host header are refused (DNS rebinding)', async (t) => {
  const { server, base } = await startServer({ getVersion: async () => ({ baseversion: '1', timestamp: '0' }) });
  t.after(() => server.close());
  const http = require('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/driver.DriverGrpc/getVersion`, {
      method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', host: 'evil.example' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(frame(0, Buffer.alloc(0)));
  });
  assert.equal(status, 403);
});
