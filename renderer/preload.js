const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Everything the renderer can reach. No Node APIs leak into the page.
 */
contextBridge.exposeInMainWorld('api', {
  boot: () => ipcRenderer.invoke('boot'),
  savePreferences: (preferences) => ipcRenderer.invoke('preferences-save', preferences),
  saveSessionSync: (session) => ipcRenderer.sendSync('session-save-sync', session),
  copyImage: (bytes) => ipcRenderer.invoke('copy-image', bytes),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  /** Returns { kind: 'pdf' | 'markdown', data | text } or { error | unsupported }. */
  readDocument: (filePath) => ipcRenderer.invoke('read-pdf', filePath),
  loadMarks: (filePath) => ipcRenderer.invoke('marks-load', filePath),
  saveMarks: (filePath, payload) => ipcRenderer.invoke('marks-save', { filePath, payload }),
  saveMarksSync: (filePath, payload) => ipcRenderer.sendSync('save-marks-sync', { filePath, payload }),
  exportPdf: (filePath, annotations, mode, target) =>
    ipcRenderer.invoke('export-pdf', { filePath, annotations, mode, target }),
  printPdf: (filePath, target, options) =>
    ipcRenderer.invoke('print-pdf', { filePath, target, options }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  recentList: () => ipcRenderer.invoke('recent-list'),

  /** Structural PDF editing: all of it runs in the main process. */
  docInfo: (bytes) => ipcRenderer.invoke('doc-info', { bytes }),
  docFields: (bytes) => ipcRenderer.invoke('doc-fields', { bytes }),
  docApply: (bytes, ops) => ipcRenderer.invoke('doc-apply', { bytes, ops }),
  docSave: (filePath, bytes, target) =>
    ipcRenderer.invoke('doc-save', { filePath, bytes, target }),
  pickPdf: (target) => ipcRenderer.invoke('pick-pdf', target),
  newDocument: (size, target) => ipcRenderer.invoke('new-document', { size, target }),
  writeText: (filePath, text, suffix, extensions, target) =>
    ipcRenderer.invoke('write-text', { filePath, text, suffix, extensions, target }),
  writeMarkdown: (filePath, text, saveAs, target) =>
    ipcRenderer.invoke('write-markdown', { filePath, text, saveAs, target }),
  pickImageSave: (filePath, target) => ipcRenderer.invoke('image-pick-save', { filePath, target }),
  saveImage: (file, bytes) => ipcRenderer.invoke('image-save', { file, bytes }),

  /** Electron 32+ way to recover a dropped file's path. */
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return file.path || ''; }
  },

  /** Menu and second-instance commands land here. */
  onCommand: (handler) => {
    ipcRenderer.on('command', (_e, payload) => handler(payload));
  },

  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome }
});
