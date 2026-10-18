'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Autostart, resolveExec } = require('../autostart');

test('enabling writes an XDG autostart entry that launches hidden; disabling removes it', () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'monka-xdg-'));
  const a = new Autostart({ configHome, exec: '/usr/bin/monkey-wrench', name: 'Monkey Wrench', icon: 'monkey-wrench' });
  assert.equal(a.isEnabled(), false);
  a.setEnabled(true);
  const file = path.join(configHome, 'autostart', 'monkey-wrench.desktop');
  assert.ok(fs.existsSync(file));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^\[Desktop Entry\]/);
  assert.match(text, /^Exec=\/usr\/bin\/monkey-wrench --hidden$/m);
  assert.match(text, /^Type=Application$/m);
  assert.match(text, /^X-GNOME-Autostart-enabled=true$/m);
  assert.equal(a.isEnabled(), true);
  a.setEnabled(false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(a.isEnabled(), false);
});

test('exec paths with spaces are quoted', () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'monka-xdg-'));
  const a = new Autostart({ configHome, exec: '/opt/Monkey Wrench/monkey-wrench', name: 'Monkey Wrench' });
  a.setEnabled(true);
  const text = fs.readFileSync(path.join(configHome, 'autostart', 'monkey-wrench.desktop'), 'utf8');
  assert.match(text, /^Exec="\/opt\/Monkey Wrench\/monkey-wrench" --hidden$/m);
});

test('resolveExec uses the system launcher when installed, else electron + app dir for dev runs', () => {
  assert.equal(resolveExec({ launcher: '/usr/bin/monkey-wrench', launcherExists: true, packaged: true, execPath: '/opt/monkey-wrench/monkey-wrench', appDir: '/opt/monkey-wrench/resources/app' }), '/usr/bin/monkey-wrench');
  assert.equal(resolveExec({ launcher: '/usr/bin/monkey-wrench', launcherExists: false, packaged: true, execPath: '/opt/x/monkey-wrench', appDir: '/opt/x/resources/app' }), '/opt/x/monkey-wrench');
  assert.equal(resolveExec({ launcher: '/usr/bin/monkey-wrench', launcherExists: false, packaged: false, execPath: '/p/node_modules/electron/dist/electron', appDir: '/p' }), '"/p/node_modules/electron/dist/electron" "/p"');
});
