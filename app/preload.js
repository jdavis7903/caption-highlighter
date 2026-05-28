// preload.js — exposes a safe subset of node APIs to the renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkBinaries: () => ipcRenderer.invoke('check-binaries'),
  listFonts: () => ipcRenderer.invoke('list-fonts'),
  pickVideo: () => ipcRenderer.invoke('pick-video'),
  pickSave: (name) => ipcRenderer.invoke('pick-save', name),
  probeVideo: (path) => ipcRenderer.invoke('probe-video', path),
  transcribe: (path) => ipcRenderer.invoke('transcribe', path),
  exportVideo: (opts) => ipcRenderer.invoke('export-video', opts),
  revealFile: (path) => ipcRenderer.invoke('reveal-file', path),
  openInAME: (path) => ipcRenderer.invoke('open-in-ame', path),

  onProgress: (cb) => {
    ipcRenderer.on('progress', (_e, data) => cb(data));
  },
  onExportProgress: (cb) => {
    ipcRenderer.on('export-progress', (_e, data) => cb(data));
  }
});
