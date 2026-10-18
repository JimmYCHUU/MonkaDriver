'use strict';
// Minimal gRPC-web server (HTTP/1.1) compatible with the grpc-web JS client the
// vendor renderer uses in "text" mode (base64 frames) and with binary mode.
const http = require('node:http');
const crypto = require('node:crypto');

class GrpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const STATUS = { OK: 0, UNKNOWN: 2, INVALID_ARGUMENT: 3, NOT_FOUND: 5, UNIMPLEMENTED: 12, INTERNAL: 13, UNAVAILABLE: 14 };

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type,x-grpc-web,x-user-agent,grpc-timeout,authorization',
  'access-control-expose-headers': 'grpc-status,grpc-message,grpc-status-details-bin',
  'access-control-max-age': '86400',
};

function frame(flag, payload) {
  const h = Buffer.alloc(5);
  h[0] = flag;
  h.writeUInt32BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

function parseFrames(buf) {
  const out = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const flag = buf[i];
    const len = buf.readUInt32BE(i + 1);
    out.push({ flag, payload: buf.subarray(i + 5, i + 5 + len) });
    i += 5 + len;
  }
  return out;
}

function trailer(code, message) {
  let s = `grpc-status:${code}\r\n`;
  if (message) s += `grpc-message:${encodeURIComponent(message)}\r\n`;
  return frame(0x80, Buffer.from(s));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Only the bundled renderer (a file:// page → Origin "null") and non-browser
// clients (no Origin) may talk to the bridge; web pages are refused so a
// malicious site cannot drive the keyboard through the local port.
function originAllowed(origin) {
  return origin === undefined || origin === 'null' || origin.startsWith('file://');
}
function hostAllowed(host) {
  const h = String(host || '').replace(/:\d+$/, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '';
}

function tokenMatches(header, token) {
  const m = /^Bearer\s+(.+)$/.exec(String(header || ''));
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// `token`: per-launch secret; when set, every non-preflight request must carry
// `Authorization: Bearer <token>` (Electron injects it into the renderer's requests).
function createGrpcWebServer({ proto, handlers, log = () => {}, token } = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('grpcweb: unexpected error', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(req, res) {
    const origin = req.headers.origin;
    if (!originAllowed(origin) || !hostAllowed(req.headers.host)) {
      log(`grpcweb: refused request from origin=${origin} host=${req.headers.host}`);
      res.writeHead(403);
      res.end();
      return;
    }
    const cors = origin === undefined ? CORS_HEADERS : { ...CORS_HEADERS, 'access-control-allow-origin': origin };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (token && !tokenMatches(req.headers.authorization, token)) {
      log('grpcweb: refused request without a valid bridge token');
      res.writeHead(401, cors);
      res.end();
      return;
    }
    const m = /^\/driver\.DriverGrpc\/(\w+)$/.exec(req.url || '');
    if (req.method !== 'POST' || !m) {
      res.writeHead(404, cors);
      res.end();
      return;
    }
    const name = m[1];
    const ctype = String(req.headers['content-type'] || '');
    const text = ctype.includes('grpc-web-text');
    const encodeOut = (buf) => (text ? Buffer.from(buf.toString('base64')) : buf);
    const headers = {
      ...cors,
      'content-type': text ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto',
      'cache-control': 'no-cache',
    };

    const raw = await readBody(req);
    const body = text ? Buffer.from(raw.toString('latin1'), 'base64') : raw;
    const frames = parseFrames(body);

    const spec = proto.methods[name];
    const handler = handlers[name];
    if (!spec || !handler) {
      res.writeHead(200, headers);
      res.end(encodeOut(trailer(STATUS.UNIMPLEMENTED, `method ${name} not implemented`)));
      return;
    }
    let request;
    try {
      const data = frames.find((f) => (f.flag & 0x80) === 0);
      request = proto.decode(spec.request, data ? data.payload : Buffer.alloc(0));
    } catch (e) {
      res.writeHead(200, headers);
      res.end(encodeOut(trailer(STATUS.INVALID_ARGUMENT, `bad request: ${e.message}`)));
      return;
    }

    if (!spec.stream) {
      let out;
      try {
        const result = await handler(request);
        out = Buffer.concat([frame(0, proto.encode(spec.response, result || {})), trailer(STATUS.OK)]);
      } catch (e) {
        const code = e instanceof GrpcError ? e.code : STATUS.UNKNOWN;
        log(`grpcweb: ${name} failed: ${e.message}`);
        out = trailer(code, e.message || String(e));
      }
      res.writeHead(200, headers);
      res.end(encodeOut(out));
      return;
    }

    // server streaming: each frame is its own chunk; in text mode each chunk is
    // base64-encoded independently (a padded multiple of 4 chars), which is what
    // the grpc-web client's incremental decoder expects.
    res.writeHead(200, headers);
    res.flushHeaders();
    let open = true;
    const closeCbs = [];
    const finish = () => {
      if (!open) return;
      open = false;
      for (const cb of closeCbs) { try { cb(); } catch (e) { log('grpcweb: onClose error', e); } }
    };
    req.on('close', () => finish());
    res.on('close', () => finish());
    const stream = {
      write(obj) {
        if (!open) return false;
        res.write(encodeOut(frame(0, proto.encode(spec.response, obj))));
        return true;
      },
      end(err) {
        if (!open) return;
        const code = err ? (err instanceof GrpcError ? err.code : STATUS.UNKNOWN) : STATUS.OK;
        res.end(encodeOut(trailer(code, err ? err.message : undefined)));
        finish();
      },
      onClose(cb) { closeCbs.push(cb); },
      get open() { return open; },
    };
    try {
      await handler(request, stream);
    } catch (e) {
      log(`grpcweb: stream ${name} failed: ${e.message}`);
      stream.end(e);
    }
  }

  return {
    get port() { return server.address() && server.address().port; },
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
    },
    close() {
      return new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    },
  };
}

module.exports = { createGrpcWebServer, GrpcError, STATUS, frame, parseFrames, trailer, originAllowed, hostAllowed, tokenMatches };
