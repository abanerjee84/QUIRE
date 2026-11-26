'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
if (process.env.QUIRE_USER_DATA) app.setPath('userData', path.resolve(process.env.QUIRE_USER_DATA));
const { startServer } = require('./server');
const { exportPdf } = require('./export-pdf');
const { applyOps, readInfo, readFields, createBlank, PAGE_SIZES } = require('./doc-edit');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const PDFJS = path.join(NODE_MODULES, 'pdfjs-dist');
const MARKED = path.join(NODE_MODULES, 'marked');
const KATEX = path.join(NODE_MODULES, 'katex', 'dist');
const RECENT_FILE = () => path.join(app.getPath('userData'), 'recent.json');
const PREFERENCES_FILE = () => path.join(app.getPath('userData'), 'preferences.json');
const SESSION_FILE = () => path.join(app.getPath('userData'), 'session.json');
const DEFAULT_PREFERENCES = { theme: 'dark', restoreSession: true, rememberPosition: true };

function readJson(file, fallback) {
  try { return JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fsSync.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fsSync.renameSync(temporary, file);
}
function normalizePreferences(value) {
  return { theme: value?.theme === 'light' ? 'light' : 'dark', restoreSession: value?.restoreSession !== false, rememberPosition: value?.rememberPosition !== false };
}

const MAX_RECENT = 12;

/** Extensions Quire opens at all: PDF plus everything read as Markdown. */
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdown', '.mdwn', '.mkd', '.mkdn', '.mdx', '.txt', '.text']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif']);
const DOC_EXT = new RegExp('\\.(' + ['pdf', ...MARKDOWN_EXT, ...IMAGE_EXT].map((e) => e.replace(/^\./, '')).join('|') + ')$', 'i');

let win = null;
let serverUrl = null;
let initialFile = null;

/* ------------------------------------------------------------------ recent */

async function readRecent() {
  try {
    const raw = await fs.readFile(RECENT_FILE(), 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

async function addRecent(filePath) {
  const list = await readRecent();
  let size = 0;
  try {
    size = (await fs.stat(filePath)).size;
  } catch { /* missing file is fine, it just shows greyed out */ }
  const entry = { path: filePath, name: path.basename(filePath), size, openedAt: Date.now() };
  const next = [entry, ...list.filter((e) => e.path !== filePath)].slice(0, MAX_RECENT);
  await fs.writeFile(RECENT_FILE(), JSON.stringify(next, null, 2), 'utf8').catch(() => {});
  buildMenu();
  return next;
}

/* ------------------------------------------------------------------- files */

/**
 * Decide what a file really is. The %PDF- magic wins over the extension, so a
 * Markdown file saved as .pdf still renders as Markdown.
 */
function detectKind(filePath, head) {
  const text = head.toString('latin1');
  if (text.startsWith('%PDF-')) return 'pdf';
  if (IMAGE_EXT.has(path.extname(filePath).toLowerCase())) return 'image';
  if (text.includes('\u0000')) return 'binary';
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  return 'binary';
}

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  const text = buf.toString('utf8');
  return text.includes('\u0000') ? buf.toString('latin1') : text;
}

async function readDocument(filePath) {
  const data = await fs.readFile(filePath);
  const kind = detectKind(filePath, data.subarray(0, 4096));
  const base = { path: filePath, name: path.basename(filePath), size: data.length, kind };
  if (kind === 'pdf' || kind === 'image') {
    // A view over the file's whole buffer clones badly across IPC ("An object
    // could not be cloned"), so hand over a detached copy of the bytes.
    return { ...base, data: new Uint8Array(data) };
  }
  if (kind === 'markdown') return { ...base, text: decodeText(data) };
  return { ...base, unsupported: true };
}

/** Annotations live in a sidecar next to the document, falling back to appData. */
function sidecarPath(docPath) {
  const dir = path.dirname(docPath);
  // The extension stays in the name: report.pdf and report.md must not share
  // one sidecar, or a Markdown anchor would be loaded as a PDF rectangle.
  const base = path.basename(docPath);
  const local = path.join(dir, base + '.marks.json');
  const fallback = path.join(app.getPath('userData'), 'marks', base + '.json');
  return { local, fallback };
}

async function writeSidecar(pdfPath, payload) {
  const { local, fallback } = sidecarPath(pdfPath);
  try {
    await fs.mkdir(path.dirname(local), { recursive: true });
    await fs.writeFile(local, JSON.stringify(payload, null, 2), 'utf8');
    return local;
  } catch {
    await fs.mkdir(path.dirname(fallback), { recursive: true });
    await fs.writeFile(fallback, JSON.stringify(payload, null, 2), 'utf8');
    return fallback;
  }
}

async function readSidecar(pdfPath) {
  const { local, fallback } = sidecarPath(pdfPath);
  for (const file of [local, fallback]) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return { file, data: JSON.parse(raw) };
    } catch { /* try next */ }
  }
  return { file: local, data: null };
}

