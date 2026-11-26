import { PdfViewer } from './viewer.js';
import { Annotator, newId } from './annotations.js';
import { Search } from './search.js';
import { SourceEditor } from './edit.js';
import { DocPanel } from './docpanel.js';
import { Sidebar } from './sidebar.js';
import { MarkdownDoc } from './markdown.js';
import { ImageEditor } from './image.js';

const $ = (id) => document.getElementById(id);

const ICONS = {
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 6h6l2 2h10v10H3z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 5l7 7-7 7"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 7L4 12l5 5"/><path d="M4 12h9a5 5 0 0 1 5 5v2"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M15 7l5 5-5 5"/><path d="M20 12h-9a5 5 0 0 0-5 5v2"/></svg>',
  theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 14a8 8 0 1 1-9-11 7 7 0 0 0 9 11z"/></svg>',
  panel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M6 14l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M6 10l6 6 6-6"/></svg>',
  'fit-width': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 12h18"/><path d="M7 8l-4 4 4 4"/><path d="M17 8l4 4-4 4"/></svg>',
  'fit-page': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  select: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l13 9-6.2 1.1L9.6 19z"/></svg>',
  highlight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20h16"/><path d="M8 15l5-9 4 4-6 8-3-1z"/></svg>',
  underline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 4v9a5 5 0 0 0 10 0V4"/><path d="M5 20h14"/></svg>',
  strikeout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 12h16"/><path d="M8 6h5a3 3 0 0 1 0 5H8"/><path d="M16 18h-5"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3h14v18l-7-4-7 4z"/></svg>',
  ink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20l3.5-1L19 7.5l-2.5-2.5L5 17z"/></svg>',
  rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="6" width="16" height="12" rx="1.5"/></svg>',
  ellipse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="12" cy="12" rx="8" ry="5.5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 12h11"/><path d="M13 7.5 18 12l-5 4.5"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 20h11"/><path d="M5 14l6-6 6 6-4.5 4.5H9.5z"/></svg>'
};

const PALETTES = {
  highlight: ['#f2c811', '#a3e635', '#63b3ed', '#f78fb3', '#fb923c'],
  underline: ['#2f9e44', '#e03131', '#1971c2', '#1d1d1f'],
  strikeout: ['#e03131', '#1d1d1f', '#7048e8'],
  ink: ['#1d1d1f', '#e03131', '#1971c2', '#2f9e44', '#f59f00'],
  rect: ['#1971c2', '#e03131', '#2f9e44', '#1d1d1f'],
  ellipse: ['#1971c2', '#e03131', '#2f9e44', '#1d1d1f'],
  arrow: ['#e03131', '#1971c2', '#1d1d1f', '#2f9e44'],
  note: ['#f59f00', '#6ea8fe', '#f06595', '#2f9e44']
};

const WEIGHT_TOOLS = new Set(['ink', 'rect', 'ellipse', 'arrow', 'underline', 'strikeout']);

const COLOR_NAMES = {
  '#f2c811': 'Amber', '#a3e635': 'Lime', '#63b3ed': 'Blue', '#f78fb3': 'Rose',
  '#fb923c': 'Orange', '#2f9e44': 'Green', '#e03131': 'Red', '#1971c2': 'Blue',
  '#1d1d1f': 'Ink', '#7048e8': 'Violet', '#f59f00': 'Amber', '#6ea8fe': 'Blue',
  '#f06595': 'Pink', '#c1121f': 'Crimson'
};

