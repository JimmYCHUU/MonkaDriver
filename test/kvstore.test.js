'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KvStore } = require('../bridge/kvstore');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monka-kv-'));
}

test('insert then get returns the same bytes; missing key returns undefined', async () => {
  const kv = new KvStore();
  const dbpath = path.join(tmpdir(), 'iot_db', 'CONFIG');
  await kv.insert(dbpath, Buffer.from('"k1"'), Buffer.from('v1'));
  assert.equal((await kv.get(dbpath, Buffer.from('"k1"'))).toString(), 'v1');
  assert.equal(await kv.get(dbpath, Buffer.from('"nope"')), undefined);
});

test('data persists on disk and is reloaded by a fresh store', async () => {
  const kv = new KvStore();
  const dbpath = path.join(tmpdir(), 'iot_db', 'macro');
  await kv.insert(dbpath, Buffer.from([1, 2]), Buffer.from([0xff, 0]));
  const kv2 = new KvStore();
  assert.equal((await kv2.get(dbpath, Buffer.from([1, 2]))).toString('hex'), 'ff00');
  assert.ok(fs.existsSync(dbpath + '.json'));
});

test('keys and values list in insertion order; delete removes an entry', async () => {
  const kv = new KvStore();
  const dbpath = path.join(tmpdir(), 'iot_db', 'user');
  await kv.insert(dbpath, Buffer.from('b'), Buffer.from('2'));
  await kv.insert(dbpath, Buffer.from('a'), Buffer.from('1'));
  assert.deepEqual((await kv.keys(dbpath)).map(String), ['b', 'a']);
  assert.deepEqual((await kv.values(dbpath)).map(String), ['2', '1']);
  await kv.delete(dbpath, Buffer.from('b'));
  assert.deepEqual((await kv.keys(dbpath)).map(String), ['a']);
  assert.deepEqual(await kv.keys(path.join(tmpdir(), 'iot_db', 'empty')), []);
});

test('overwriting a key keeps a single entry', async () => {
  const kv = new KvStore();
  const dbpath = path.join(tmpdir(), 'iot_db', 'screen');
  await kv.insert(dbpath, Buffer.from('k'), Buffer.from('1'));
  await kv.insert(dbpath, Buffer.from('k'), Buffer.from('2'));
  assert.deepEqual((await kv.values(dbpath)).map(String), ['2']);
});

test('a store with a root refuses dbpaths outside it', async () => {
  const root = tmpdir();
  const kv = new KvStore({ root });
  await kv.insert(path.join(root, 'iot_db', 'ok'), Buffer.from('k'), Buffer.from('v'));
  await assert.rejects(kv.insert(path.join(root, '..', 'escape'), Buffer.from('k'), Buffer.from('v')), /outside/);
  await assert.rejects(kv.get('/etc/passwd', Buffer.from('k')), /outside/);
  await assert.rejects(kv.keys(path.join(root, 'iot_db', '..', '..', 'x')), /outside/);
});
