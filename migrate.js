'use strict';
// One-time carry-over from the app's former name, "Monka Driver": the settings
// store is copied (the old one is kept so a rollback still works) and an old
// autostart entry is replaced by one for the new name.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function migrateFromMonkaDriver({
  configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  oldUserData = path.join(configHome, 'Monka Driver'),
  newUserData,
  enableAutostart = () => {},
} = {}) {
  const result = { settings: 'none', autostart: 'none' };

  const oldDb = path.join(oldUserData, 'iot_db');
  const newDb = path.join(newUserData, 'iot_db');
  if (fs.existsSync(newDb)) result.settings = 'kept';
  else if (fs.existsSync(oldDb)) {
    fs.mkdirSync(newUserData, { recursive: true });
    fs.cpSync(oldDb, newDb, { recursive: true });
    result.settings = 'copied';
  }

  const oldAuto = path.join(configHome, 'autostart', 'monka-driver.desktop');
  if (fs.existsSync(oldAuto)) {
    enableAutostart();
    fs.unlinkSync(oldAuto);
    result.autostart = 'moved';
  }
  return result;
}

module.exports = { migrateFromMonkaDriver };
