'use strict';
// Electron main process: a Linux port of the vendor's main_dist/main.js.
// Hosts the HID bridge in a utilityProcess, then shows the vendor renderer.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, session, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const remote = require('@electron/remote/main');
const { Autostart, resolveExec } = require('./autostart');

const BASE_W = 1200;
const BASE_H = 788;
const COMPANY = require('./CurrentCompany.json').currentCompany;
const companyDir = path.join(__dirname, 'company', `company_${COMPANY}`);
const BRIDGE_PORT = Number(process.env.MONKA_PORT || 3814);
const startHidden = process.argv.includes('--hidden');
// per-launch secret shared with the bridge; injected into the renderer's requests
const BRIDGE_TOKEN = crypto.randomBytes(24).toString('hex');

app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // another instance is running and has been asked to show itself
  app.quit();
  setTimeout(() => app.exit(0), 2000);
} else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

remote.initialize();

let mainWindow = null;
let tray;
let quitting = false;
let bridge = null;
let bridgeRestarts = 0;

const autostart = new Autostart({
  exec: resolveExec({ packaged: app.isPackaged, execPath: process.execPath, appDir: __dirname }),
  name: 'Monka Driver',
  icon: 'monka-driver',
});

function log(...a) { console.log('[main]', ...a); }

// ---------------------------------------------------------------- bridge ----
function startBridge() {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      MONKA_USERDATA: app.getPath('userData'),
      MONKA_PORT: String(BRIDGE_PORT),
      MONKA_LOG: path.join(app.getPath('logs'), 'bridge.log'),
      MONKA_TOKEN: BRIDGE_TOKEN,
    };
    // development runs never write to the keyboard; the installed app does (the user drives it)
    if (process.env.MONKA_READ_ONLY === undefined) env.MONKA_READ_ONLY = app.isPackaged ? '0' : '1';
    bridge = utilityProcess.fork(path.join(__dirname, 'bridge', 'main.js'), [], {
      serviceName: 'monka-hid-bridge',
      stdio: 'inherit',
      env,
    });
    let settled = false;
    bridge.on('message', (msg) => {
      if (msg && msg.type === 'listening' && !settled) { settled = true; log(`bridge listening on ${msg.port} (readOnly=${msg.readOnly}, fake=${msg.fake})`); resolve(true); }
      if (msg && msg.type === 'error' && !settled) { settled = true; resolve(false); }
    });
    bridge.on('exit', (code) => {
      log(`bridge exited with code ${code}`);
      bridge = null;
      if (!settled) { settled = true; resolve(false); }
      if (quitting) return;
      if (code === 2) { // port in use: another bridge/app instance owns 127.0.0.1:3814; restarting would loop
        log(`bridge port ${BRIDGE_PORT} is in use by another process; not restarting the bridge`);
        return;
      }
      const delay = Math.min(10000, 500 * 2 ** Math.min(bridgeRestarts++, 5));
      setTimeout(() => { if (!quitting) startBridge(); }, delay);
    });
    // never block the UI forever on a wedged device: the renderer retries on its own
    setTimeout(() => { if (!settled) { settled = true; log('bridge did not report within 10 s; showing the window anyway'); resolve(false); } }, 10000);
  });
}

function stopBridge() {
  if (!bridge) return;
  try { bridge.postMessage({ type: 'shutdown' }); } catch { /* ignore */ }
  const b = bridge;
  setTimeout(() => { try { b.kill(); } catch { /* ignore */ } }, 1500);
}

