'use strict';
// Settings and autostart carried over from the app's former name (Monka Driver).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateFromMonkaDriver } = require('../migrate');

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-home-'));
  const configHome = path.join(h, '.config');
  return { configHome, oldUserData: path.join(configHome, 'Monka Driver'), newUserData: path.join(configHome, 'Monkey Wrench') };
}

test('copies the old settings store when the new one does not exist, leaving the old one in place', () => {
  const p = home();
  fs.mkdirSync(path.join(p.oldUserData, 'iot_db'), { recursive: true });
  fs.writeFileSync(path.join(p.oldUserData, 'iot_db', 'CONFIG.json'), '[["a","b"]]');
  const r = migrateFromMonkaDriver(p);
  assert.equal(r.settings, 'copied');
  assert.equal(fs.readFileSync(path.join(p.newUserData, 'iot_db', 'CONFIG.json'), 'utf8'), '[["a","b"]]');
  assert.ok(fs.existsSync(path.join(p.oldUserData, 'iot_db', 'CONFIG.json')), 'old copy kept for rollback');
});

test('never overwrites settings already present under the new name', () => {
  const p = home();
  fs.mkdirSync(path.join(p.oldUserData, 'iot_db'), { recursive: true });
  fs.writeFileSync(path.join(p.oldUserData, 'iot_db', 'CONFIG.json'), 'old');
  fs.mkdirSync(path.join(p.newUserData, 'iot_db'), { recursive: true });
  fs.writeFileSync(path.join(p.newUserData, 'iot_db', 'CONFIG.json'), 'new');
  assert.equal(migrateFromMonkaDriver(p).settings, 'kept');
  assert.equal(fs.readFileSync(path.join(p.newUserData, 'iot_db', 'CONFIG.json'), 'utf8'), 'new');
});

test('nothing to do on a fresh install', () => {
  const p = home();
  assert.deepEqual(migrateFromMonkaDriver(p), { settings: 'none', autostart: 'none' });
});

test('an old autostart entry is replaced by one for the new name', () => {
  const p = home();
  const auto = path.join(p.configHome, 'autostart');
  fs.mkdirSync(auto, { recursive: true });
  fs.writeFileSync(path.join(auto, 'monka-driver.desktop'), '[Desktop Entry]\nExec=/usr/bin/monka-driver --hidden\n');
  let enabledWith;
  const r = migrateFromMonkaDriver({ ...p, enableAutostart: () => { enabledWith = true; } });
  assert.equal(r.autostart, 'moved');
  assert.equal(enabledWith, true);
  assert.equal(fs.existsSync(path.join(auto, 'monka-driver.desktop')), false);
});