const SHORTCUTS = [
  ['Ctrl+O', 'Open a document in a new tab'],
  ['Ctrl+W', 'Close the active tab'],
  ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous document tab'],
  ['Ctrl+S', 'Save annotations to the sidecar file'],
  ['Ctrl+Shift+E', 'Export a PDF with real annotations'],
  ['Ctrl+Shift+B', 'Export a PDF with markup burned in'],
  ['Ctrl+Shift+X', 'Export Markdown as a rendered PDF'],
  ['Ctrl+F', 'Search the document'],
  ['Enter / Shift+Enter', 'Next / previous match'],
  ['Ctrl+1 … Ctrl+4', 'Select, highlight, underline, eraser (see Tools menu)'],
  ['Ctrl+H / U / K', 'Highlight, underline, strikethrough'],
  ['Ctrl+M / D / R', 'Note, ink, rectangle'],
  ['Ctrl+E / Ctrl+Shift+A', 'Ellipse, arrow'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo a mark, then undo a document change'],
  ['Ctrl+= / Ctrl+- / Ctrl+0', 'Zoom in, out, actual size'],
  ['Ctrl+Shift+F / P', 'Fit width, fit page'],
  ['Ctrl+G', 'Go to page or section'],
  ['Ctrl+B', 'Toggle sidebar'],
  ['Ctrl+Shift+L', 'Dark / light theme'],
  ['Ctrl+N', 'New blank PDF'],
  ['Ctrl+Shift+S', 'Save the document itself'],
  ['Ctrl+Shift+O', 'Revert to the original document'],
  ['Ctrl+Shift+M', 'Export every mark as a Markdown list'],
  ['Ctrl+Shift+H', 'Export Markdown as standalone HTML'],
  ['Ctrl+P', 'Print / export the view as PDF'],
  ['Ctrl+/', 'This shortcut list'],
  ['Ctrl+,', 'Preferences'],
  ['Drag on a page', 'Freeform highlight when there is no text layer'],
  ['Drag on Markdown', 'Highlight, underline or strike through the selection']
];

const viewer = new PdfViewer($('viewer'));
const annotator = new Annotator(viewer, {
  onChange: () => { markDirty(); refreshMarks(); },
  onNote: (a, opts) => openNoteEditor(a, opts),
  onSelection: (text) => { $('status-selection').textContent = text ? quote(text) : ''; }
});
const search = new Search(viewer);
const imageEditor = new ImageEditor($('viewer'), () => {
  state.edited = true;
  updateSaveState();
});

const markdown = new MarkdownDoc($('viewer'), {
  annotator,
  hooks: {
    openExternal: (url) => window.api.openExternal(url),
    openFile: (p) => openPath(p)
  }
});
annotator.surface = viewer;

const sidebar = new Sidebar({
  viewer,
  thumbsEl: $('pane-thumbs'),
  marksEl: $('pane-marks'),
  onJump: (arg) => {
    if (typeof arg === 'number') surface().gotoPage(arg);
    else { surface().gotoPage(arg.page); annotator.pulse(arg.id); }
  },
  onDelete: (id) => annotator.remove(id),
  onClear: () => {
    if (!confirm('Delete all annotations in this document?')) return;
    annotator.mutate(() => { annotator.list = []; });
  }
});

const docPanel = new DocPanel({
  panelEl: $('pane-doc'),
  api: window.api,
  hooks: {
    isPdf: () => state.kind === 'pdf',
    getBytes: () => state.bytes,
    currentPage: () => viewer.current,
    apply: (ops, opts) => {
      state.lastOp = applyDocOps(ops, opts);
      return state.lastOp;
    },
    pageSize: () => {
      const p = viewer.pages[viewer.current - 1];
      return p ? [p.w, p.h] : null;
    },
    status: (msg) => setStatus(msg),
    goTo: (n) => viewer.gotoPage(n),
    merge: () => mergeDocument(),
    revert: () => revertDocument(),
    findText: (query) => viewer.findText(query),
    contentBoxes: () => viewer.contentBoxes({ pad: 12 })
  }
});

const sourceEditor = new SourceEditor($('viewer'), {
  onSave: (text) => writeMarkdown(text),
  onStatus: (msg) => setStatus(msg),
  onClose: () => showRendered()
});

const state = {
  doc: null,          // { path, name, size, kind }
  kind: null,         // 'pdf' | 'markdown'
  pageCount: 0,
  dirty: false,
  savedAt: null,
  saveFile: null,
  searchTimer: null,
  saveTimer: null,
  editor: null,
  bytes: null,        // PDF bytes on stage, edits included
  originalBytes: null,// the bytes that came off disk
  edited: false,
  docHistory: []      // snapshots for undoing document changes
};

/**
 * Open documents.
 *
 * Only the active tab lives in the viewer: switching snapshots the live state
 * (bytes, marks, undo history and scroll position) and loads the next tab. That
 * keeps one PDF.js document and one annotation surface alive at a time while
 * every tab keeps its own edits and place in the file.
 */
let tabs = [];
let activeTabId = null;
let tabSeq = 0;
let switchSeq = 0;
let preferences = { theme: 'dark', restoreSession: true, rememberPosition: true };
let restoringSession = true;
let sessionTimer = null;
let sessionSaveWarned = false;

function activeTab() {
  return tabs.find((tab) => tab.id === activeTabId) || null;
}

function nextTabId() {
  tabSeq += 1;
  return 'tab' + tabSeq;
}

function samePath(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function cloneMarks(list) {
  return JSON.parse(JSON.stringify(list || []));
}

/** Whatever is open right now: PDF pages or one Markdown article. */
function surface() {
  return state.kind === 'image' ? imageEditor : state.kind === 'markdown' ? markdown : viewer;
}

/** The visible snapshot of where the reader was, restored on tab switch. */
function captureView() {
  if (!state.doc) return null;
  if (state.kind === 'image') return { scale: imageEditor.scale };
  const root = $('viewer');
  const max = Math.max(1, root.scrollHeight - root.clientHeight);
  const view = { ratio: root.scrollTop / max, page: 1 };
  if (state.kind === 'markdown') {
    view.page = markdown.current;
    view.scale = markdown.scale;
    view.fitMode = markdown.fitMode || null;
    view.full = !!markdown.article?.classList.contains('md-full');
  } else {
    view.page = viewer.current;
    view.scale = viewer.scale;
    view.fitMode = viewer.fitMode || null;
  }
  return view;
}

function kindWord() {
  return state.kind === 'markdown' ? 'section' : 'page';
}

function stepPage(dir) {
  if (state.kind === 'image') return;
  if (state.kind === 'markdown') {
    if (dir > 0) markdown.nextSection();
    else markdown.prevSection();
  } else {
    viewer.gotoPage(viewer.current + dir);
  }
}

/* ------------------------------------------------------------------- icons */

// Icons go in front of any existing label, so "Open" keeps its text.
for (const node of document.querySelectorAll('[data-icon]')) node.insertAdjacentHTML('afterbegin', ICONS[node.dataset.icon]);
for (const node of document.querySelectorAll('.tool-btn')) node.innerHTML = ICONS[node.dataset.tool];

/* ------------------------------------------------------------------- open */

async function openDialog() {
  try {
    const doc = await window.api.openDialog();
    if (doc?.unsupported) { toast(quote(doc.name) + ' is not a supported document or image.'); return; }
    if (doc) await openDocument(doc);
  } catch (err) { toast('Could not open: ' + (err?.message || err)); }
}

async function openPath(filePath, options) {
  const doc = await window.api.readDocument(filePath);
  if (doc?.error) { if (!options?.quiet) toast('Could not open: ' + doc.error); return false; }
  if (doc?.unsupported) { if (!options?.quiet) toast(quote(doc.name) + ' is not a supported document or image.'); return false; }
  return openDocument(doc, options);
}

async function openDocument(doc, options = {}) {
  const kind = doc.kind || 'pdf';
  const existing = tabs.find((tab) => tab.doc?.path && samePath(tab.doc.path, doc.path));
  if (existing) { await activateTab(existing.id); return true; }

  setStatus('Loading ' + doc.name + '…');
  await detachActiveTab();

  let marks = null;
  try { marks = await window.api.loadMarks(doc.path); } catch { /* marks are optional */ }

  const tab = {
    id: nextTabId(),
    doc: { path: doc.path, name: doc.name, size: doc.size, kind },
    kind,
    bytes: kind === 'pdf' || kind === 'image' ? doc.data : null,
    originalBytes: kind === 'pdf' ? doc.data : null,
    edited: false,
    pageCount: 0,
    marks: Array.isArray(marks?.data?.annotations) ? marks.data.annotations : [],
    saveFile: marks?.data ? marks.file : null,
    savedAt: marks?.data?.savedAt ? new Date(marks.data.savedAt) : null,
    dirty: false,
    docHistory: [],
    source: kind === 'markdown' ? doc.text : null,
    view: options.view || null,
    undoStack: [],
    redoStack: []
  };

  const previous = activeTabId;
  tabs.push(tab);
  activeTabId = tab.id;
  renderTabs();

  try {
    await loadTab(tab, { restore: !!options.view });
    return true;
  } catch (err) {
    console.error(err);
    tabs = tabs.filter((item) => item.id !== tab.id);
    activeTabId = previous;
    if (!options.quiet) toast('Could not read this file: ' + (err?.message || err));
    if (previous && tabs.some((item) => item.id === previous)) {
      try { await loadTab(activeTab(), { restore: true }); } catch { resetToWelcome(); }
    } else {
      resetToWelcome();
    }
    return false;
  }
}

/** Put the live surface back into the active tab before leaving it. */
async function detachActiveTab() {
  const tab = activeTab();
  if (!tab) return;

  closeNoteEditor();
  if (sourceEditor.open) {
    try { await sourceEditor.flush(); } catch (err) { console.warn('editor flush failed', err); }
    hideSourceEditor();
  }
  clearTimeout(state.saveTimer);
  state.saveTimer = null;

  if (state.doc && state.dirty) {
    try { await saveMarks(); } catch (err) { console.warn('marks save failed', err); }
  }
  if (state.kind === 'markdown' && markdown.source) tab.source = markdown.source;
  if (state.kind === 'image') tab.image = imageEditor.snapshot();

  tab.doc = state.doc;
  tab.kind = state.kind;
  tab.pageCount = state.pageCount;
  tab.bytes = state.bytes;
  tab.originalBytes = state.originalBytes;
  tab.edited = state.edited;
  tab.marks = cloneMarks(annotator.list);
  tab.undoStack = annotator.undoStack.slice();
  tab.redoStack = annotator.redoStack.slice();
  tab.docHistory = state.docHistory;
  tab.dirty = state.dirty;
  tab.saveFile = state.saveFile;
  tab.savedAt = state.savedAt;
  tab.view = captureView();
}

/** Load a tab's bytes, marks and restored place back onto the live surface. */
async function loadTab(tab, { restore = true } = {}) {
  closeNoteEditor();
  if (sourceEditor.open) hideSourceEditor();
  setStatus('Loading ' + tab.doc.name + '…');

  viewer.clear();
  markdown.clear();
  imageEditor.clear();

  state.kind = tab.kind;
  state.doc = tab.doc;
  state.bytes = tab.bytes;
  state.originalBytes = tab.originalBytes;
  state.edited = !!tab.edited;
  state.docHistory = tab.docHistory || [];
  state.dirty = !!tab.dirty;
  state.saveFile = tab.saveFile || null;
  state.savedAt = tab.savedAt || null;

  if (tab.kind === 'image') {
    await imageEditor.load(tab.bytes, tab.image);
  } else if (tab.kind === 'markdown') {
    await markdown.load({ text: tab.source || '', path: tab.doc.path, name: tab.doc.name });
  } else {
    await viewer.load(tab.bytes);
  }

  state.pageCount = tab.kind === 'image' ? 1 : surface().pageCount;
  tab.pageCount = state.pageCount;
  if (tab.kind === 'image') {
    document.body.classList.add('has-doc', 'image-mode');
    if (!tab.image && restore && tab.view?.scale) imageEditor.setScale(tab.view.scale);
    else if (!tab.image) imageEditor.fitPage();
    for (const id of ['nav-group', 'zoom-group', 'search-group', 'tools-group', 'strip']) $(id).hidden = true;
    $('image-toolbar').hidden = false;
    $('doc-name').textContent = tab.doc.name;
    $('doc-kind').textContent = 'IMG';
    $('status-file').textContent = tab.doc.name + ' · ' + formatBytes(tab.doc.size);
    $('status-page').textContent = '';
    $('status-zoom').textContent = '';
    $('status-marks').textContent = '';
    document.title = tab.doc.name + ' — Quire';
    updateSaveState(); renderTabs(); setStatus('');
    return;
  }
  document.body.classList.remove('image-mode');
  $('image-toolbar').hidden = true;
  search.surface = surface();
  annotator.surface = surface();

  annotator.replace(tab.marks);
  annotator.undoStack = (tab.undoStack || []).slice();
  annotator.redoStack = (tab.redoStack || []).slice();

  $('search-input').value = '';
  $('search-count').textContent = '';
  search.reset();

  document.body.classList.add('has-doc');
  for (const id of ['nav-group', 'zoom-group', 'search-group', 'tools-group']) $(id).hidden = false;
  renderSwatches();
  applyKindToUI();
  $('page-total').textContent = 'of ' + state.pageCount;
  $('doc-name').textContent = tab.doc.name;
  $('doc-kind').textContent = tab.kind === 'markdown' ? 'MD' : 'PDF';
  $('status-file').textContent = tab.doc.name + ' · ' + formatBytes(tab.doc.size);
  document.title = tab.doc.name + ' — Quire';

  sidebar.setKind(tab.kind);
  if (tab.kind === 'markdown') sidebar.buildOutline(markdown.outline);
  else sidebar.buildThumbs();

  $('btn-edit').hidden = tab.kind !== 'markdown';
  docPanel.refresh();
  refreshMarks();

  if (restore && tab.view) restoreView(tab);
  else if (tab.kind === 'markdown') {
    markdown.setScale(1);
    markdown.gotoPage(1);
  } else {
    viewer.fitWidth();
    viewer.gotoPage(1);
  }

  annotator.redraw();
  updateSaveState();
  renderTabs();
  setStatus('');
}

/** Apply a tab's saved zoom and scroll position to the live surface. */
function restoreView(tab) {
  const view = tab.view;
  const root = $('viewer');
  if (tab.kind === 'markdown') {
    markdown.setScale(view?.scale || 1);
    markdown.fitMode = view?.fitMode || null;
    markdown.article?.classList.toggle('md-full', !!view?.full);
    root.scrollTop = view ? view.ratio * Math.max(0, root.scrollHeight - root.clientHeight) : 0;
    markdown.onScroll();
    return;
  }

  if (view?.fitMode === 'width') viewer.fitWidth();
  else if (view?.fitMode === 'page') viewer.fitPage();
  else if (view?.scale) viewer.setScale(view.scale);
  else viewer.fitWidth();

  root.scrollTop = view ? view.ratio * Math.max(0, root.scrollHeight - root.clientHeight) : 0;
  viewer.onScroll();
  viewer.renderVisible();
}

/** Bring an already-open document to the front. */
async function activateTab(id) {
  if (!id || id === activeTabId) return;
  const target = tabs.find((tab) => tab.id === id);
  if (!target) return;

  const token = ++switchSeq;
  await detachActiveTab();
  if (token !== switchSeq) return;

  activeTabId = id;
  renderTabs();
  try {
    await loadTab(target);
  } catch (err) {
    console.error(err);
    toast('Could not switch to ' + (target.doc?.name || 'that document'));
  }
}

/** Close one tab. The last one returns the app to the welcome screen. */
async function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const isActive = id === activeTabId;
  const closing = tabs[index];
  if (closing.kind === 'image' && (isActive ? state.edited : closing.edited) && !confirm('Discard unexported image edits?')) return;

  if (isActive) {
    closeNoteEditor();
    if (sourceEditor.open) {
      try { await sourceEditor.flush(); } catch (err) { console.warn('editor flush failed', err); }
      hideSourceEditor();
    }
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (state.doc && state.dirty) {
      try { await saveMarks(); } catch (err) { console.warn('marks save failed', err); }
    }
  }

  tabs.splice(index, 1);
  if (!isActive) { renderTabs(); return; }

  activeTabId = null;
  if (!tabs.length) { resetToWelcome(); return; }

  const next = tabs[Math.min(index, tabs.length - 1)];
  activeTabId = next.id;
  renderTabs();
  try {
    await loadTab(next);
  } catch (err) {
    console.error(err);
    toast('Could not open ' + next.doc.name);
    tabs = tabs.filter((tab) => tab.id !== next.id);
    activeTabId = null;
    if (tabs.length) {
      activeTabId = tabs[0].id;
      await loadTab(activeTab());
    } else {
      resetToWelcome();
    }
  }
}

function closeActiveTab() {
  if (activeTabId) return closeTab(activeTabId);
  return closeDocument();
}

function cycleTab(direction) {
  if (tabs.length < 2) return;
  const index = tabs.findIndex((tab) => tab.id === activeTabId);
  const next = tabs[(index + direction + tabs.length) % tabs.length];
  if (next) activateTab(next.id);
}

/** Rebuild the document tab strip from the open tabs. */
function renderTabs() {
  const strip = $('doc-tabs');
  if (!strip) return;
  strip.replaceChildren();

  for (const tab of tabs) {
    const item = document.createElement('div');
    item.className = 'doc-tab'
      + (tab.id === activeTabId ? ' active' : '')
      + (tab.dirty || (tab.kind === 'image' && tab.edited) ? ' has-dirty' : '');
    item.dataset.tabId = tab.id;
    item.title = tab.doc.path;
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-selected', tab.id === activeTabId ? 'true' : 'false');
    item.tabIndex = tab.id === activeTabId ? 0 : -1;

    const kind = document.createElement('span');
    kind.className = 'tab-kind';
    kind.textContent = tab.kind === 'image' ? 'IMG' : tab.kind === 'markdown' ? 'MD' : 'PDF';

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = tab.doc.name;

    const dirty = document.createElement('span');
    dirty.className = 'tab-dirty';
    dirty.title = 'Unsaved changes';

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.title = 'Close ' + tab.doc.name;
    close.setAttribute('aria-label', 'Close ' + tab.doc.name);
    close.textContent = '\u00d7';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    item.addEventListener('click', () => activateTab(tab.id));
    item.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      closeTab(tab.id);
    });
    item.addEventListener('keydown', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const index = tabs.findIndex((entry) => entry.id === tab.id);
        const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1]
          : tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        activateTab(next.id).then(() => $('doc-tabs').querySelector('.doc-tab.active')?.focus());
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateTab(tab.id);
      }
    });

    item.append(kind, name, dirty, close);
    strip.appendChild(item);
  }

  const active = strip.querySelector('.doc-tab.active');
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  scheduleSessionSave();
}

