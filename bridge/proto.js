'use strict';
// Protobuf codec for the driver.DriverGrpc service (schema in driver.proto).
const path = require('node:path');
const protobuf = require('protobufjs');

const root = protobuf.loadSync(path.join(__dirname, 'driver.proto'));
const pkg = root.lookup('driver');

const types = {};
const enums = {};
for (const nested of pkg.nestedArray) {
  if (nested instanceof protobuf.Type) types[nested.name] = nested;
  else if (nested instanceof protobuf.Enum) enums[nested.name] = Object.freeze({ ...nested.values });
}

const service = root.lookupService('driver.DriverGrpc');
const methods = {};
for (const m of service.methodsArray) {
  methods[m.name] = Object.freeze({
    request: m.requestType,
    response: m.responseType,
    stream: Boolean(m.responseStream),
  });
}

const TO_OBJECT = { defaults: true, longs: Number, enums: Number, oneofs: true, arrays: true };

function type(name) {
  const t = types[name];
  if (!t) throw new Error(`unknown message type driver.${name}`);
  return t;
}

function toBuffers(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) obj[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    else if (Array.isArray(v)) obj[k] = v.map((e) => (e instanceof Uint8Array && !Buffer.isBuffer(e) ? Buffer.from(e) : (e && typeof e === 'object' ? toBuffers(e) : e)));
    else if (v && typeof v === 'object' && !Buffer.isBuffer(v)) toBuffers(v);
  }
  return obj;
}

function encode(name, obj) {
  const t = type(name);
  const err = t.verify(obj);
  if (err) throw new Error(`driver.${name}: ${err}`);
  const out = t.encode(t.fromObject(obj)).finish();
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

function decode(name, buf) {
  const t = type(name);
  const msg = t.decode(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  return toBuffers(t.toObject(msg, TO_OBJECT));
}

module.exports = { encode, decode, methods, enums, types: Object.keys(types) };