// ---------------------------------------------------------------- window ----
function createWindow() {
  const size = screen.getPrimaryDisplay().size;
  const h = Math.round(size.height * 0.8);
  const r = h / BASE_H;
  const ratio = r > 1 ? 1 : r;
  mainWindow = new BrowserWindow({
    transparent: true,
    width: Math.round(BASE_W * ratio),
    height: Math.round(BASE_H * ratio),
    backgroundColor: '#00000000',
    center: true,
    frame: false,
    resizable: false,
    fullscreenable: false,
    show: false,
    icon: path.join(companyDir, 'icon.png'),
    title: 'Monka Driver',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  remote.enable(mainWindow.webContents);

  // authenticate the renderer's bridge calls
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${BRIDGE_PORT}/*`] }, (details, cb) => {
    cb({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${BRIDGE_TOKEN}` } });
  });

  if (!app.isPackaged) {
    // Development: keep the vendor bundle from reaching its update/analytics
    // endpoints (it rewrites its own JS bundle when a newer version exists).
    const allowed = (url) => url.startsWith(`http://127.0.0.1:${BRIDGE_PORT}/`) || url.startsWith('file://') || url.startsWith('devtools://') || url.startsWith('data:') || url.startsWith('blob:');
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => cb({ cancel: !allowed(details.url) }));
    if (process.env.MONKA_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));

  mainWindow.on('hide', () => mainWindow && mainWindow.webContents.send('hide', true));
  mainWindow.on('show', () => mainWindow && mainWindow.webContents.send('show', true));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.webContents.send('ready-to-show', true);
    if (!startHidden) mainWindow.show();
    if (process.env.MONKA_SCREENSHOT) {
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(process.env.MONKA_SCREENSHOT, img.toPNG());
          log(`screenshot written to ${process.env.MONKA_SCREENSHOT}`);
        } catch (e) { log('screenshot failed', e); }
      }, Number(process.env.MONKA_SCREENSHOT_DELAY || 6000));
    }
  });
  mainWindow.webContents.on('render-process-gone', (e, details) => log('renderer gone:', details.reason));
}

// ------------------------------------------------------------------ tray ----
const menuItems = [
  { label: '显示', click: () => { if (!mainWindow) return; mainWindow.webContents.send('shows', true); mainWindow.show(); } },
  { label: '隐藏', click: () => { if (!mainWindow) return; mainWindow.webContents.send('hides', true); mainWindow.hide(); } },
  {
    label: '退出',
    click: () => {
      if (mainWindow) mainWindow.webContents.send('exit', true);
      // the renderer normally quits after cleanup; make sure we always exit
      setTimeout(() => { quitting = true; app.quit(); }, 1500);
    },
  },
];

function buildTrayMenu() {
  const items = menuItems.map((m) => ({ ...m }));
  items.splice(2, 0, { type: 'separator' });
  return Menu.buildFromTemplate(items);
}

function addTray() {
  if (tray) return;
  let image = nativeImage.createFromPath(path.join(companyDir, 'APP.png'));
  if (!image.isEmpty()) image = image.resize({ width: 22, height: 22 });
  tray = new Tray(image);
  tray.setToolTip('Monka Driver');
  tray.on('click', () => { if (mainWindow) mainWindow.show(); });
  tray.setContextMenu(buildTrayMenu());
}

// ------------------------------------------------------------------- ipc ----
ipcMain.on('international', (_, labels) => {
  if (!tray || !Array.isArray(labels)) return;
  labels.forEach((v, i) => { if (menuItems[i]) menuItems[i].label = v; });
  tray.setContextMenu(buildTrayMenu());
});
ipcMain.on('getOpenAtLogin', () => {
  if (mainWindow) mainWindow.webContents.send('getOpenAtLogin', autostart.isEnabled());
});
ipcMain.on('setOpenAtLogin', (_, enabled) => {
  try { autostart.setEnabled(Boolean(enabled)); } catch (e) { log('autostart failed', e); }
});
ipcMain.on('getScaleFactor', (e) => {
  e.returnValue = screen.getPrimaryDisplay().scaleFactor;
});

// ------------------------------------------------------------------- app ----
app.on('ready', async () => {
  Menu.setApplicationMenu(null);
  addTray();
  const ok = await startBridge();
  if (!ok) log('bridge did not start; the UI will keep retrying its connection');
  createWindow();
});
app.on('window-all-closed', () => { quitting = true; app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });
app.on('before-quit', () => { quitting = true; stopBridge(); });
