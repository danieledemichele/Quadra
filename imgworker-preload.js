'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('imgworker', {
  onJob: (cb) => ipcRenderer.on('img:job', (_e, job) => cb(job)),
  done: (res) => ipcRenderer.send('img:done', res),
});
