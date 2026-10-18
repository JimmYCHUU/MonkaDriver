'use strict';
// Byte-keyed key/value store standing in for the helper's sled databases.
// One JSON file per dbpath (`<dbpath>.json`), entries kept in insertion order.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

class KvStore {
  // `root`: when given, every dbpath must resolve inside it (the renderer passes
  // absolute paths under Electron's userData directory).
  constructor({ root } = {}) {
    this.root = root ? path.resolve(root) : undefined;
    this._dbs = new Map(); // dbpath -> Map(keyBase64 -> valueBase64)
    this._writing = new Map(); // dbpath -> Promise chain
  }

  _check(dbpath) {
    const r = path.resolve(String(dbpath));
    if (this.root && r !== this.root && !r.startsWith(this.root + path.sep)) {
      throw new Error(`dbpath ${dbpath} is outside the storage root`);
    }
    return r;
  }

  _file(dbpath) { return `${dbpath}.json`; }

  async _load(dbpath) {
    dbpath = this._check(dbpath);
    let db = this._dbs.get(dbpath);
    if (db) return db;
    db = new Map();
    try {
      const entries = JSON.parse(await fsp.readFile(this._file(dbpath), 'utf8'));
      for (const [k, v] of entries) db.set(k, v);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    this._dbs.set(dbpath, db);
    return db;
  }

  _save(dbpath, db) {
    const file = this._file(dbpath);
    const run = async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify([...db.entries()]));
      await fsp.rename(tmp, file);
    };
    const chain = (this._writing.get(dbpath) || Promise.resolve()).then(run, run);
    this._writing.set(dbpath, chain);
    return chain;
  }

  async insert(dbpath, key, value) {
    dbpath = this._check(dbpath);
    const db = await this._load(dbpath);
    db.set(Buffer.from(key).toString('base64'), Buffer.from(value).toString('base64'));
    await this._save(dbpath, db);
  }

  async get(dbpath, key) {
    const db = await this._load(dbpath);
    const v = db.get(Buffer.from(key).toString('base64'));
    return v === undefined ? undefined : Buffer.from(v, 'base64');
  }

  async delete(dbpath, key) {
    dbpath = this._check(dbpath);
    const db = await this._load(dbpath);
    const existed = db.delete(Buffer.from(key).toString('base64'));
    if (existed) await this._save(dbpath, db);
    return existed;
  }

  async keys(dbpath) {
    const db = await this._load(dbpath);
    return [...db.keys()].map((k) => Buffer.from(k, 'base64'));
  }

  async values(dbpath) {
    const db = await this._load(dbpath);
    return [...db.values()].map((v) => Buffer.from(v, 'base64'));
  }

  static existsSync(dbpath) { return fs.existsSync(`${dbpath}.json`); }
}

module.exports = { KvStore };