/** Keep the tab object in step with the live document without cloning marks. */
function syncActiveTabMeta() {
  const tab = activeTab();
  if (!tab || !state.doc) return;
  tab.doc = state.doc;
  tab.kind = state.kind;
  tab.pageCount = state.pageCount;
  tab.bytes = state.bytes;
  tab.originalBytes = state.originalBytes;
  tab.edited = state.edited;
  tab.dirty = state.dirty;
  tab.saveFile = state.saveFile;
  tab.savedAt = state.savedAt;
  if (state.kind === 'markdown' && markdown.source) tab.source = markdown.source;
}

/** Controls that only mean something for one kind of document. */
function applyKindToUI() {
  const md = state.kind === 'markdown';
  const TITLES = {
    ink: 'Ink (Ctrl+D)',
    rect: 'Rectangle (Ctrl+R)',
    ellipse: 'Ellipse (Ctrl+E)',
    arrow: 'Arrow (Ctrl+A)'
  };

  $('tab-thumbs').textContent = md ? 'Outline' : 'Pages';
  $('btn-prev').title = md ? 'Previous section (Ctrl+PageUp)' : 'Previous page (Ctrl+PageUp)';
  $('btn-next').title = md ? 'Next section (Ctrl+PageDown)' : 'Next page (Ctrl+PageDown)';
  $('page-input').ariaLabel = md ? 'Section number' : 'Page number';
  $('page-input').value = '1';
  $('status-page').textContent = `${kindWord()} 1 / ${state.pageCount}`;

  for (const kind of ['ink', 'rect', 'ellipse', 'arrow']) {
    const btn = document.querySelector(`.tool-btn[data-tool="${kind}"]`);
    btn.disabled = md;
    btn.title = md ? 'Drawing needs a PDF page' : TITLES[kind];
  }
  if (md && ['ink', 'rect', 'ellipse', 'arrow'].includes(annotator.tool)) setTool('highlight');

  // The export menu offers whatever the document on stage can actually produce.
  for (const item of $('export-menu').querySelectorAll('button')) {
    const mode = item.dataset.mode;
    item.hidden = md
      ? !(mode === 'rendered' || mode === 'html' || mode === 'marks' || mode === 'save-as')
      : !(mode === 'annot' || mode === 'flatten' || mode === 'save-as' || (mode === 'save' && state.edited));
  }
  $('export-menu').hidden = true;
}

