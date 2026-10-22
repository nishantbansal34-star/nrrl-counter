// NRRL Billing — Electron main process: window, database, printing, backups
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const { createSync } = require('./sync');
const { createLink } = require('./link');
const path = require('path');
const fs = require('fs');
const { Store } = require('./db');
const P = require('./print');
const { makeHandlers, WRITES } = require('./handlers');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, store = null, dirty = false, quitting = false;
const sync = createSync(() => store);
const link = createLink(() => store, changes => { if (win && !win.isDestroyed()) win.webContents.send('data-changed', changes); });
const dataDir = () => path.join(app.getPath('documents'), 'NRRL Billing');
const backupDir = () => path.join(dataDir(), 'Backups');
const dbFile = () => path.join(dataDir(), 'nrrl-billing.db');

const p2 = n => String(n).padStart(2, '0');
function stamp(d = new Date()) { return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`; }
const BACKUP_RE = /^nrrl-backup_.*\.db$/;

function prune(dir, keep = 60) {
  try {
    const f = fs.readdirSync(dir).filter(n => BACKUP_RE.test(n)).sort();
    while (f.length > keep) { try { fs.unlinkSync(path.join(dir, f.shift())); } catch (e) {} }
  } catch (e) {}
}
let backingUp = null;
async function backupNow(reason) {
  if (backingUp) return backingUp;
  backingUp = (async () => {
    fs.mkdirSync(backupDir(), { recursive: true });
    const name = `nrrl-backup_${stamp()}${reason === 'before-restore' ? '_before-restore' : ''}.db`;
    const dest = path.join(backupDir(), name);
    await store.db.backup(dest);
    prune(backupDir());
    let extraOk = null; const extra = store.getSetting('backup_extra');
    if (extra) {
      try { fs.mkdirSync(extra, { recursive: true }); fs.copyFileSync(dest, path.join(extra, name)); prune(extra); extraOk = true; }
      catch (e) { extraOk = false; }
    }
    dirty = false;
    store.setSetting('last_backup', new Date().toISOString());
    return { file: dest, extraOk, at: new Date().toISOString() };
  })();
  try { return await backingUp; } finally { backingUp = null; }
}
function backupList() {
  try {
    return fs.readdirSync(backupDir()).filter(n => BACKUP_RE.test(n)).sort().reverse().slice(0, 60)
      .map(n => { const s = fs.statSync(path.join(backupDir(), n)); return { name: n, size: s.size, at: s.mtime.toISOString() }; });
  } catch (e) { return []; }
}
async function restore() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a backup to restore', defaultPath: backupDir(),
    filters: [{ name: 'NRRL Billing backup', extensions: ['db'] }], properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return false;
  const src = r.filePaths[0];
  try { Store.validate(src); } catch (e) { throw new Error('That file is not an NRRL Billing backup.'); }
  await backupNow('before-restore');
  const tmp = dbFile() + '.restoring';
  fs.copyFileSync(src, tmp);
  store.close();
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dbFile() + ext); } catch (e) {} }
  fs.renameSync(tmp, dbFile());
  store = new Store(dbFile());
  dirty = false;
  return true;
}

function listPrinters() {
  return win.webContents.getPrintersAsync().then(list => list.map(p => ({ name: p.name, label: p.displayName || p.name, isDefault: !!p.isDefault })));
}

async function saveText(defName, text) {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), defName), filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, '﻿' + text, 'utf8');
  shell.showItemInFolder(r.filePath);
  return r.filePath;
}
async function openText() {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your item list', filters: [{ name: 'CSV file', extensions: ['csv', 'txt'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return fs.readFileSync(r.filePaths[0], 'utf8').replace(/^﻿/, '');
}
async function chooseExtraFolder() {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a second backup folder (pen drive, Google Drive, OneDrive…)', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  store.setSetting('backup_extra', r.filePaths[0]);
  return r.filePaths[0];
}

function setupIPC() {
  const H = makeHandlers({
    getStore: () => store,
    info: () => ({ dataDir: dataDir(), dbFile: dbFile(), backupDir: backupDir(), version: app.getVersion(), lastBackup: store.getSetting('last_backup') }),
    openDataFolder: () => shell.openPath(dataDir()),
    openBackupFolder: () => shell.openPath(backupDir()),
    printReceipt: P.printReceipt,
    printLabels: P.printLabels,
    listPrinters, backupNow, backupList, restore, saveText, openText, chooseExtraFolder,
    sync, link, progress: msg => { if (win && !win.isDestroyed()) win.webContents.send('link-progress', msg); },
    copy: text => { clipboard.writeText(String(text)); return true; },
    openUrl: url => { shell.openExternal(url); return true; },
    printA4: P.printA4,
    billPdf: async (b, s) => {
      const dir = path.join(dataDir(), 'Bill PDFs'); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `Bill-${String(b.bill_no).replace(/[^\w-]+/g, '_')}.pdf`);
      if (s.pdf_format === 'thermal') return P.billPDF(P.receiptHTML(b, s, {}), file, { receiptWidthMm: s.paper === '58' ? 58 : 80 });
      return P.billPDF(P.a4HTML(b, s, {}), file);
    },
    // a real "copied file" on the Windows clipboard, so Ctrl+V in a WhatsApp chat attaches the PDF
    copyFile: file => new Promise(resolve => {
      if (process.platform !== 'win32') return resolve(false);
      require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath $env:NRRL_FILE'],
        { env: { ...process.env, NRRL_FILE: file }, windowsHide: true, timeout: 15000 }, err => resolve(!err));
    }),
    openWhatsApp: async (phone, text, mode) => {
      const q = (phone ? 'phone=' + phone + '&' : '') + 'text=' + encodeURIComponent(text);
      if (mode !== 'web') { try { await shell.openExternal('whatsapp://send?' + q); return; } catch (e) {} }
      await shell.openExternal('https://web.whatsapp.com/send?' + q);
    },
    showFile: file => { shell.showItemInFolder(file); return true; },
  });
  ipcMain.handle('rpc', async (e, method, args) => {
    const fn = H[method];
    if (!fn) return { ok: false, error: 'Unknown action: ' + method };
    try {
      const data = await fn(...(Array.isArray(args) ? args : []));
      if (WRITES.has(method)) { dirty = true; if (method.startsWith('items.')) store.setSetting('items_dirty', '1'); sync.soon(); link.soon(); }
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 820, minWidth: 1024, minHeight: 640, show: false,
    title: 'NRRL Billing', backgroundColor: '#f3f2f7',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'r') e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  fs.mkdirSync(backupDir(), { recursive: true });
  try {
    store = new Store(dbFile());
  } catch (e) {
    dialog.showErrorBox('NRRL Billing could not open its data', `${e.message}\n\nData file: ${dbFile()}\nBackups: ${backupDir()}`);
    app.exit(1); return;
  }
  setupIPC();
  createWindow();
  sync.start();
  link.start();
  // backup at start if the last one is older than 6 hours, then every 30 minutes when something changed
  const last = Date.parse(store.getSetting('last_backup') || '') || 0;
  if (Date.now() - last > 6 * 3600e3) backupNow('start').catch(() => {});
  setInterval(() => { if (dirty) backupNow('auto').catch(() => {}); }, 30 * 60e3);
});

app.on('before-quit', e => {
  if (quitting || !store) return;
  e.preventDefault();
  quitting = true;
  const t = setTimeout(() => app.quit(), 8000);
  (dirty ? backupNow('exit') : Promise.resolve()).catch(() => {}).finally(() => { clearTimeout(t); store.close(); app.quit(); });
});
app.on('window-all-closed', () => app.quit());