/** Same as writeSidecar but synchronous, for the renderer's beforeunload flush. */
function writeSidecarSync(pdfPath, payload) {
  const { local, fallback } = sidecarPath(pdfPath);
  const text = JSON.stringify(payload, null, 2);
  try {
    fsSync.mkdirSync(path.dirname(local), { recursive: true });
    fsSync.writeFileSync(local, text, 'utf8');
    return local;
  } catch {
    try {
      fsSync.mkdirSync(path.dirname(fallback), { recursive: true });
      fsSync.writeFileSync(fallback, text, 'utf8');
      return fallback;
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------- menu */

function send(command, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('command', { command, payload });
}

async function buildMenu() {
  const recent = await readRecent();
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New PDF…', accelerator: 'CmdOrCtrl+N', click: () => send('new-document') },
        { label: 'Open Document…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        {
          label: 'Open Recent',
          submenu: recent.length
            ? recent.map((e) => ({
                label: e.name,
                click: () => send('open-path', e.path)
              }))
            : [{ label: 'No documents yet', enabled: false }]
        },
        { type: 'separator' },
        { label: 'Save Annotations', accelerator: 'CmdOrCtrl+S', click: () => send('save-marks') },
        { label: 'Save Document', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-document') },
        { label: 'Revert to Original', click: () => send('revert') },
        {
          label: 'Export PDF with Annotations',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => send('export', 'annot')
        },
        {
          label: 'Export Flattened PDF',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => send('export', 'flatten')
        },
        {
          label: 'Export Markdown as PDF',
          accelerator: 'CmdOrCtrl+Shift+X',
          click: () => send('export', 'rendered')
        },
        {
          label: 'Export Markdown as HTML',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => send('export', 'html')
        },
        { label: 'Export Marks as Markdown', click: () => send('export', 'marks') },
        { type: 'separator' },
        { label: 'Close Document', accelerator: 'CmdOrCtrl+W', click: () => send('close') },
        process.platform === 'darwin'
          ? { role: 'close' }
          : { label: 'Quit', accelerator: 'Ctrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'copy' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => send('preferences') }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Select / Read', accelerator: 'CmdOrCtrl+1', click: () => send('tool', 'select') },
        { type: 'separator' },
        { label: 'Highlight', accelerator: 'CmdOrCtrl+H', click: () => send('tool', 'highlight') },
        { label: 'Underline', accelerator: 'CmdOrCtrl+U', click: () => send('tool', 'underline') },
        { label: 'Strikethrough', accelerator: 'CmdOrCtrl+K', click: () => send('tool', 'strikeout') },
        { label: 'Sticky Note', accelerator: 'CmdOrCtrl+M', click: () => send('tool', 'note') },
        { label: 'Ink', accelerator: 'CmdOrCtrl+D', click: () => send('tool', 'ink') },
        { label: 'Rectangle', accelerator: 'CmdOrCtrl+R', click: () => send('tool', 'rect') },
        { label: 'Eraser', accelerator: 'CmdOrCtrl+4', click: () => send('tool', 'eraser') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('toggle-sidebar') },
        { label: 'Search', accelerator: 'CmdOrCtrl+F', click: () => send('search-focus') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom', 'in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom', 'out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => send('zoom', 'reset') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('zoom', 'width') },
        { label: 'Fit Page', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('zoom', 'page') },
        { type: 'separator' },
        { label: 'Go to Page / Section…', accelerator: 'CmdOrCtrl+G', click: () => send('goto-prompt') },
        { label: 'Next Page / Section', accelerator: 'CmdOrCtrl+PageDown', click: () => send('page', 'next') },
        { label: 'Previous Page / Section', accelerator: 'CmdOrCtrl+PageUp', click: () => send('page', 'prev') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { label: 'Toggle Dark Mode', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('theme') },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('help') },
        {
          label: 'About Quire',
          click: () => shell.openExternal('https://github.com/')
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------- setup */

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#14161a',
    title: 'Quire',
    show: false,
    webPreferences: {
      preload: path.join(RENDERER, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.on('render-process-gone', (_e, details) => {
    dialog.showErrorBox('Quire crashed', details.reason + ' (' + details.code + ')');
  });
  win.loadURL(serverUrl);

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

/* --------------------------------------------------------------------- IPC */

ipcMain.handle('boot', () => ({ initialFile, platform: process.platform, version: app.getVersion(), preferences: normalizePreferences(readJson(PREFERENCES_FILE(), DEFAULT_PREFERENCES)), session: readJson(SESSION_FILE(), null) }));
ipcMain.handle('preferences-save', (_e, value) => {
  try { const prefs = normalizePreferences(value); writeJson(PREFERENCES_FILE(), prefs); return prefs; }
  catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.on('session-save-sync', (event, session) => {
  try {
    const tabs = Array.isArray(session?.tabs) ? session.tabs.filter((entry) => typeof entry?.path === 'string' && path.isAbsolute(entry.path)).slice(0, 30).map((entry) => ({ path: entry.path, view: entry.view || null })) : [];
    writeJson(SESSION_FILE(), { tabs, activePath: typeof session?.activePath === 'string' ? session.activePath : null });
    event.returnValue = true;
  } catch (err) { event.returnValue = { error: String(err.message || err) }; }
});
ipcMain.handle('copy-image', (_e, bytes) => {
  try { const image = nativeImage.createFromBuffer(Buffer.from(bytes)); if (image.isEmpty()) throw new Error('Could not read image data'); clipboard.writeImage(image); return true; }
  catch (err) { return { error: String(err.message || err) }; }
});

ipcMain.handle('open-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open a document',
    filters: [
      { name: 'Documents and images', extensions: ['pdf', 'md', 'markdown', 'mdown', 'txt', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'] },
      { name: 'PDF documents', extensions: ['pdf'] },
      { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'] },
      { name: 'All files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  const doc = await readDocument(filePaths[0]);
  await addRecent(filePaths[0]);
  return doc;
});

ipcMain.handle('read-pdf', async (_e, filePath) => {
  try {
    const doc = await readDocument(filePath);
    await addRecent(filePath);
    return doc;
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('marks-load', (_e, filePath) => readSidecar(filePath));
ipcMain.handle('image-pick-save', async (_e, { filePath, target }) => {
  let file = target;
  if (!file) {
    const result = await dialog.showSaveDialog(win, {
      title: 'Export image',
      defaultPath: path.join(path.dirname(filePath), path.parse(filePath).name + '-edited.png'),
      filters: [{ name: 'PNG image', extensions: ['png'] }, { name: 'JPEG image', extensions: ['jpg'] }, { name: 'WebP image', extensions: ['webp'] }]
    });
    if (result.canceled || !result.filePath) return null;
    file = result.filePath;
  }
  return file;
});
ipcMain.handle('image-save', async (_e, { file, bytes }) => {
  try { await fs.writeFile(file, bytes); return file; }
  catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.handle('marks-save', (_e, { filePath, payload }) => writeSidecar(filePath, payload));

ipcMain.handle('export-pdf', async (_e, { filePath, name, annotations, mode, target: forced }) => {
  const suffix = mode === 'flatten' ? 'flattened' : 'annotated';
  let target = forced;
  if (!target) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(win, {
      title: mode === 'flatten' ? 'Export flattened PDF' : 'Export PDF with annotations',
      defaultPath: path.join(path.dirname(filePath), path.basename(filePath, '.pdf') + '-' + suffix + '.pdf'),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }]
    });
    if (canceled || !chosen) return null;
    target = chosen;
  }

  const source = await fs.readFile(filePath);
  if (!source.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    return null;   // annot/flatten export only makes sense on a PDF
  }
  const bytes = await exportPdf(new Uint8Array(source), annotations, mode);
  await fs.writeFile(target, bytes);
  return target;
});

/** Print the current view — used to export Markdown, whose "pages" are headings. */
const PRINT_MARGINS = { none: 0, minimal: 0.2, normal: 0.6 };

ipcMain.handle('print-pdf', async (_e, { filePath, target: forced, options = {} }) => {
  let target = forced;
  if (!target) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(win, {
      title: 'Export as PDF',
      defaultPath: path.join(
        path.dirname(filePath || ''),
        path.basename(filePath || 'document', path.extname(filePath || '')) + '-rendered.pdf'
      ),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }]
    });
    if (canceled || !chosen) return null;
    target = chosen;
  }
  const margin = PRINT_MARGINS[options.margins] ?? PRINT_MARGINS.normal;
  const bytes = await win.webContents.printToPDF({
    printBackground: options.background !== false,
    pageSize: options.paper || 'Letter',
    landscape: options.orientation === 'landscape',
    marginTop: margin,
    marginBottom: margin,
    marginLeft: margin,
    marginRight: margin
  });
  await fs.writeFile(target, bytes);
  return target;
});

ipcMain.handle('open-external', async (_e, url) => {
  if (!/^(https?:|mailto:)/i.test(String(url))) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('recent-list', () => readRecent());
ipcMain.handle('recent-add', (_e, filePath) => addRecent(filePath));

/* ------------------------------------------------------- document editing */

ipcMain.handle('doc-info', async (_e, { bytes }) => {
  try {
    return await readInfo(bytes);
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('doc-fields', async (_e, { bytes }) => {
  try {
    return await readFields(bytes);
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('doc-apply', async (_e, { bytes, ops }) => {
  try {
    const result = await applyOps(bytes, ops || []);
    return {
      bytes: result.bytes,
      mapping: result.mapping,
      pageCount: result.pageCount,
      report: result.report
    };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

/** Write edited bytes back over the document, or to a file the user picked. */
ipcMain.handle('doc-save', async (_e, { filePath, bytes, target }) => {
  let file = target;
  if (!file) {
    if (!filePath) {
      const { canceled, filePath: chosen } = await dialog.showSaveDialog(win, {
        title: 'Save document',
        defaultPath: path.join(app.getPath('documents'), 'untitled.pdf'),
        filters: [{ name: 'PDF document', extensions: ['pdf'] }]
      });
      if (canceled || !chosen) return null;
      file = chosen;
    } else {
      file = filePath;
    }
  }
  try {
    await fs.writeFile(file, bytes);
    return file;
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

/** Pick another PDF to merge into the one that is open. */
ipcMain.handle('pick-pdf', async (_e, target) => {
  let filePath = target;
  if (!filePath) {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Merge pages from a PDF',
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
      properties: ['openFile']
    });
    if (canceled || !filePaths.length) return null;
    filePath = filePaths[0];
  }
  try {
    const data = await fs.readFile(filePath);
    if (!data.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
      return { error: 'That file is not a PDF' };
    }
    return { path: filePath, name: path.basename(filePath), bytes: new Uint8Array(data) };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

/** File → New: ask where the blank PDF should live, then create and open it. */
ipcMain.handle('new-document', async (_e, { size, target } = {}) => {
  let filePath = target;
  if (!filePath) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(win, {
      title: 'New PDF document',
      defaultPath: path.join(app.getPath('documents'), 'untitled.pdf'),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }]
    });
    if (canceled || !chosen) return null;
    filePath = chosen;
  }
  const { bytes } = await createBlank(size);
  const file = filePath.toLowerCase().endsWith('.pdf') ? filePath : filePath + '.pdf';
  await fs.writeFile(file, bytes);
  const doc = await readDocument(file);
  await addRecent(file);
  return doc;
});

/** Write a text export (HTML, Markdown) where the user chooses. */
ipcMain.handle('write-text', async (_e, { filePath, text, suffix, extensions, target }) => {
  const ext = extensions && extensions.length ? extensions : ['txt'];
  const base = path.basename(filePath || 'document', path.extname(filePath || ''));
  let chosen = target;
  if (!chosen) {
    const dir = filePath ? path.dirname(filePath) : app.getPath('documents');
    const { canceled, filePath: picked } = await dialog.showSaveDialog(win, {
      title: 'Export ' + suffix,
      defaultPath: path.join(dir, base + '-' + suffix + '.' + ext[0]),
      filters: [{ name: String(ext[0]).toUpperCase() + ' file', extensions: ext }]
    });
    if (canceled || !picked) return null;
    chosen = picked;
  }
  try {
    await fs.writeFile(chosen, text, 'utf8');
    return chosen;
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

/** Write a Markdown file: in place, to a chosen path, or through a Save dialog. */
ipcMain.handle('write-markdown', async (_e, { filePath, text, saveAs, target }) => {
  let file = target;
  if (!file && saveAs) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(win, {
      title: 'Save Markdown as',
      defaultPath: filePath || path.join(app.getPath('documents'), 'notes.md'),
      filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }]
    });
    if (canceled || !chosen) return null;
    file = chosen;
  }
  file = file || filePath;
  if (!file) return { error: 'no file to write' };
  try {
    await fs.writeFile(file, text, 'utf8');
    if (file !== filePath) await addRecent(file);
    return file;
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

ipcMain.on('save-marks-sync', (event, { filePath, payload }) => {
  event.returnValue = filePath ? writeSidecarSync(filePath, payload) : null;
});

/* ------------------------------------------------------------------ launch */

/** A file argument that Quire can open; the app directory itself is ignored. */
function fileFromArgv(argv) {
  return argv.find((arg) => !arg.startsWith('-') && DOC_EXT.test(arg)) || null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = fileFromArgv(argv);
    if (win && !win.isDestroyed()) {
      win.focus();
      if (file) win.webContents.send('command', { command: 'open-path', payload: file });
    }
  });

  app.whenReady().then(async () => {
    const server = await startServer({
      root: RENDERER,
      mounts: { '/pdfjs': PDFJS, '/vendor/marked': MARKED, '/vendor/katex': KATEX }
    });
    serverUrl = server.url;

    initialFile = fileFromArgv(process.argv);

    await buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
