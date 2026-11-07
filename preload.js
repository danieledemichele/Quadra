'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((r) => {
  if (r && r.ok) return r.data;
  throw new Error((r && r.error) || 'Errore sconosciuto');
});

const EVENTS = new Set(['evt:item', 'evt:removed', 'evt:progress', 'evt:quota', 'evt:status', 'evt:job', 'evt:update']);

contextBridge.exposeInMainWorld('quadra', {
  settings: {
    get: () => call('settings:get'),
    save: (s) => call('settings:save', s),
    testNotion: () => call('settings:testNotion'),
    testDropbox: () => call('settings:testDropbox'),
    testModel: (m) => call('settings:testModel', m),
    listModels: (providerId) => call('settings:listModels', providerId),
    dropboxAuthUrl: () => call('settings:dropboxAuthUrl'),
    dropboxExchange: (code) => call('settings:dropboxExchange', code),
    presets: () => call('settings:presets'),
  },
  scan: { start: () => call('scan:start'), cancel: () => call('scan:cancel') },
  pickFiles: () => call('files:pick'),
  importPaths: (paths, person) => call('files:import', paths, person),
  pathForFile: (file) => webUtils.getPathForFile(file),
  items: {
    list: () => call('items:list'),
    update: (id, data, contoId) => call('items:update', id, data, contoId),
    confirm: (id, data, contoId) => call('items:confirm', id, data, contoId),
    confirmMany: (ids) => call('items:confirmMany', ids),
    discard: (id) => call('items:discard', id),
    reextract: (id) => call('items:reextract', id),
    image: (id) => call('items:image', id),
    openNotion: (id) => call('items:openNotion', id),
  },
  stats: { get: (o) => call('stats:get', o), refresh: (o) => call('stats:refresh', o) },
  update: { state: () => call('update:state'), check: () => call('update:check'), install: () => call('update:install') },
  conti: { list: (refresh) => call('conti:list', refresh) },
  on: (event, cb) => {
    if (!EVENTS.has(event)) return () => {};
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(event, fn);
    return () => ipcRenderer.removeListener(event, fn);
  },
});
