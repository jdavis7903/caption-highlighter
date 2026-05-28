const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Files
  pickVideo: () => ipcRenderer.invoke('pick-video'),
  pickSavePath: (name) => ipcRenderer.invoke('pick-save-path', name),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  openInDefaultApp: (p) => ipcRenderer.invoke('open-in-default-app', p),

  // Video info
  probeVideo: (p) => ipcRenderer.invoke('probe-video', p),

  // Transcription
  transcribe: (p, opts) => ipcRenderer.invoke('transcribe', p, opts),
  onTranscribeProgress: (cb) => ipcRenderer.on('transcribe-progress', (_e, pct) => cb(pct)),
  onTranscribeGpuFallback: (cb) => ipcRenderer.on('transcribe-gpu-fallback', (_e, msg) => cb(msg)),
  onTranscribeDebug: (cb) => ipcRenderer.on('transcribe-debug', (_e, msg) => cb(msg)),

  // Fonts
  listFonts: () => ipcRenderer.invoke('list-fonts'),

  // Export
  exportVideo: (payload) => ipcRenderer.invoke('export-video', payload),
  sendToMediaEncoder: (payload) => ipcRenderer.invoke('send-to-media-encoder', payload),
  findMediaEncoder: () => ipcRenderer.invoke('find-media-encoder'),
  onExportProgress: (cb) => ipcRenderer.on('export-progress', (_e, sec) => cb(sec)),

  // Updates
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb(info)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', () => cb()),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, p) => cb(p)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_e, info) => cb(info)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_e, msg) => cb(msg)),
});