/** Close every open tab and return to the welcome screen. */
async function closeDocument() {
  if (tabs.some((tab) => tab.kind === 'image' && (tab.id === activeTabId ? state.edited : tab.edited)) && !confirm('Discard unexported image edits?')) return;
  const tab = activeTab();
  if (tab) {
    closeNoteEditor();
    if (sourceEditor.open) {
      try { await sourceEditor.flush(); } catch (err) { console.warn('editor flush failed', err); }
      hideSourceEditor();
    }
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (state.doc && state.dirty) {
      try { await saveMarks(); } catch (err) { console.warn('marks save failed', err); }
    }
  }

  tabs = [];
  activeTabId = null;
  resetToWelcome();
}

function resetToWelcome() {
  closeNoteEditor();
  hideSourceEditor();
  clearTimeout(state.saveTimer);
  clearTimeout(state.searchTimer);
  state.saveTimer = null;
  state.searchTimer = null;

  viewer.clear();
  markdown.clear();
  imageEditor.clear();
  annotator.replace([]);
  search.reset();
  search.surface = viewer;
  annotator.surface = viewer;

  state.doc = null;
  state.kind = null;
  state.pageCount = 0;
  state.dirty = false;
  state.savedAt = null;
  state.saveFile = null;
  state.bytes = null;
  state.originalBytes = null;
  state.edited = false;
  state.docHistory = [];
  state.editor = null;

  document.body.classList.remove('has-doc', 'image-mode');
  $('image-toolbar').hidden = true;
  for (const id of ['nav-group', 'zoom-group', 'search-group', 'tools-group', 'strip']) $(id).hidden = true;
  $('doc-tabs').replaceChildren();
  $('doc-name').textContent = '';
  $('doc-kind').textContent = '';
  $('search-input').value = '';
  $('search-count').textContent = '';
  $('tab-thumbs').textContent = 'Pages';
  $('btn-edit').hidden = true;
  $('status-file').textContent = 'No document';
  $('status-msg').textContent = '';
  $('status-page').textContent = '';
  $('status-zoom').textContent = '';
  $('status-marks').textContent = '';
  $('status-selection').textContent = '';
  updateSaveState();

  sidebar.setKind('pdf');
  sidebar.observer.disconnect();
  sidebar.thumbs = [];
  sidebar.thumbsEl.replaceChildren();
  refreshMarks();
  docPanel.refresh();
  document.title = 'Quire';
  renderRecent();
  scheduleSessionSave();
}

/* -------------------------------------------------------------- annotations */

function refreshMarks() {
  sidebar.renderMarks(annotator.list);
  const n = annotator.list.length;
  $('mark-badge').textContent = String(n);
  $('mark-badge').hidden = n === 0;
  $('status-marks').textContent = n ? n + ' annotations' : '';
}

function markDirty() {
  state.dirty = true;
  updateSaveState();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveMarks(), 900);
}

function marksPayload() {
  return {
    format: 'quire-marks/1',
    savedAt: new Date().toISOString(),
    document: { path: state.doc.path, name: state.doc.name, size: state.doc.size, kind: state.kind, pageCount: state.pageCount },
    annotations: annotator.list
  };
}

async function saveMarks() {
  if (state.kind === 'image') return exportImage();
  if (!state.doc) return false;
  const file = await window.api.saveMarks(state.doc.path, marksPayload());
  state.saveFile = file;
  state.dirty = false;
  state.savedAt = new Date();
  updateSaveState();
  return file;
}

