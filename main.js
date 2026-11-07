'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Notification, Menu, session, powerMonitor } = require('electron');

app.setPath('userData', path.join(os.homedir(), '.config', 'quadra'));
app.setName('Quadra');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const { ConfigStore, PROVIDER_PRESETS } = require('./src/core/config');
const { AppLock } = require('./src/core/lock');
const { Store } = require('./src/core/store');
const { Dropbox } = require('./src/core/dropbox');
const { Notion } = require('./src/core/notion');
const { Extractor } = require('./src/core/extractor');
const { Pipeline } = require('./src/core/pipeline');
const { ExpenseService } = require('./src/core/expenses');
const { Updater } = require('./src/core/updater');
const { isAbort } = require('./src/core/util');
const { execFile } = require('node:child_process');

const DEV = process.argv.includes('--dev');
let win = null;
let worker = null;
let svc = null;
let lock = null;
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
  const expenses = new ExpenseService({ notion, file: path.join(dir, 'expenses.json') });
  const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 600000 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
  });
  const updater = new Updater({ config, currentVersion: app.getVersion(), dir: path.join(dir, 'updates'), run });
  const send = (ch) => (payload) => { if (win && !win.isDestroyed() && !lock.isLocked()) win.webContents.send(ch, payload); };
  pipeline.on('item', send('evt:item'));
  pipeline.on('removed', send('evt:removed'));
  pipeline.on('progress', send('evt:progress'));
  pipeline.on('quota', send('evt:quota'));
  pipeline.on('status', send('evt:status'));
  updater.on('state', send('evt:update'));
  return { config, store, dropbox, notion, extractor, pipeline, expenses, updater, secureStorage: cryptoAdapter().available };
}

// ---------- IPC ----------

// Con la password attiva, finché Quadra è bloccata nessun canale risponde (tranne quelli per sbloccare):
// il blocco è imposto qui, nel processo principale, non solo nell'interfaccia.
function handle(channel, fn, { open = false } = {}) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) return { ok: false, error: 'Origine non autorizzata.' };
    if (!open && lock.isLocked()) return { ok: false, error: 'Quadra è bloccata: inserisci la password.' };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

const notifyJob = (running, kind) => { if (win && !win.isDestroyed() && !lock.isLocked()) win.webContents.send('evt:job', { running, kind }); };

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
  const { config, pipeline, dropbox, notion, extractor, expenses, updater } = svc;

  const statsOpts = (o) => ({
    period: o?.period === 'month' ? 'month' : 'week',
    anchor: /^\d{4}-\d{2}-\d{2}$/.test(o?.anchor || '') ? o.anchor : undefined,
    person: typeof o?.person === 'string' ? o.person.slice(0, 60) : '',
  });
  handle('stats:get', (o) => expenses.view(statsOpts(o)));
  handle('stats:refresh', async (o) => { await expenses.refresh(); return expenses.view(statsOpts(o)); });

  handle('update:state', () => updater.state);
  handle('update:check', () => updater.check());
  handle('update:install', async () => {
    if (!app.isPackaged) throw new Error('L\'aggiornamento in un clic funziona solo nell\'app installata dal pacchetto .deb.');
    await updater.update();
    setTimeout(() => { app.relaunch(); app.exit(0); }, 1200);
    return true;
  });

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

  handle('lock:status', () => lock.status(), { open: true });
  handle('lock:unlock', (pw) => lock.unlock(pw), { open: true });
  handle('lock:lock', () => lock.lock());
  handle('lock:set', (pw, current) => lock.setPassword(pw, current));
  handle('lock:remove', (pw) => lock.removePassword(pw));
  handle('lock:autolock', (min) => lock.setAutoLock(min));

  handle('items:list', () => pipeline.list());
  handle('items:update', (id, data, contoId) => pipeline.updateEdits(id, data, contoId));
  handle('items:confirm', async (id, data, contoId) => { const it = await pipeline.confirm(id, data, contoId); expenses.markStale(); return it; });
  handle('items:confirmMany', async (ids) => { const r = await pipeline.confirmMany(Array.isArray(ids) ? ids : []); expenses.markStale(); return r; });
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
  lock = new AppLock({ file: path.join(app.getPath('userData'), 'lock.json') });
  svc = buildServices();
  createWindow();
  // Al blocco la finestra si ricarica: nella pagina non resta nessun dato, solo la schermata della password.
  lock.on('change', (st) => { if (st.locked && win && !win.isDestroyed()) win.webContents.reload(); });
  powerMonitor.on('lock-screen', () => lock.lock());
  powerMonitor.on('suspend', () => lock.lock());
  setInterval(() => {
    const st = lock.status();
    if (st.enabled && !st.locked && st.autoLockMin > 0 && powerMonitor.getSystemIdleTime() >= st.autoLockMin * 60) lock.lock();
  }, 15000);
  registerIpc();
  const autoCheck = () => { if (svc.config.get().update.autoCheck) svc.updater.check({ silent: true }).catch(() => {}); };
  setTimeout(autoCheck, 8000);
  setInterval(autoCheck, 6 * 3600 * 1000);
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => job?.controller.abort());
