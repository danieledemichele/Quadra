'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Notification, Menu, session } = require('electron');

app.setPath('userData', path.join(os.homedir(), '.config', 'quadra'));
app.setName('Quadra');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const { ConfigStore, PROVIDER_PRESETS } = require('./src/core/config');
const { Store } = require('./src/core/store');
const { Dropbox } = require('./src/core/dropbox');
const { Notion } = require('./src/core/notion');
const { Extractor } = require('./src/core/extractor');
const { Pipeline } = require('./src/core/pipeline');
const { isAbort } = require('./src/core/util');

const DEV = process.argv.includes('--dev');
let win = null;
let worker = null;
let svc = null;
let job = null;

// ---------- cifratura dei segreti ----------

function cryptoAdapter() {
  let usable = false;
  try {
    usable = safeStorage.isEncryptionAvailable() &&
      (typeof safeStorage.getSelectedStorageBackend !== 'function' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  } catch { usable = false; }
  return {
    available: usable,
    encrypt: (s) => (usable ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'plain:' + s),
    decrypt: (s) => {
      if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
      if (s.startsWith('plain:')) return s.slice(6);
      return s;
    },
  };
}

// ---------- elaborazione immagini (finestra nascosta) ----------

const imgJobs = new Map();
let imgSeq = 0;

function createWorker() {
  worker = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'imgworker-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  worker.loadFile(path.join(__dirname, 'imgworker.html'));
  worker.on('closed', () => { worker = null; });
  return new Promise((resolve) => worker.webContents.once('did-finish-load', resolve));
}

ipcMain.on('img:done', (e, res) => {
  if (!worker || e.sender !== worker.webContents) return;
  const j = imgJobs.get(res?.id);
  if (!j) return;
  imgJobs.delete(res.id);
  clearTimeout(j.timer);
  if (res.error) j.reject(new Error(`Immagine non leggibile: ${res.error}`));
  else j.resolve(Buffer.from(res.bytes));
});

async function prepareImage(buf, maxMegapixels) {
  if (!worker) await createWorker();
  const id = ++imgSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { imgJobs.delete(id); reject(new Error('Elaborazione immagine troppo lenta.')); }, 45000);
    imgJobs.set(id, { resolve, reject, timer });
    worker.webContents.send('img:job', { id, bytes: buf, maxMegapixels });
  });
}

// ---------- servizi ----------

function buildServices() {
  const dir = app.getPath('userData');
  const config = new ConfigStore(path.join(dir, 'settings.json'), cryptoAdapter());
  const store = new Store(path.join(dir, 'items.json'));
  const dropbox = new Dropbox({ config });
  const notion = new Notion({ config });
  const extractor = new Extractor({ config });
  const pipeline = new Pipeline({ config, store, dropbox, notion, extractor, prepareImage, cacheDir: path.join(dir, 'cache') });
  pipeline.recover();
  const send = (ch) => (payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
  pipeline.on('item', send('evt:item'));
  pipeline.on('removed', send('evt:removed'));
  pipeline.on('progress', send('evt:progress'));
  pipeline.on('quota', send('evt:quota'));
  pipeline.on('status', send('evt:status'));
  return { config, store, dropbox, notion, extractor, pipeline, secureStorage: cryptoAdapter().available };
}

// ---------- IPC ----------

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) return { ok: false, error: 'Origine non autorizzata.' };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

const notifyJob = (running, kind) => { if (win && !win.isDestroyed()) win.webContents.send('evt:job', { running, kind }); };

async function runJob(kind, fn) {
  if (job) throw new Error('Un\'altra operazione è ancora in corso.');
  const controller = new AbortController();
  job = { kind, controller };
  notifyJob(true, kind);
  try {
    return await fn(controller.signal);
  } catch (e) {
    if (isAbort(e)) return { cancelled: true };
    throw e;
  } finally {
    job = null;
    notifyJob(false, kind);
  }
}

function summaryText(s) {
  const parts = [`${s.added} da rivedere`];
  if (s.duplicates) parts.push(`${s.duplicates} doppi`);
  if (s.errors) parts.push(`${s.errors} con errore`);
  return parts.join(' · ');
}

function notify(body) {
  if (Notification.isSupported() && win && !win.isFocused()) new Notification({ title: 'Quadra', body }).show();
}

function safeExternal(url, hosts) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Indirizzo non valido.'); }
  if (u.protocol !== 'https:' || !hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) {
    throw new Error('Indirizzo non consentito.');
  }
  return shell.openExternal(u.toString());
}

function registerIpc() {
  const { config, pipeline, dropbox, notion, extractor } = svc;

  handle('settings:get', () => ({ settings: config.getPublic(), secureStorage: svc.secureStorage, version: app.getVersion() }));
  handle('settings:save', (s) => config.applyPublic(s));
  handle('settings:presets', () => PROVIDER_PRESETS);
  handle('settings:testNotion', () => notion.test());
  handle('settings:testDropbox', () => dropbox.test());
  handle('settings:testModel', (m) => extractor.testModel(m));
  handle('settings:listModels', (id) => extractor.listModels(id));
  handle('settings:dropboxAuthUrl', async () => {
    const url = dropbox.authUrl();
    await safeExternal(url, ['dropbox.com']);
    return url;
  });
  handle('settings:dropboxExchange', async (code) => { await dropbox.exchangeCode(code); return true; });

  handle('scan:start', () => runJob('scan', async (signal) => {
    extractor.resetCooldowns();
    const s = await pipeline.scanDropbox({ signal });
    notify(summaryText(s));
    return s;
  }));
  handle('scan:cancel', () => { job?.controller.abort(); return true; });

  handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Scegli le foto degli scontrini',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Immagini', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  handle('files:import', (paths, person) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) throw new Error('File non validi.');
    return runJob('import', async (signal) => {
      extractor.resetCooldowns();
      return pipeline.importLocal(paths.slice(0, 200), person, { signal });
    });
  });

  handle('items:list', () => pipeline.list());
  handle('items:update', (id, data, contoId) => pipeline.updateEdits(id, data, contoId));
  handle('items:confirm', (id, data, contoId) => pipeline.confirm(id, data, contoId));
  handle('items:confirmMany', (ids) => pipeline.confirmMany(Array.isArray(ids) ? ids : []));
  handle('items:discard', (id) => pipeline.discard(id));
  handle('items:reextract', (id) => runJob('reextract', (signal) => pipeline.reextract(id, signal)));
  handle('items:image', async (id) => {
    const buf = await pipeline.imageFor(id);
    return buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : null;
  });
  handle('items:openNotion', (id) => {
    const it = svc.store.get(id);
    if (!it?.notion?.url) throw new Error('Nessun link Notion per questo scontrino.');
    return safeExternal(it.notion.url, ['notion.so', 'notion.site']);
  });
  handle('conti:list', (refresh) => pipeline.listConti(!!refresh));
}

// ---------- finestra ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Quadra',
    backgroundColor: '#f4f0e8',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  if (!DEV) Menu.setApplicationMenu(null);
  svc = buildServices();
  createWindow();
  registerIpc();
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => job?.controller.abort());