function updateSaveState() {
  const node = $('save-state');
  if (!state.doc) {
    node.textContent = '';
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.classList.toggle('dirty', state.dirty);
  if (state.kind === 'image') {
    node.textContent = state.edited ? 'unexported edits' : 'image ready';
    node.classList.toggle('dirty', state.edited);
  } else if (state.dirty) {
    node.textContent = 'unsaved changes';
  } else if (state.saveFile) {
    node.textContent = 'saved ' + shortName(state.saveFile) +
      (state.savedAt ? ' · ' + state.savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  } else {
    node.textContent = 'no sidecar yet';
  }
  syncActiveTabMeta();
  renderTabs();
}

async function exportPdf(mode, target) {
  if (!state.doc) return;
  if (state.kind === 'image') { toast('Use Export image for this tab.'); return; }

  // Markdown has no PDF objects to write: print the rendered article instead.
  if (state.kind === 'markdown') {
    const written = await window.api.printPdf(state.doc.path, target);
    if (written) toast('Wrote ' + shortName(written));
    return written;
  }

  if (!annotator.list.length) { toast('Nothing to export yet.'); return; }
  const written = await window.api.exportPdf(state.doc.path, annotator.list, mode, target);
  if (written) toast('Wrote ' + shortName(written));
  return written;
}

/* ------------------------------------------------------- document editing */

/**
 * Run structural ops against the bytes on stage, then rebuild everything that
 * depends on pages: the viewer, the thumbnails, and the marks, which follow the
 * page they were made on through the mapping the main process hands back.
 */
async function applyDocOps(ops, { after } = {}) {
  if (!state.bytes || !ops || !ops.length) return null;
  state.docHistory.push({ bytes: state.bytes, marks: annotator.list.slice(), edited: state.edited });

  let result;
  try {
    result = await window.api.docApply(state.bytes, ops);
  } catch (err) {
    state.docHistory.pop();
    toast('That change failed: ' + err.message);
    return null;
  }
  if (!result || result.error) {
    state.docHistory.pop();
    toast('That change failed: ' + (result && result.error ? result.error : 'unknown'));
    return null;
  }

  state.bytes = result.bytes;
  state.edited = true;
  annotator.replace(remapMarks(annotator.list, result.mapping));
  await reloadPdfSurface();
  refreshMarks();
  saveMarks();
  setStatus(describeOps(ops, result.report));
  await docPanel.refresh();
  if (after) after(result);
  return result;
}

/** Plain words for what just happened, with anything the engine flagged. */
function describeOps(ops, report) {
  const labels = {
    order: 'reordered pages',
    move: 'moved pages',
    reverse: 'reversed the page order',
    delete: 'deleted pages',
    duplicate: 'duplicated pages',
    insertBlank: 'inserted a blank page',
    merge: 'merged another PDF',
    rotate: 'rotated pages',
    resize: 'resized pages',
    crop: 'cropped pages',
    replace: 'replaced text',
    metadata: 'updated metadata',
    stamp: 'stamped pages',
    pageNumbers: 'numbered pages',
    formValues: 'updated form fields',
    clearForm: 'cleared the form',
    deleteXFA: 'removed the XFA layer',
    flattenForms: 'flattened the form'
  };
  const done = ops.map((op) => labels[op.op] || op.op).join(', ');
  return [done, ...(report || [])].filter(Boolean).join(' · ');
}

/**
 * Marks live on pages, and pages get deleted, copied and moved. A mark follows
 * its original page to the first new page that came from it; a mark whose page
 * is gone goes with it, and can come back with Ctrl+Z.
 */
function remapMarks(list, mapping) {
  if (!Array.isArray(mapping)) return list;
  const target = new Map();
  mapping.forEach((from, index) => {
    if (from && !target.has(from)) target.set(from, index + 1);
  });
  const out = [];
  for (const a of list) {
    if (a.segs) { out.push(a); continue; }          // Markdown marks anchor to blocks
    const page = target.get(a.page);
    if (page) out.push({ ...a, page });             // gone pages take their marks with them
  }
  return out;
}

/** Redraw the PDF from the bytes on stage, keeping the reader where they were. */
async function reloadPdfSurface() {
  const keep = Math.min(viewer.current, state.pageCount || 1);
  await viewer.load(state.bytes);
  state.pageCount = viewer.pageCount;
  $('page-total').textContent = 'of ' + state.pageCount;
  sidebar.buildThumbs();
  annotator.redraw();
  viewer.gotoPage(Math.max(1, Math.min(keep, state.pageCount)));
}

async function mergeDocument() {
  const picked = await window.api.pickPdf();
  if (!picked || picked.error) {
    if (picked && picked.error) toast(picked.error);
    return;
  }
  const at = viewer.current;
  await applyDocOps([{ op: 'merge', bytes: picked.bytes, name: picked.name, after: at }]);
}

/** Undo the last document change, or the last mark if there was one. */
async function undoAny() {
  if (annotator.canUndo()) { annotator.undo(); refreshMarks(); return; }
  const snap = state.docHistory.pop();
  if (!snap) { toast('Nothing to undo'); return; }
  state.bytes = snap.bytes;
  state.edited = snap.edited;
  annotator.replace(snap.marks);
  await reloadPdfSurface();
  refreshMarks();
  saveMarks();
  applyKindToUI();
  docPanel.refresh();
  setStatus('Undone the last document change');
}

async function revertDocument() {
  if (state.kind === 'image') return imageEditor.reset();
  if (!state.originalBytes) return;
  state.bytes = state.originalBytes;
  state.edited = false;
  state.docHistory = [];
  await reloadPdfSurface();
  applyKindToUI();
  docPanel.refresh();
  setStatus('Back to the file on disk; your marks are untouched');
}

/** Save the document itself, not just the marks beside it. */
async function saveDocument({ ask = false } = {}) {
  if (!state.doc) return null;
  if (state.kind === 'image') return exportImage();

  if (state.kind === 'markdown') {
    sourceEditor.flush();
    const text = sourceEditor.open ? sourceEditor.value : markdown.source;
    const written = await window.api.writeMarkdown(state.doc.path, text, ask);
    if (!written || written.error) {
      if (written) toast(written.error);
      return null;
    }
    if (written !== state.doc.path) {
      state.doc = { ...state.doc, path: written, name: shortName(written), size: text.length };
      $('doc-name').textContent = state.doc.name;
    } else {
      state.doc = { ...state.doc, size: text.length };
    }
    $('status-file').textContent = state.doc.name + ' · ' + formatBytes(state.doc.size);
    toast('Saved ' + shortName(written));
    setStatus('Saved ' + shortName(written));
    return written;
  }

  if (!state.bytes) return null;
  const written = await window.api.docSave(ask ? null : state.doc.path, state.bytes);
  if (!written || written.error) {
    if (written) toast(written.error);
    return null;
  }
  state.originalBytes = state.bytes;
  state.edited = false;
  state.doc = { ...state.doc, path: written, name: shortName(written), size: state.bytes.length };
  $('doc-name').textContent = state.doc.name;
  $('status-file').textContent = state.doc.name + ' · ' + formatBytes(state.doc.size);
  applyKindToUI();
  await saveMarks();
  toast('Saved ' + shortName(written));
  setStatus('Saved ' + shortName(written));
  return written;
}

async function exportImage(target) {
  if (state.kind !== 'image') return null;
  const file = await window.api.pickImageSave(state.doc.path, target);
  if (!file) return null;
  const ext = file.split('.').pop().toLowerCase();
  const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  try {
    const written = await window.api.saveImage(file, await imageEditor.encode(type));
    if (written?.error) { toast(written.error); return null; }
    state.edited = false;
    updateSaveState();
    toast('Exported ' + shortName(written));
    return written;
  } catch (err) { toast('Could not export image: ' + err.message); return null; }
}

async function copyImage() {
  if (state.kind !== 'image') return;
  try {
    const result = await window.api.copyImage(await imageEditor.encode('image/png'));
    if (result?.error) { toast('Could not copy image: ' + result.error); return; }
    toast('Image copied to clipboard');
  } catch (err) { toast('Could not copy image: ' + err.message); }
}

async function newDocument() {
  const created = await window.api.newDocument();
  if (!created || created.error) {
    if (created) toast(created.error);
    return;
  }
  await openDocument(created, 'pdf');
  setStatus('Blank page — write it with the Document tab');
}

/* -------------------------------------------------------- markdown source */

function showSourceEditor() {
  if (state.kind !== 'markdown' || !state.doc) return;
  $('viewer').classList.add('source-mode');
  $('btn-edit').classList.add('active');
  sourceEditor.show({ text: markdown.source, path: state.doc.path, name: state.doc.name });
}

function hideSourceEditor() {
  $('viewer').classList.remove('source-mode');
  $('btn-edit').classList.remove('active');
  sourceEditor.hide();
}

function showRendered() {
  sourceEditor.flush();
  hideSourceEditor();
}

/** Write the edited source and re-render, so marks re-anchor to the new text. */
async function writeMarkdown(text) {
  const written = await window.api.writeMarkdown(state.doc.path, text);
  if (!written || written.error) {
    if (written) toast(written.error);
    return null;
  }
  state.doc = { ...state.doc, size: text.length };
  $('status-file').textContent = state.doc.name + ' · ' + formatBytes(state.doc.size);
  sourceEditor.reset(text);
  await reloadMarkdown(text);
  setStatus('Saved ' + shortName(written));
  return written;
}

async function reloadMarkdown(text) {
  const keep = markdown.current;
  await markdown.load({ text, path: state.doc.path, name: state.doc.name });
  const { moved, lost } = markdown.reanchor(annotator.list);
  state.pageCount = markdown.pageCount;
  $('page-total').textContent = 'of ' + state.pageCount;
  sidebar.buildOutline(markdown.outline);
  sidebar.setCurrent(keep);
  search.surface = markdown;
  search.reset();
  $('search-count').textContent = '';
  annotator.redraw();
  refreshMarks();
  if (moved || lost) {
    saveMarks();
    setStatus(moved + ' mark(s) re-anchored' + (lost ? ', ' + lost + ' lost their text' : ''));
  }
}

/* ---------------------------------------------------------------- exports */

/** What the export menu means, for the document that is open. */
async function runExport(mode) {
  if (state.kind === 'image') return exportImage();
  if (!state.doc) return;
  if (mode === 'save') return saveDocument();
  if (mode === 'save-as') return saveDocument({ ask: true });
  if (mode === 'html') return exportHtml();
  if (mode === 'marks') return exportMarksMarkdown();
  const as = state.kind === 'markdown' ? 'rendered' : mode;
  return exportPdf(as);
}

/** A self-contained HTML file: the rendered article, images inlined. */
async function exportHtml() {
  if (state.kind !== 'markdown') { toast('HTML export is for Markdown documents'); return; }
  const html = await markdown.toHtml();
  const written = await window.api.writeText(state.doc.path, html, 'html', ['html', 'htm']);
  if (written) toast('Wrote ' + shortName(written));
  return written;
}

/** Every mark as a readable Markdown list, next to the document. */
async function exportMarksMarkdown() {
  if (!state.doc) return;
  if (!annotator.list.length) { toast('No marks to export yet'); return; }
  const written = await window.api.writeText(state.doc.path, marksMarkdown(), 'marks', ['md', 'txt']);
  if (written) toast('Wrote ' + shortName(written));
  return written;
}

const MARK_LABELS = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'Strikethrough',
  rect: 'Rectangle', ellipse: 'Ellipse', arrow: 'Arrow', ink: 'Ink', note: 'Note'
};

function marksMarkdown() {
  const doc = state.doc;
  const lines = [
    '# Marks — ' + doc.name,
    '',
    `${annotator.list.length} mark(s) · ${state.pageCount} page(s) · exported ${new Date().toISOString()}`,
    ''
  ];
  const groups = new Map();
  for (const mark of annotator.list) {
    const key = state.kind === 'markdown' ? sectionFor(mark) : 'Page ' + mark.page;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(mark);
  }
  for (const [key, marks] of groups) {
    lines.push('## ' + key, '');
    for (const mark of marks) {
      const label = MARK_LABELS[mark.kind] || mark.kind;
      const bits = [];
      if (mark.text) bits.push('“' + mark.text.replace(/\s+/g, ' ').trim() + '”');
      if (mark.note) bits.push('_' + mark.note.replace(/\s+/g, ' ').trim() + '_');
      if (mark.color) bits.push(mark.color);
      if (mark.kind === 'ink' && mark.points) bits.push(mark.points.length + ' points');
      lines.push('- **' + label + '**' + (bits.length ? ' — ' + bits.join(' · ') : ''));
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** The heading a Markdown mark sits under, so the export reads like the document. */
function sectionFor(mark) {
  const block = mark.anchor && mark.anchor.block;
  if (typeof block !== 'number') return 'Document';
  for (let i = Math.min(block, markdown.blocks.length - 1); i >= 0; i--) {
    const node = markdown.blocks[i];
    if (node && /^H[1-6]$/.test(node.tagName)) return node.textContent.trim() || 'Untitled';
  }
  return 'Before the first heading';
}

/* ------------------------------------------------------------------ print */

function openPrintDialog() {
  if (!state.doc) { toast('Nothing open to print'); return; }
  $('po-note').textContent = state.kind === 'markdown'
    ? 'The article as it is displayed, paginated to the paper you pick. Marks print with it.'
    : 'The PDF pages as displayed, one page per sheet. Marks print with them.';
  $('print-options').showModal();
}

async function runPrint() {
  if (!state.doc) return;
  const options = {
    orientation: $('po-orientation').value,
    paper: $('po-paper').value,
    margins: $('po-margins').value,
    background: $('po-bg').checked
  };
  $('print-options').close();
  const written = await window.api.printPdf(state.doc.path, null, options);
  if (written) toast('Wrote ' + shortName(written));
}

/* ------------------------------------------------------------- note editor */

function openNoteEditor(note, { create = false } = {}) {
  closeNoteEditor();

  const host = noteEditorHost(note);
  if (!host) return;

  const box = document.createElement('div');
  box.className = 'note-editor' + (host.floating ? ' floating' : '');
  box.style.left = host.x + 'px';
  box.style.top = host.y + 'px';

  const area = document.createElement('textarea');
  area.value = note.text || '';
  area.placeholder = 'Write a note…';

  const row = document.createElement('div');
  row.className = 'row';
  const del = button('Delete', 'btn ghost danger');
  const cancel = button('Cancel', 'btn ghost');
  const save = button('Save', 'btn primary');

  del.addEventListener('click', () => { annotator.remove(note.id); closeNoteEditor(); });
  cancel.addEventListener('click', () => {
    // Cancel discards: a note that never had a committed text goes with it.
    if (create) annotator.remove(note.id);
    closeNoteEditor();
  });
  save.addEventListener('click', () => commitNote(note, area.value.trim(), create));
  area.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') cancel.click();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click();
  });

  box.append(area, row);
  row.append(del, cancel, save);
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  box.addEventListener('click', (e) => e.stopPropagation());
  host.parent.appendChild(box);
  area.focus();
  state.editor = { box, note };
}

/**
 * Where the editor sits. On a PDF page it hangs under the pin in page space;
 * Markdown has no page shell, so it floats next to the anchored block.
 */
function noteEditorHost(note) {
  if (state.kind === 'markdown') {
    const anchor = markdown.pinFor(note.id) || markdown.blocks[note.anchor?.block ?? 0] || markdown.article;
    if (!anchor) return null;
    const r = anchor.getBoundingClientRect();
    return {
      parent: document.body,
      floating: true,
      x: clamp(r.left, 8, window.innerWidth - 300),
      y: clamp(r.bottom + 10, 8, window.innerHeight - 200)
    };
  }
  const page = viewer.pages[note.page - 1];
  if (!page) return null;
  return {
    parent: page.shell,
    x: Math.min(Math.max(note.x * viewer.scale, 4), page.w * viewer.scale - 268),
    y: note.y * viewer.scale + 16
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function commitNote(note, text, create) {
  if (create && !text) { annotator.remove(note.id); }
  else annotator.mutate(() => { note.text = text; });
  closeNoteEditor();
}

function closeNoteEditor() {
  state.editor?.box.remove();
  state.editor = null;
}

function button(label, cls) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  return b;
}

/* ------------------------------------------------------------------ tools */

function setTool(tool) {
  if (state.kind === 'image') return;
  if (state.kind === 'markdown' && (tool === 'ink' || tool === 'rect')) {
    toast('Ink and shapes need a PDF page.');
    return;
  }
  annotator.setTool(tool);
  for (const node of document.querySelectorAll('.tool-btn')) {
    node.classList.toggle('active', node.dataset.tool === tool);
  }
  renderSwatches();
}

function renderSwatches() {
  const wrap = $('swatches');
  wrap.replaceChildren();
  $('width-ctl').hidden = !WEIGHT_TOOLS.has(annotator.tool);
  const palette = PALETTES[annotator.tool];
  if (!palette) return;

  for (const color of palette) {
    const sw = document.createElement('button');
    sw.className = 'swatch' + (annotator.colors[annotator.tool] === color ? ' active' : '');
    sw.style.setProperty('--sw', color);
    sw.title = color;
    sw.addEventListener('click', () => {
      annotator.colors[annotator.tool] = color;
      renderSwatches();
    });
    wrap.appendChild(sw);
  }
}

/* ----------------------------------------------------------------- search */

function runSearch() {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(async () => {
    // Read the box when the debounce fires: a queued run must not search a
    // query the user has since edited or cleared.
    const q = $('search-input').value;
    search.reset();
    $('search-count').textContent = q ? '…' : '';
    if (!q.trim()) return;
    await search.run(q, {
      onProgress: ({ scanned, total, hits }) => {
        $('search-count').textContent = `scanned ${scanned}/${total} · ${hits}`;
      },
      onDone: (hits) => {
        $('search-count').textContent = hits.length ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : 'no matches';
        if (hits.length) { search.cursor = -1; search.jump(search.step(1)); }
      }
    });
  }, 260);
}

async function searchStep(direction) {
  const hit = search.step(direction);
  if (!hit) { toast(search.hits.length ? 'No matches' : 'Type something to search'); return; }
  $('search-count').textContent = `${search.cursor + 1} of ${search.hits.length}`;
  await search.jump(hit);
}

/* -------------------------------------------------------------- shortcuts */

const HANDLES = [
  ['Ctrl+1', () => setTool('select')],
  ['Ctrl+2', () => setTool('highlight')],
  ['Ctrl+3', () => setTool('underline')],
  ['Ctrl+4', () => setTool('eraser')],
  ['Ctrl+O', () => openDialog()],
  ['Ctrl+N', () => newDocument()],
  ['Ctrl+S', () => saveMarks().then((f) => f && toast('Saved ' + shortName(f)))],
  ['Ctrl+Shift+S', () => saveDocument()],
  ['Ctrl+Shift+O', () => revertDocument()],
  ['Ctrl+Shift+E', () => exportPdf(state.kind === 'markdown' ? 'rendered' : 'annot')],
  ['Ctrl+Shift+B', () => exportPdf(state.kind === 'markdown' ? 'rendered' : 'flatten')],
  ['Ctrl+Shift+X', () => exportPdf('rendered')],
  ['Ctrl+Shift+H', () => exportHtml()],
  ['Ctrl+Shift+M', () => exportMarksMarkdown()],
  ['Ctrl+F', () => { $('search-group').hidden = false; $('search-input').focus(); $('search-input').select(); }],
  ['Ctrl+Z', () => undoAny()],
  ['Ctrl+Shift+Z', () => { annotator.redo(); refreshMarks(); }],
  ['Ctrl+H', () => setTool('highlight')],
  ['Ctrl+U', () => setTool('underline')],
  ['Ctrl+K', () => setTool('strikeout')],
  ['Ctrl+M', () => setTool('note')],
  ['Ctrl+D', () => setTool('ink')],
  ['Ctrl+R', () => setTool('rect')],
  ['Ctrl+E', () => setTool('ellipse')],
  ['Ctrl+Shift+A', () => setTool('arrow')],
  ['Ctrl+B', () => document.body.classList.toggle('no-sidebar')],
  ['Ctrl+G', () => { $('page-input').focus(); $('page-input').select(); }],
  ['Ctrl+=', () => surface().zoomBy(1.15)],
  ['Ctrl+-', () => surface().zoomBy(1 / 1.15)],
  ['Ctrl+0', () => surface().zoomReset()],
  ['Ctrl+Shift+F', () => surface().fitWidth()],
  ['Ctrl+Shift+P', () => surface().fitPage()],
  ['Ctrl+PageDown', () => stepPage(1)],
  ['Ctrl+PageUp', () => stepPage(-1)],
  ['Ctrl+Shift+L', () => toggleTheme()],
  ['Ctrl+P', () => openPrintDialog()],
  ['Ctrl+/', () => $('help').showModal()],
  ['Ctrl+,', () => { if (!$('preferences').open) $('preferences').showModal(); }],
  ['Ctrl+W', () => closeActiveTab()],
  ['Escape', () => {
    // preventDefault() above stops a dialog closing itself, so close it here.
    const open = document.querySelector('dialog[open]');
    if (open) { open.close(); return; }
    if (!$('export-menu').hidden) { $('export-menu').hidden = true; return; }
    closeNoteEditor();
    $('search-input').blur();
    window.getSelection()?.removeAllRanges();
  }]
];

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName || '';
  if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
    return;
  }
  if (tag === 'TEXTAREA') return;                       // the note editor owns its keys
  // Plain typing in a field is text, not a shortcut; Ctrl+ combos still work.
  if ((tag === 'INPUT' || tag === 'SELECT') && !(e.ctrlKey || e.metaKey) && e.key !== 'Escape') return;
  const combo = (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + keyName(e);
  if (state.kind === 'image') {
    if (e.key === 'Escape' && imageEditor.mode === 'crop' && imageEditor.selection) { e.preventDefault(); imageEditor.setSelection(null); return; }
    if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'INPUT' && tag !== 'SELECT' && imageEditor.mode === 'crop' && imageEditor.selection) { e.preventDefault(); $('viewer').querySelector('#image-crop').click(); return; }
    const imageKeys = { 'Ctrl+S': () => exportImage(), 'Ctrl+Shift+S': () => exportImage(), 'Ctrl+Z': () => imageEditor.undo(), 'Ctrl+Shift+Z': () => imageEditor.redo(), 'Ctrl+W': () => closeActiveTab() };
    if (imageKeys[combo]) { e.preventDefault(); imageKeys[combo](); return; }
  }
  const hit = HANDLES.find(([name]) => name.toLowerCase() === combo.toLowerCase());
  if (!hit) return;
  e.preventDefault();
  hit[1]();
});

