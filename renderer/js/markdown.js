/**
 * Markdown surface.
 *
 * Renders CommonMark + GFM through marked, with $…$ / $$…$$ mathematics
 * typeset by KaTeX, and behaves like a document surface for the rest of the
 * app: search reads its plain text, annotations are anchored to top-level
 * blocks, zoom scales the type, and the outline plays the role of pages.
 *
 * Annotation anchors for this surface are { block, start, end }: the index of
 * a top-level block element and character offsets inside that block's text.
 * That survives reload of the same file because the block order is stable.
 */
import { marked } from '/vendor/marked/lib/marked.esm.js';
import katex from '/vendor/katex/katex.mjs';

const MATH_TOKEN = /%%qmath(\d+)%%/g;
const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'LINK', 'META', 'IFRAME', 'OBJECT', 'EMBED', 'BASE',
  'FORM', 'INPUT', 'BUTTON', 'AUDIO', 'VIDEO', 'SOURCE', 'TEMPLATE', 'NOSCRIPT'
]);
const KEEP_ATTR = /^(href|src|alt|title|class|id|style|width|height|align|colspan|rowspan|start|type|lang|dir)$/i;
const MIN_SCALE = 0.6;
const MAX_SCALE = 3;

export class MarkdownDoc {
  /**
   * @param {HTMLElement} root scroll container (the same element the PDF pages use)
   * @param {{annotator: object, hooks: {openExternal: Function, openFile: Function}}} opts
   */
  constructor(root, { annotator, hooks = {} }) {
    this.root = root;
    this.annotator = annotator;
    this.hooks = hooks;
    this.mode = 'markdown';
    this.article = null;
    this.blocks = [];
    this.outline = [];
    this.path = null;
    this.dir = null;
    this.name = '';
    this.current = 1;
    this.scale = 1;
    this.fitMode = null;
    this._navTo = 0;
    this._navTimer = null;
    this.events = new Map();
    this._text = null;
    this.source = '';

    root.addEventListener('scroll', () => this.onScroll(), { passive: true });
    root.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    this.bindInteraction();
  }

