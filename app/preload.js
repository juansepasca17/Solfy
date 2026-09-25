'use strict';
// Puente mínimo entre la interfaz y el proceso principal. La interfaz no tiene acceso a Node.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('solfy', {
  library: {
    list: invoke('library:list'),
    load: invoke('library:load'),
    pick: invoke('library:pick'),
    importFile: (file, opts) => {
      if (!(file instanceof File)) return Promise.reject(new Error('Archivo inválido'));
      return ipcRenderer.invoke('library:importPath', webUtils.getPathForFile(file), opts);
    },
    retry: invoke('library:retry'),
    remove: invoke('library:delete'),
    rename: invoke('library:rename'),
    exportMidi: invoke('library:exportMidi'),
  },
  engine: {
    cancel: invoke('engine:cancel'),
    setDevice: invoke('engine:setDevice'),
    gpuInfo: invoke('engine:gpuInfo'),
    onEvent: (cb) => {
      const listener = (_e, ev) => cb(ev);
      ipcRenderer.on('engine:event', listener);
      return () => ipcRenderer.removeListener('engine:event', listener);
    },
  },
  notes: {
    save: invoke('notes:save'),
    restore: invoke('notes:restore'),
  },
  lyrics: { save: invoke('lyrics:save') },
  scores: { add: invoke('scores:add'), list: invoke('scores:list') },
  info: invoke('app:info'),
});