function keyName(e) {
  if (e.key === 'Escape') return 'Escape';
  if (e.key === '=' || e.key === '+') return '=';
  if (e.key === '-') return '-';
  if (/^[a-z]$/.test(e.key)) return e.key.toUpperCase();
  return e.key;
}

/* --------------------------------------------------------- menu commands */

window.api.onCommand(({ command, payload }) => {
  switch (command) {
    case 'open': openDialog(); break;
    case 'open-path': openPath(payload); break;
    case 'save-marks': if (state.kind === 'image') exportImage(); else saveMarks().then((f) => f && toast('Saved ' + shortName(f))); break;
    case 'save-document': saveDocument(); break;
    case 'revert': revertDocument(); break;
    case 'new-document': newDocument(); break;
    case 'export': runExport(payload); break;
    case 'print': openPrintDialog(); break;
    case 'close': closeActiveTab(); break;
    case 'undo': if (state.kind === 'image') imageEditor.undo(); else undoAny(); break;
    case 'redo': if (state.kind === 'image') imageEditor.redo(); else { annotator.redo(); refreshMarks(); } break;
    case 'tool': setTool(payload); break;
    case 'toggle-sidebar': document.body.classList.toggle('no-sidebar'); break;
    case 'search-focus': $('search-input').focus(); break;
    case 'zoom':
      if (payload === 'in') surface().zoomBy(1.15);
      else if (payload === 'out') surface().zoomBy(1 / 1.15);
      else if (payload === 'reset') surface().zoomReset();
      else if (payload === 'width') surface().fitWidth();
      else if (payload === 'page') surface().fitPage();
      break;
    case 'goto-prompt': $('page-input').focus(); $('page-input').select(); break;
    case 'page': stepPage(payload === 'next' ? 1 : -1); break;
    case 'theme': toggleTheme(); break;
    case 'help': $('help').showModal(); break;
    case 'preferences': if (!$('preferences').open) $('preferences').showModal(); break;
  }
});