  on(name, fn) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(fn);
  }

  emit(name, payload) {
    for (const fn of this.events.get(name) || []) fn(payload);
  }

  get doc() { return this.article ? { path: this.path } : null; }
  get pageCount() { return Math.max(1, this.outline.length); }
  get pages() { return this.article ? [this.article] : []; }

  /* ----------------------------------------------------------------- load */

  async load({ text, path, name }) {
    this.clear();
    this.path = path;
    this.dir = path.replace(/[\\/][^\\/]+$/, '');
    this.name = name;
    this.source = text;

    const { text: src, math } = protectMath(text);
    const html = marked.parse(src, { gfm: true, breaks: false });
    const parsed = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
    sanitize(parsed.body);

    const article = document.createElement('article');
    article.className = 'md-article';
    article.dataset.surface = 'markdown';
    while (parsed.body.firstChild) article.appendChild(parsed.body.firstChild);

    this.root.appendChild(article);
    this.article = article;
    this.blocks = [...article.children];
    this.resolveAssets(article);
    typesetMath(article, math);
    this.buildOutline(article);
    this.renderAnnotations(this.annotator.list);
    this.setScale(this.scale);
    this.root.scrollTop = 0;
    this.onScroll();
    return { pageCount: this.pageCount };
  }

  clear() {
    this.article?.remove();
    this.article = null;
    this.blocks = [];
    this.outline = [];
    this._text = null;
    this._navTo = 0;
    clearTimeout(this._navTimer);
    this.current = 1;
  }

  /** Relative images and links become local server URLs or app actions. */
  resolveAssets(article) {
    for (const img of article.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (/^(https?:|data:)/i.test(src) || src.startsWith('/local')) continue;
      img.setAttribute('src', '/local?path=' + encodeURIComponent(joinPath(this.dir, src)));
      img.setAttribute('loading', 'lazy');
    }
    for (const a of article.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (/^https?:/i.test(href) || href.startsWith('mailto:')) a.setAttribute('target', '_external');
      else if (!href.startsWith('#')) a.setAttribute('href', joinPath(this.dir, href));
    }
  }

  buildOutline(article) {
    this.outline = [];
    let n = 0;
    for (const h of article.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      n += 1;
      h.id = 'quire-h' + n;
      this.outline.push({ index: n, level: Number(h.tagName[1]), text: h.textContent.trim(), el: h });
    }
  }

  /* ----------------------------------------------------------------- text */

  /**
   * Plain text of the article plus the text nodes that produced it, so a
   * character offset can be turned back into a DOM range.
   */
  walk() {
    const parts = [];
    const segs = [];
    if (!this.article) return { str: '', segs };
    for (const block of this.blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue) continue;
        segs.push({ node, start: parts.length, block });
        parts.push(node.nodeValue);
      }
      parts.push('\n');
    }
    return { str: parts.join(''), segs };
  }

  async searchText() {
    if (this._text === null) this._text = this.walk().str;
    return this._text;
  }

  /* ----------------------------------------------------------------- zoom */

  setScale(scale) {
    this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    this.article?.style.setProperty('--md-scale', String(this.scale));
    this.emit('scale', this.scale);
  }

  zoomBy(factor) {
    this.fitMode = null;
    this.article?.classList.remove('md-full');
    this.setScale(this.scale * factor);
  }

  zoomReset() {
    this.fitMode = null;
    this.article?.classList.remove('md-full');
    this.setScale(1);
  }

  /** Fit width stretches the measure to the pane; fit page returns to the column. */
  fitWidth() {
    this.fitMode = 'width';
    this.article?.classList.add('md-full');
    this.emit('scale', this.scale);
  }

  fitPage() {
    this.fitMode = null;
    this.article?.classList.remove('md-full');
    this.setScale(1);
  }

  refit() {
    // Width fit on Markdown is a CSS class, so there is nothing to recompute.
    // Re-emitting 'scale' from the scale handler would recurse forever.
  }

  /* --------------------------------------------------------------- scroll */

  gotoPage(num) {
    if (!this.article) return;
    const n = clamp(num, 1, this.pageCount);
    const target = this.outline[n - 1]?.el || this.blocks[0];
    // A jump animates, and the frames during it still report the section being
    // left, so hold the requested section until the scroll settles on it.
    this._navTo = n;
    clearTimeout(this._navTimer);
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    this.setCurrent(n);
  }

  nextSection() { this.gotoPage(this.current + 1); }
  prevSection() { this.gotoPage(Math.max(1, this.current - 1)); }

  /** Search lands on a hit: bring its section into view and report it. */
  revealPage(num) {
    this.gotoPage(num);
    return true;
  }

  /**
   * Re-anchor marks after the source has been edited.
   *
   * Marks point at a block index and a character range; editing shifts both. A
   * mark whose range still covers real text keeps it. Otherwise the saved text
   * is searched for in the new blocks. Marks whose text has gone away lose their
   * segments but stay in the list, so nothing is silently deleted.
   */
  reanchor(list) {
    let moved = 0;
    let lost = 0;
    for (const a of list) {
      if (a.kind === 'note') {
        if (!this.blocks[a.anchor?.block ?? -1]) {
          a.anchor = { block: 0 };
          moved += 1;
        }
        continue;
      }
      if (a.kind === 'ink' || a.kind === 'rect' || a.kind === 'ellipse' || a.kind === 'arrow') continue;
      const segs = a.segs || [];
      if (!segs.length) continue;
      // A mark is still in place only when its segments spell the text it was
      // made from. Offsets alone survive an inserted block and would leave the
      // highlight sitting on unrelated prose.
      const needle = (a.text || '').trim().replace(/\s+/g, ' ');
      const spell = segs
        .map((s) => (this.blocks[s.block]?.textContent || '').slice(s.start, s.end))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!needle) {
        const intact = segs.every((s) => this.blocks[s.block] &&
          (this.blocks[s.block].textContent || '').slice(s.start, s.end).trim().length > 0);
        if (intact) continue;
      } else if (spell === needle) continue;

      if (!needle) { a.segs = []; lost += 1; continue; }
      const index = this.blocks.findIndex((b) => (b.textContent || '').includes(needle));
      if (index === -1) { a.segs = []; lost += 1; continue; }
      const at = this.blocks[index].textContent.indexOf(needle);
      a.segs = [{ block: index, start: at, end: at + needle.length }];
      if (a.anchor) a.anchor = { block: index };
      moved += 1;
    }
    return { moved, lost };
  }

  /**
   * A standalone HTML file: readable on its own, with local images inlined so
   * it survives being moved somewhere else.
   */
  async toHtml() {
    if (!this.article) return '';
    const clone = this.article.cloneNode(true);
    for (const mark of clone.querySelectorAll('.md-mark')) unwrap(mark);
    for (const pin of clone.querySelectorAll('.md-pin')) pin.remove();

    for (const img of clone.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (!src.startsWith('/local?path=')) continue;
      try {
        const blob = await (await fetch(src)).blob();
        img.setAttribute('src', await dataUrl(blob));
      } catch { /* leave the reference as it is */ }
    }

    for (const a of clone.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('/local?path=')) {
        const target = decodeURIComponent(href.slice('/local?path='.length));
        a.setAttribute('href',
          this.dir && target.startsWith(this.dir) ? target.slice(this.dir.length + 1) : target);
      }
      a.removeAttribute('target');
    }

    const title = this.outline[0]?.text || this.name || 'Document';
    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<title>' + escapeHtml(title) + '</title>\n<style>\n' + HTML_CSS
      + '</style>\n</head>\n<body>\n<article class="md-export">\n'
      + clone.innerHTML.trim() + '\n</article>\n</body>\n</html>\n';
  }

  setCurrent(num) {
    if (num === this.current) return;
    this.current = num;
    this.emit('page', num);
    this.emit('section', num);
  }

  onScroll() {
    if (!this.article || !this.outline.length) { this.setCurrent(1); return; }
    const top = this.root.scrollTop;
    const atBottom = top + this.root.clientHeight >= this.root.scrollHeight - 2;
    let n = 1;
    for (const h of this.outline) {
      if (h.el.offsetTop <= top + 90) n = h.index;
      else break;
    }
    // The last heading often cannot be scrolled to the top of the pane. Once
    // the pane is at its bottom, the deepest heading still on screen is it.
    if (atBottom) {
      for (const h of this.outline) if (h.el.offsetTop <= top + this.root.clientHeight) n = h.index;
    }
    if (this._navTo) {
      if (n === this._navTo || atBottom) {
        this._navTo = 0;
        clearTimeout(this._navTimer);
      } else {
        // Still travelling: report the target, and settle on the real section
        // once scrolling stops short of it (the last heading often does).
        clearTimeout(this._navTimer);
        this._navTimer = setTimeout(() => {
          if (!this._navTo) return;
          this._navTo = 0;
          this.setCurrent(n);
        }, 250);
        return;
      }
    }
    this.setCurrent(n);
  }

  async ensureRendered() { /* markdown is fully in the DOM already */ }

  /* ----------------------------------------------------------------- search */

  clearHitMarks() {
    if (!this.article) return;
    for (const el of this.article.querySelectorAll('.hit-flash, .hit-current')) {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      el.remove();
    }
    // The wraps split text nodes; merge them back so nothing accumulates.
    this.article.normalize();
  }

  /**
   * Wrap the character range in a span. With the keyboard in a field the span
   * keeps a persistent outline; otherwise the browser selection is used so the
   * match reads like a real text selection.
   */
  markHit(hit, typing) {
    if (!this.article) return null;
    const { segs } = this.walk();
    const pieces = [];
    for (const seg of segs) {
      const len = seg.node.nodeValue.length;
      const end = seg.start + len;
      if (end <= hit.start || seg.start >= hit.end) continue;
      pieces.push({ node: seg.node, s: Math.max(0, hit.start - seg.start), e: Math.min(len, hit.end - seg.start) });
    }
    if (!pieces.length) return null;

    const cls = typing ? 'hit-current' : 'hit-flash';
    const spans = pieces.map((p) => wrapRange(p.node, p.s, p.e, cls));

    if (!typing) {
      try {
        const range = document.createRange();
        range.setStart(spans[0].firstChild || spans[0], 0);
        const last = spans[spans.length - 1];
        range.setEnd(last.firstChild || last, last.textContent.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* range re-wrapped mid-flight */ }
    }

    spans[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    return spans[0];
  }

  /* ------------------------------------------------------------ annotations */

  pulse(id) {
    const node = this.article?.querySelector(`[data-id="${id}"]`);
    if (!node) return;
    node.classList.add('pulse');
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => node.classList.remove('pulse'), 1200);
  }

  pinFor(id) { return this.article?.querySelector(`.md-pin[data-id="${id}"]`) || null; }

  renderAnnotations(list) {
    if (!this.article) return;
    for (const span of this.article.querySelectorAll('.md-mark')) unwrap(span);
    for (const pin of this.article.querySelectorAll('.md-pin')) pin.remove();

    for (const a of list) {
      if (a.kind === 'note') {
        const block = this.blocks[a.anchor?.block ?? 0];
        if (block) block.appendChild(this.makePin(a));
        continue;
      }
      if (a.kind === 'ink' || a.kind === 'rect') continue;
      for (const seg of a.segs || []) {
        const block = this.blocks[seg.block];
        if (!block) continue;
        for (const span of wrapBlockRange(block, seg.start, seg.end, 'md-mark md-' + a.kind)) {
          span.dataset.id = a.id;
          span.style.setProperty('--mark-color', a.color || '#f2c811');
        }
      }
    }
  }

  makePin(a) {
    const pin = document.createElement('button');
    pin.className = 'md-pin note-pin';
    pin.dataset.id = a.id;
    pin.style.setProperty('--note-color', a.color || '#f59f00');
    pin.title = a.text || 'Empty note';
    pin.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M5 3h14v18l-7-4-7 4z" fill="currentColor"/></svg>';
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.annotator.tool === 'eraser') { this.annotator.remove(a.id); return; }
      this.annotator.onNote(a);
    });
    return pin;
  }

  /* ------------------------------------------------------------ interaction */

  bindInteraction() {
    this.root.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.article) return;
      const tool = this.annotator.tool;
      if (!['highlight', 'underline', 'strikeout'].includes(tool)) return;
      if (e.target.closest?.('.note-editor') || e.target.closest?.('.md-pin')) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      if (!this.article.contains(sel.anchorNode)) return;
      const created = this.marksFromSelection(sel, tool);
      if (created) sel.removeAllRanges();
    });

    this.root.addEventListener('click', (e) => {
      if (!this.article) return;
      const link = e.target.closest?.('a[href]');
      if (link) {
        e.preventDefault();
        const href = link.getAttribute('href');
        if (href.startsWith('#')) {
          document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else if (/^https?:/i.test(href) || href.startsWith('mailto:')) {
          this.hooks.openExternal?.(href);
        } else {
          this.hooks.openFile?.(href);
        }
        return;
      }

      const pin = e.target.closest?.('.md-pin');
      if (pin) return;   // the pin handles its own click

      if (this.annotator.tool === 'eraser') {
        const mark = e.target.closest?.('.md-mark');
        if (mark) this.annotator.remove(mark.dataset.id);
        return;
      }

      if (this.annotator.tool === 'note') {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;               // a drag is not a note
        const block = this.blockOf(e.target);
        if (!block) return;
        const note = {
          id: uid(), page: 1, kind: 'note',
          anchor: { block: this.blocks.indexOf(block) },
          color: this.annotator.colors.note,
          text: '', createdAt: Date.now(), markdown: true
        };
        this.annotator.mutate(() => this.annotator.list.push(note));
        this.annotator.onNote(note, { create: true });
      }
    });
  }

  /** Turn a DOM selection into one annotation per touched block. */
  marksFromSelection(sel, kind) {
    const ranges = [];
    for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i));

    const perBlock = new Map();
    const { segs } = this.walk();
    for (const seg of segs) {
      const len = seg.node.nodeValue.length;
      let s = 0;
      let e = len;
      for (const range of ranges) {
        if (range.startContainer === seg.node) s = Math.max(s, range.startOffset);
        else if (range.comparePoint(seg.node, 0) < 0) s = len;
        if (range.endContainer === seg.node) e = Math.min(e, range.endOffset);
        else if (range.comparePoint(seg.node, len) > 0) e = 0;
      }
      if (e <= s) continue;
      const blockIndex = this.blocks.indexOf(seg.block);
      const base = blockOffset(seg.block, seg.node);
      const from = base + s;
      const to = base + e;
      const prev = perBlock.get(blockIndex);
      if (prev) { prev.start = Math.min(prev.start, from); prev.end = Math.max(prev.end, to); }
      else perBlock.set(blockIndex, { block: blockIndex, start: from, end: to });
    }
    if (!perBlock.size) return false;

    const text = sel.toString().replace(/\s+/g, ' ').trim();
    const annot = {
      id: uid(), page: 1, kind,
      color: this.annotator.colors[kind],
      segs: [...perBlock.values()],
      text, createdAt: Date.now(), markdown: true
    };
    this.annotator.mutate(() => this.annotator.list.push(annot));
    return true;
  }

  blockOf(node) {
    let n = node;
    while (n && n !== this.article) {
      if (n.parentElement === this.article) return n;
      n = n.parentElement;
    }
    return null;
  }
}

