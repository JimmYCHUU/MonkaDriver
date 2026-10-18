'use strict';
// XDG autostart entry management (Electron's setLoginItemSettings is mac/win only).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function quoteExec(p) {
  return /[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

// Command used by the autostart entry: the system launcher when installed, the
// packaged binary otherwise, and `electron <appdir>` for runs from source.
function resolveExec({ launcher = '/usr/bin/monkey-wrench', launcherExists = fs.existsSync(launcher), packaged, execPath, appDir }) {
  if (launcherExists) return launcher;
  if (packaged) return execPath;
  const q = (x) => `"${String(x).replace(/"/g, '\\"')}"`;
  return `${q(execPath)} ${q(appDir)}`;
}

class Autostart {
  constructor({ configHome, exec, name = 'Monkey Wrench', icon = 'monkey-wrench', id = 'monkey-wrench' } = {}) {
    this.configHome = configHome || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    this.exec = exec;
    this.name = name;
    this.icon = icon;
    this.file = path.join(this.configHome, 'autostart', `${id}.desktop`);
  }

  isEnabled() {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      return !/^Hidden=true$/m.test(text) && !/^X-GNOME-Autostart-enabled=false$/m.test(text);
    } catch {
      return false;
    }
  }

  setEnabled(enabled) {
    if (!enabled) {
      try { fs.unlinkSync(this.file); } catch { /* already absent */ }
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const text = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${this.name}`,
      `Exec=${this.exec.startsWith('"') ? this.exec : quoteExec(this.exec)} --hidden`,
      `Icon=${this.icon}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      'X-KDE-autostart-after=panel',
      '',
    ].join('\n');
    fs.writeFileSync(this.file, text);
  }
}

module.exports = { Autostart, quoteExec, resolveExec };