/* ------------------------------------------------------------ ui wiring */

$('btn-open').addEventListener('click', openDialog);
$('image-rotate-left').addEventListener('click', () => imageEditor.rotate(-1));
$('image-rotate-right').addEventListener('click', () => imageEditor.rotate(1));
$('image-flip-h').addEventListener('click', () => imageEditor.flip(true));
$('image-flip-v').addEventListener('click', () => imageEditor.flip(false));
$('image-undo').addEventListener('click', () => imageEditor.undo());
$('image-redo').addEventListener('click', () => imageEditor.redo());
$('image-reset').addEventListener('click', () => imageEditor.reset());
$('image-zoom-out').addEventListener('click', () => imageEditor.zoomBy(1 / 1.15));
$('image-zoom-in').addEventListener('click', () => imageEditor.zoomBy(1.15));
$('image-fit').addEventListener('click', () => imageEditor.fitPage());
$('image-export').addEventListener('click', () => exportImage());
$('image-copy').addEventListener('click', copyImage);
$('btn-preferences').addEventListener('click', () => $('preferences').showModal());
$('pref-restore').addEventListener('change', savePreferencesFromControls);
$('pref-position').addEventListener('change', savePreferencesFromControls);
$('pref-theme').addEventListener('change', savePreferencesFromControls);
$('welcome-open').addEventListener('click', openDialog);
$('welcome-new').addEventListener('click', newDocument);
$('btn-prev').addEventListener('click', () => stepPage(-1));
$('btn-next').addEventListener('click', () => stepPage(1));
$('btn-zoom-in').addEventListener('click', () => surface().zoomBy(1.15));
$('btn-zoom-out').addEventListener('click', () => surface().zoomBy(1 / 1.15));
$('zoom-label').addEventListener('click', () => surface().zoomReset());
$('btn-fit-width').addEventListener('click', () => surface().fitWidth());
$('btn-fit-page').addEventListener('click', () => surface().fitPage());
$('btn-undo').addEventListener('click', () => undoAny());
$('btn-redo').addEventListener('click', () => { annotator.redo(); refreshMarks(); });
$('btn-save').addEventListener('click', () => saveMarks().then((f) => f && toast('Saved ' + shortName(f))));
$('btn-theme').addEventListener('click', toggleTheme);
$('btn-sidebar').addEventListener('click', () => document.body.classList.toggle('no-sidebar'));
$('btn-edit').addEventListener('click', () => {
  if (sourceEditor.open) showRendered();
  else showSourceEditor();
});