/* ------------------------------------------------------------------ helpers */

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

let seq = 0;
function uid() {
  seq += 1;
  return 'm' + Date.now().toString(36) + seq.toString(36);
}

function joinPath(dir, rel) {
  const clean = rel.replace(/^\.\//, '');
  const sep = dir.includes('\\') ? '\\' : '/';
  if (/^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith('/')) return clean;
  return dir + sep + clean;
}

/**
 * Pull $…$ and $$…$$ out of the source before markdown parsing, leaving a
 * token behind that survives the parser. Backtick regions are skipped so math
 * inside code stays literal.
 */
function protectMath(src) {
  const math = [];
  const out = [];
  let i = 0;
  let plain = '';

  const flush = () => {
    if (plain) out.push(extractMath(plain, math));
    plain = '';
  };

  while (i < src.length) {
    if (src[i] === '`') {
      const run = /^`+/.exec(src.slice(i))[0];
      const end = src.indexOf(run, i + run.length);
      if (end !== -1) {
        flush();
        out.push(src.slice(i, end + run.length));
        i = end + run.length;
        continue;
      }
    }
    plain += src[i++];
  }
  flush();
  return { text: out.join(''), math };
}

function extractMath(text, math) {
  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, body) => store(math, body.trim(), true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => store(math, body.trim(), true))
    .replace(/\\\((.+?)\\\)/g, (_m, body) => store(math, body.trim(), false))
    .replace(/(^|\s)\$([^\s$][^$\n]*?)\$(?=\s|[$.,;:!?)]|$)/g,
      (m, lead, body) => lead + store(math, body.trim(), false));
}

function store(math, body, display) {
  math.push({ body, display });
  return `%%qmath${math.length - 1}%%`;
}

function typesetMath(article, math) {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) if (MATH_TOKEN.test(node.nodeValue)) targets.push(node);

  for (const text of targets) {
    const parts = text.nodeValue.split(MATH_TOKEN);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < parts.length; i += 2) {
      const index = Number(parts[i + 1]);
      const item = math[index];
      if (!item) { frag.appendChild(document.createTextNode(parts[i] || '')); continue; }
      if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
      const span = document.createElement('span');
      span.className = 'md-math' + (item.display ? ' md-math-block' : '');
      try {
        span.innerHTML = katex.renderToString(item.body, {
          displayMode: item.display,
          throwOnError: false,
          output: 'html',
          strict: 'ignore'
        });
      } catch (err) {
        span.className += ' md-math-error';
        span.textContent = item.body;
        span.title = err.message;
      }
      frag.appendChild(span);
    }
    if (text.parentNode) text.parentNode.replaceChild(frag, text);
  }
}

function sanitize(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 1) {
      if (DROP_TAGS.has(child.tagName)) { child.remove(); continue; }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) child.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'src') && /^\s*(javascript|data):/i.test(attr.value)) child.removeAttribute(attr.name);
        else if (!KEEP_ATTR.test(name) && !name.startsWith('data-')) child.removeAttribute(attr.name);
      }
      sanitize(child);
    } else if (child.nodeType !== 3) {
      child.remove();
    }
  }
}

/** Character offset of a text node inside its top-level block. */
function blockOffset(block, target) {
  let base = 0;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node === target) return base;
    base += node.nodeValue?.length || 0;
  }
  return base;
}

/** Wrap a block-relative character range [from, to) in spans, one per text node. */
function wrapBlockRange(block, from, to, cls) {
  const pieces = [];
  let base = 0;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue?.length || 0;
    const s = Math.max(from, base);
    const e = Math.min(to, base + len);
    if (e > s) pieces.push({ node, s: s - base, e: e - base });
    base += len;
  }
  return pieces.map((p) => wrapRange(p.node, p.s, p.e, cls));
}

/** Undo wrapRange: put the span's children back and merge the text nodes. */
function unwrap(span) {
  const parent = span.parentNode;
  if (!parent) return;
  while (span.firstChild) parent.insertBefore(span.firstChild, span);
  span.remove();
  parent.normalize();
}

/** Split a text node so [s, e) sits inside a new span; returns that span. */
function wrapRange(node, s, e, cls) {
  const text = node.nodeValue;
  const before = text.slice(0, s);
  const inner = text.slice(s, e);
  const after = text.slice(e);

  const span = document.createElement('span');
  span.className = cls;
  span.textContent = inner;

  const parent = node.parentNode;
  if (before) parent.insertBefore(document.createTextNode(before), node);
  parent.insertBefore(span, node);
  if (after) parent.insertBefore(document.createTextNode(after), node);
  node.remove();
  parent.normalize();
  return span;
}

/** Read a blob as a data: URL, so images can leave with the export. */
function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** Minimal stylesheet for exported HTML — the file has to stand alone. */
const HTML_CSS = `
  :root { color-scheme: light dark; }
  body { margin: 0; background: #fbfbfd; color: #1d1f24;
    font: 16px/1.7 -apple-system, "Segoe UI", Roboto, sans-serif; }
  .md-export { max-width: 760px; margin: 0 auto; padding: 44px 26px 90px; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.5em; letter-spacing: -0.01em; }
  h2 { border-bottom: 1px solid #d5d9e0; padding-bottom: 6px; }
  p, li { max-width: 72ch; }
  a { color: #1971c2; }
  code { font: 0.86em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #f2f4f7; border: 1px solid #dfe3ea; border-radius: 4px; padding: 1px 4px; }
  pre { background: #f6f7f9; border: 1px solid #dfe3ea; border-radius: 8px;
    padding: 12px 14px; overflow: auto; }
  pre code { background: none; border: 0; padding: 0; }
  blockquote { margin: 1em 0; padding: 10px 16px; background: #f6f7f9;
    border-left: 3px solid #c9ccd3; color: #40464f; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; font-size: 0.94em; }
  th, td { border: 1px solid #d5d9e0; padding: 6px 10px; text-align: left; }
  th { background: #eef1f5; }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  hr { border: 0; border-top: 1px solid #d5d9e0; margin: 2em 0; }
`;