$('po-cancel').addEventListener('click', () => $('print-options').close());
$('po-print').addEventListener('click', runPrint);

$('page-input').addEventListener('change', () => {
  const n = parseInt($('page-input').value, 10);
  if (Number.isFinite(n)) surface().gotoPage(n);
});

for (const node of document.querySelectorAll('.tool-btn')) {
  node.addEventListener('click', () => setTool(node.dataset.tool));
}

$('ink-width').addEventListener('input', (e) => {
  annotator.inkWidth = Number(e.target.value);
  $('ink-width-label').textContent = e.target.value + ' pt';
});

$('btn-export').addEventListener('click', (e) => {
  e.stopPropagation();
  $('export-menu').hidden = !$('export-menu').hidden;
});
for (const node of $('export-menu').querySelectorAll('button')) {
  node.addEventListener('click', () => {
    $('export-menu').hidden = true;
    runExport(node.dataset.mode);
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#export-menu')) $('export-menu').hidden = true;
});

$('search-input').addEventListener('input', () => runSearch());
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); searchStep(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') {
    clearTimeout(state.searchTimer);
    e.target.value = '';
    search.reset();
    $('search-count').textContent = '';
    e.target.blur();
  }
});
$('btn-search-next').addEventListener('click', () => searchStep(1));
$('btn-search-prev').addEventListener('click', () => searchStep(-1));

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const pane of document.querySelectorAll('.pane')) pane.classList.toggle('active', pane.id === 'pane-' + tab.dataset.tab);
    if (tab.dataset.tab === 'doc') docPanel.refresh();
  });
}

window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const path = file.path || window.api.getPathForFile?.(file);
  if (path) await openPath(path);
});

viewer.on('page', onPage);
viewer.on('scale', onScale);
markdown.on('page', onPage);
markdown.on('scale', onScale);

function onPage(num) {
  $('page-input').value = String(num);
  $('status-page').textContent = `${kindWord()} ${num} / ${state.pageCount}`;
  sidebar.setCurrent(num);
}

function onScale(scale) {
  const pct = Math.round(scale * 100) + '%';
  $('zoom-label').textContent = pct;
  $('status-zoom').textContent = pct;
  annotator.redraw();
  surface().refit();
  scheduleSessionSave();
}

window.addEventListener('resize', () => surface().refit());
$('viewer').addEventListener('scroll', scheduleSessionSave, { passive: true });

// Closing the window must not lose the last few marks; sendSync blocks briefly.
window.addEventListener('beforeunload', (event) => {
  clearTimeout(state.saveTimer);
  if (state.doc && state.dirty) window.api.saveMarksSync(state.doc.path, marksPayload());
  saveSession();
  if (tabs.some((tab) => tab.kind === 'image' && (tab.id === activeTabId ? state.edited : tab.edited))) event.returnValue = false;
});

/* ------------------------------------------------------------------ misc */

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  preferences.theme = next;
  $('pref-theme').value = next;
  persistPreferences();
}

function sanitizeView(view) {
  if (!view || typeof view !== 'object') return null;
  const result = {};
  if (Number.isFinite(view.ratio)) result.ratio = Math.max(0, Math.min(1, view.ratio));
  if (Number.isFinite(view.scale) && view.scale > 0) result.scale = Math.max(0.05, Math.min(8, view.scale));
  if (Number.isFinite(view.page) && view.page > 0) result.page = Math.floor(view.page);
  if (view.fitMode === 'width' || view.fitMode === 'page') result.fitMode = view.fitMode;
  if (view.full) result.full = true;
  return result;
}

function scheduleSessionSave() {
  if (restoringSession || !preferences.restoreSession) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSession, 350);
}

function saveSession() {
  if (restoringSession) return;
  clearTimeout(sessionTimer);
  const active = activeTab();
  if (active && state.doc?.path && samePath(active.doc.path, state.doc.path)) active.view = captureView();
  const entries = preferences.restoreSession ? tabs.filter((tab) => tab.doc?.path).map((tab) => ({ path: tab.doc.path, view: preferences.rememberPosition ? sanitizeView(tab.view) : null })) : [];
  const result = window.api.saveSessionSync({ tabs: entries, activePath: preferences.restoreSession ? active?.doc?.path || null : null });
  if (result?.error) {
    console.warn('Could not save session:', result.error);
    if (!sessionSaveWarned) toast('Could not save the workspace: ' + result.error);
    sessionSaveWarned = true;
  } else sessionSaveWarned = false;
}

async function persistPreferences() {
  try {
    const result = await window.api.savePreferences(preferences);
    if (result?.error) toast('Could not save preferences: ' + result.error);
  } catch (err) { toast('Could not save preferences: ' + err.message); }
}

function savePreferencesFromControls() {
  preferences = { theme: $('pref-theme').value, restoreSession: $('pref-restore').checked, rememberPosition: $('pref-position').checked };
  document.documentElement.dataset.theme = preferences.theme;
  $('pref-position').disabled = !preferences.restoreSession;
  persistPreferences();
  saveSession();
}

function setStatus(text) { $('status-msg').textContent = text; }

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function quote(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 90 ? oneLine.slice(0, 90) + '…' : oneLine;
}

function shortName(filePath) {
  return String(filePath).split(/[\\/]/).pop();
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

async function renderRecent() {
  const list = await window.api.recentList();
  if (!list.length) return;
  const wrap = $('recent-list');
  wrap.innerHTML = '<h3>Recent</h3>';
  for (const entry of list) {
    const b = document.createElement('button');
    b.textContent = entry.name + (entry.size ? ' · ' + formatBytes(entry.size) : '');
    b.title = entry.path;
    b.addEventListener('click', () => openPath(entry.path));
    wrap.appendChild(b);
  }
}

/* ------------------------------------------------------------------- boot */

$('help-table').innerHTML = SHORTCUTS.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join('');
setTool('highlight');
renderRecent();

// reachable from the console and from the e2e test
window.__quire = {
  viewer, markdown, annotator, search, sidebar, state, surface, docPanel, sourceEditor,
  openPath, closeDocument, exportPdf, saveMarks, setTool, runExport,
  applyDocOps, saveDocument, revertDocument, marksMarkdown, remapMarks, imageEditor, exportImage, copyImage
};

const boot = await window.api.boot();
preferences = boot.preferences || preferences;
document.documentElement.dataset.theme = preferences.theme;
$('pref-theme').value = preferences.theme;
$('pref-restore').checked = preferences.restoreSession;
$('pref-position').checked = preferences.rememberPosition;
$('pref-position').disabled = !preferences.restoreSession;
if (preferences.restoreSession && Array.isArray(boot.session?.tabs)) {
  let missed = 0;
  for (const entry of boot.session.tabs.slice(0, 30)) {
    if (typeof entry?.path !== 'string') continue;
    if (!await openPath(entry.path, { view: preferences.rememberPosition ? sanitizeView(entry.view) : null, quiet: true })) missed++;
  }
  const target = tabs.find((tab) => boot.session.activePath && samePath(tab.doc.path, boot.session.activePath));
  if (target) await activateTab(target.id);
  if (missed) toast(`Could not reopen ${missed} file${missed === 1 ? '' : 's'}.`);
}
if (boot.initialFile) await openPath(boot.initialFile);
restoringSession = false;
saveSession();
document.body.dataset.ready = 'true';
