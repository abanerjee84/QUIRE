import * as pdfjsLib from '/pdfjs/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Merge boxes that share a line, so one text match reads as one rectangle. */
function mergeLines(boxes) {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.min(last.y + last.h, r.y + r.h) - Math.max(last.y, r.y) > 0.45 * Math.min(last.h, r.h)) {
      const x1 = Math.min(last.x, r.x);
      const y1 = Math.min(last.y, r.y);
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = x1; last.y = y1; last.w = x2 - x1; last.h = y2 - y1;
      last.baseline = Math.max(last.baseline, r.baseline);
      last.size = Math.max(last.size, r.size);
    } else {
      out.push({ ...r });
    }
  }
  const round = (n) => Math.round(n * 100) / 100;
  return out.map((r) => ({
    x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h),
    baseline: round(r.baseline), size: round(r.size)
  }));
}

/**
 * Renders a pdf.js document as a continuous scroll of pages.
 *
 * Each page is a stack of layers:
 *   canvas      the pixels
 *   text-layer  invisible selectable spans sitting over the glyphs
 *   ann-layer   SVG for highlights / ink / shapes
 *   pins-layer  HTML sticky-note pins
 *   draw-layer  transparent sheet used while dragging ink or shapes
 *
 * Page geometry is expressed in PDF points (1/72", top-left origin) so
 * annotations survive zoom changes untouched.
 */
export class PdfViewer {
  constructor(root) {
    this.root = root;
    this.doc = null;
    this.pages = [];
    this.scale = 1;
    this.fitMode = 'width';
    this.current = 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.events = new Map();

    this.root.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.root.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const page = entry.target._page;
        if (!page) continue;
        if (entry.isIntersecting) this.renderPage(page);
        else this.cancelRender(page);
      }
    }, { root: this.root, rootMargin: '400px 0px' });
  }

  on(name, fn) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(fn);
  }

  emit(name, payload) {
    for (const fn of this.events.get(name) || []) fn(payload);
  }

  get mode() { return 'pdf'; }
  get pageCount() { return this.pages.length; }

  /* ------------------------------------------------------- search surface */

  /** Plain text of a page, for whole-document search. */
  async searchText(pageNum) {
    const info = await this.textInfo(pageNum);
    return info?.str || '';
  }

  /**
   * Show a character range of the page's plain text.
   *
   * A real document selection is only placed when the keyboard is not in a
   * field: a live selection makes the page swallow the next keystroke, which
   * is why typing into search used to lose characters. While a field has
   * focus, the match gets a persistent outline instead.
   */
  markHit(hit, typing) {
    const p = this.pages[hit.page - 1];
    if (!p || !p.text) return null;
    const si = this.elemAt(p.text.charMap, hit.start);
    const ei = this.elemAt(p.text.charMap, hit.end - 1);
    const from = p.elems[si];
    const to = p.elems[ei];
    if (!from?.firstChild || !to?.firstChild) return null;
    const startOff = Math.max(0, hit.start - p.text.itemStart[si]);
    const endOff = Math.max(0, hit.end - p.text.itemStart[ei]);

    if (!typing) {
      const range = document.createRange();
      range.setStart(from.firstChild, startOff);
      range.setEnd(to.firstChild, endOff);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return from;
    }
    from.classList.add('hit-current');
    return from;
  }

  clearHitMarks() {
    for (const el of this.root.querySelectorAll('.text-layer .hit-current')) el.classList.remove('hit-current');
  }

  /** Text-item index for a character, stepping to the nearest real item. */
  elemAt(charMap, index) {
    if (!charMap.length) return 0;
    if (index < 0) index = 0;
    if (index >= charMap.length) index = charMap.length - 1;
    let i = index;
    while (i < charMap.length && charMap[i] < 0) i += 1;
    if (i >= charMap.length) {
      i = index;
      while (i >= 0 && charMap[i] < 0) i -= 1;
    }
    // The map holds the item each character belongs to; the walk above only
    // picked a character position, so report what that character points at.
    return i >= 0 && i < charMap.length ? Math.max(0, charMap[i]) : 0;
  }

  /* ----------------------------------------------------------------- load */

  async load(data) {
    this.clear();
    this.doc = await pdfjsLib.getDocument({
      // pdf.js hands the buffer to its worker and detaches it here, so the
      // caller keeps its own bytes: document editing needs them afterwards.
      data: data instanceof Uint8Array ? data.slice() : data,
      disableAutoFetch: true,
      disableStream: true,
      // served from node_modules/pdfjs-dist by the main process
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/'
    }).promise;

    for (let num = 1; num <= this.doc.numPages; num++) {
      const page = await this.doc.getPage(num);
      const vp = page.getViewport({ scale: 1 });
      const shell = document.createElement('div');
      shell.className = 'page-wrap';
      shell.dataset.page = String(num);

      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.classList.add('ann-layer');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      const drawLayer = document.createElement('div');
      drawLayer.className = 'draw-layer';
      const pins = document.createElement('div');
      pins.className = 'pins-layer';

      shell.append(canvas, textLayer, svg, drawLayer, pins);
      this.root.appendChild(shell);

      const entry = {
        num,
        shell,
        canvas,
        ctx: canvas.getContext('2d', { alpha: false }),
        textLayer,
        svg,
        drawLayer,
        pins,
        w: vp.width,
        h: vp.height,
        rendered: false,
        renderTask: null,
        pageObj: null,
        items: null,
        itemBoxes: [],
        elems: [],
        text: null
      };
      shell._page = entry;
      this.pages.push(entry);
      this.sizePage(entry);
      this.observer.observe(shell);
      page.cleanup();
    }

    this.current = 1;
    return { pageCount: this.doc.numPages };
  }

  clear() {
    for (const p of this.pages) {
      this.cancelRender(p);
      this.observer.unobserve(p.shell);
      p.shell.remove();
    }
    this.pages = [];
    if (this.doc) this.doc.destroy();
    this.doc = null;
    this.current = 1;
  }

  /* -------------------------------------------------------------- layout */

  sizePage(p) {
    const w = p.w * this.scale;
    const h = p.h * this.scale;
    p.shell.style.width = w + 'px';
    p.shell.style.height = h + 'px';
    p.canvas.style.width = w + 'px';
    p.canvas.style.height = h + 'px';
    p.svg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`);
    p.svg.setAttribute('preserveAspectRatio', 'none');
  }

  setScale(scale, { keepAnchor = true } = {}) {
    if (!this.doc) return;
    const next = clamp(scale, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - this.scale) < 0.001) return;

    const anchor = this.anchorPoint();
    this.scale = next;
    for (const p of this.pages) {
      p.rendered = false;
      p.ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
      p.canvas.width = 0;
      p.canvas.height = 0;
      this.sizePage(p);
      p.textLayer.replaceChildren();
      p.elems = [];
    }
    this.restoreAnchor(anchor);
    this.renderVisible();
    this.emit('scale', this.scale);
  }

  zoomBy(factor) {
    this.fitMode = null;
    this.setScale(this.scale * factor);
  }

  zoomReset() {
    this.fitMode = null;
    this.setScale(1);
  }

  fitWidth() {
    if (!this.doc) return;
    this.fitMode = 'width';
    const p = this.pages[this.current - 1];
    const avail = this.root.clientWidth - 64;
    this.setScale(avail / p.w);
  }

  fitPage() {
    if (!this.doc) return;
    this.fitMode = 'page';
    const p = this.pages[this.current - 1];
    const s = Math.min((this.root.clientWidth - 64) / p.w, (this.root.clientHeight - 48) / p.h);
    this.setScale(s);
  }

  refit() {
    if (this.fitMode === 'width') this.fitWidth();
    else if (this.fitMode === 'page') this.fitPage();
  }

  /** Fraction through the current page, used to hold position across zoom. */
  anchorPoint() {
    const p = this.pages[this.current - 1];
    if (!p) return { page: 1, fraction: 0 };
    const top = p.shell.offsetTop;
    return { page: this.current, fraction: (this.root.scrollTop - top) / Math.max(1, p.h * this.scale) };
  }

  restoreAnchor(anchor) {
    const p = this.pages[anchor.page - 1];
    if (!p) return;
    this.root.scrollTop = p.shell.offsetTop + anchor.fraction * p.h * this.scale;
  }

  /* ------------------------------------------------------------ rendering */

  async renderPage(p) {
    if (!this.doc || p.rendered) return;
    if (p.rendering) { p.rerenderQueued = true; return; }
    p.rendering = true;
    const doc = this.doc;

    try {
      const page = p.pageObj || (p.pageObj = await doc.getPage(p.num));
      // A document edit replaces the PDF proxy while this await is in flight;
      // painting with the dead one throws inside pdf.js.
      if (this.doc !== doc) return;
      // One paint at a time per PDFPageProxy: a thumbnail still in flight would
      // cancel this render, so wait for it instead of racing it.
      for (let waited = 0; page._thumbBusy && this.doc && waited < 10000; waited += 60) await sleep(60);
      if (page._thumbBusy) { this.retryRender(p); return; }
      const vp = page.getViewport({ scale: this.scale * this.dpr });
      p.canvas.width = Math.max(1, Math.floor(vp.width));
      p.canvas.height = Math.max(1, Math.floor(vp.height));

      const task = page.render({ canvasContext: p.ctx, viewport: vp });
      p.renderTask = task;
      await task.promise;
      p.renderTask = null;
      p.rendered = true;
      p.retries = 0;

      if (!p.items) await this.extractText(p);
      this.buildTextLayer(p, page);
      this.emit('pageRendered', p);
    } catch (err) {
      if (err && err.name === 'AbortException') return;
      if (this.doc !== doc) return;                 // the document moved on without us
      // pdf.js reports a superseded paint as an error; asking again is enough.
      if (/cancel/i.test(err?.message || '')) { this.retryRender(p); return; }
      console.error('render failed', p.num, err?.message || String(err));
    } finally {
      p.rendering = false;
    }

    if (p.rerenderQueued) {
      p.rerenderQueued = false;
      p.rendered = false;
      this.renderPage(p);
    }
  }

  cancelRender(p) {
    if (p.renderTask) {
      p.renderTask.cancel();
      p.renderTask = null;
    }
  }

  async ensureRendered(num) {
    const p = this.pages[num - 1];
    if (!p) return;
    if (!p.rendered) {
      this.cancelRender(p);
      await this.renderPage(p);
    }
    if (!p.items) await this.extractText(p);
    if (!p.elems.length) this.buildTextLayer(p, p.pageObj || (p.pageObj = await this.doc.getPage(num)));
  }

  renderVisible() {
    const top = this.root.scrollTop;
    const bottom = top + this.root.clientHeight;
    for (const p of this.pages) {
      const a = p.shell.offsetTop;
      const b = a + p.shell.offsetHeight;
      if (b > top - 300 && a < bottom + 300) this.renderPage(p);
      else this.cancelRender(p);
    }
  }

  /* ------------------------------------------------------------- text */

  async extractText(p) {
    const page = p.pageObj || (p.pageObj = await this.doc.getPage(p.num));
    const content = await page.getTextContent();
    const items = content.items.filter((i) => typeof i.str === 'string' && i.str.length);
    p.items = items;

    const vp1 = page.getViewport({ scale: 1 });
    p.itemBoxes = items.map((item) => {
      const tr = pdfjsLib.Util.transform(vp1.transform, item.transform);
      const fontHeight = Math.hypot(tr[2], tr[3]) || Math.abs(item.height) || 8;
      return {
        x: tr[4],
        y: tr[5] - fontHeight * 0.85,
        w: Math.max(item.width * 1, 2),
        h: fontHeight * 1.12,
        baseline: tr[5],
        size: fontHeight
      };
    });

    let str = '';
    const charMap = [];
    const itemStart = [];
    for (let i = 0; i < items.length; i++) {
      const s = items[i].str;
      itemStart.push(str.length);
      for (let c = 0; c < s.length; c++) charMap.push(i);
      str += s + ' ';
      charMap.push(-1);
    }
    p.text = { str, charMap, itemStart };
  }

  buildTextLayer(p, page) {
    if (!p.items) return;
    const vp = page.getViewport({ scale: this.scale });
    const frag = document.createDocumentFragment();
    const elems = [];

    for (let i = 0; i < p.items.length; i++) {
      const item = p.items[i];
      const tr = pdfjsLib.Util.transform(vp.transform, item.transform);
      const fontHeight = Math.hypot(tr[2], tr[3]) || 8;
      const span = document.createElement('span');
      span.textContent = item.str;
      span.dataset.item = String(i);
      span.style.left = tr[4] + 'px';
      span.style.top = (tr[5] - fontHeight) + 'px';
      span.style.fontSize = fontHeight + 'px';
      span.style.transform = `scaleX(${Math.max(tr[0] / fontHeight, 0.4)})`;
      frag.appendChild(span);
      elems.push(span);
    }

    p.textLayer.replaceChildren(frag);
    p.elems = elems;
  }

  /** Plain text of a page, used by search. Cached per page. */
  async textInfo(num) {
    const p = this.pages[num - 1];
    if (!p) return null;
    if (!p.text) await this.extractText(p);
    return p.text;
  }

  /**
   * Every occurrence of `query` in the document, with the rectangles that cover
   * it. The boxes are the ones the highlight tool uses, so a replacement paints
   * exactly over the glyphs the reader sees.
   */
  async findText(query, { caseSensitive = false, onProgress = null } = {}) {
    if (!query) return [];
    const needle = caseSensitive ? query : query.toLowerCase();
    const hits = [];
    for (const p of this.pages) {
      const t = await this.textInfo(p.num);
      if (!t) continue;
      const hay = caseSensitive ? t.str : t.str.toLowerCase();
      let idx = hay.indexOf(needle);
      while (idx !== -1) {
        const end = idx + needle.length;
        const rects = [];
        for (let i = 0; i < t.itemStart.length; i++) {
          const len = p.items[i].str.length;
          if (!len) continue;
          const box = p.itemBoxes[i];
          const s = Math.max(idx - t.itemStart[i], 0);
          const e = Math.min(end - t.itemStart[i], len);
          if (e <= s) continue;
          rects.push({
            x: box.x + box.w * (s / len),
            y: box.y,
            w: box.w * ((e - s) / len),
            h: box.h,
            baseline: box.baseline,
            size: box.size
          });
        }
        hits.push({
          page: p.num,
          start: idx,
          end,
          snippet: t.str.slice(Math.max(0, idx - 30), end + 30).replace(/\s+/g, ' ').trim(),
          rects: mergeLines(rects)
        });
        idx = hay.indexOf(needle, end);
      }
      if (onProgress) onProgress(p.num, hits.length);
    }
    return hits;
  }

  /**
   * Bounding box of the ink on each page — text, images, drawn paths and real
   * PDF annotations — in top-left PDF points. Pages with nothing on them, and
   * rotated pages, come back with a null box so the caller leaves them alone.
   */
  async contentBoxes({ pad = 12, pages = null } = {}) {
    const list = pages ? this.pages.filter((p) => pages.includes(p.num)) : this.pages;
    const out = [];
    const round = (n) => Math.round(n * 100) / 100;
    for (const p of list) {
      const page = p.pageObj || (p.pageObj = await this.doc.getPage(p.num));
      const vp = page.getViewport({ scale: 1 });
      const xs = [];
      const ys = [];
      const add = (x, y) => { xs.push(x); ys.push(y); };

      if (!p.items) await this.extractText(p);
      for (const b of p.itemBoxes) {
        add(b.x, b.y);
        add(b.x + b.w, b.y + b.h);
      }

      const ops = await page.getOperatorList();
      const stack = [];
      let ctm = [...vp.transform];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i] || [];
        if (fn === pdfjsLib.OPS.save) stack.push([...ctm]);
        else if (fn === pdfjsLib.OPS.restore) ctm = stack.pop() || [...vp.transform];
        else if (fn === pdfjsLib.OPS.transform) ctm = pdfjsLib.Util.transform(ctm, args);
        else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject) {
          const w = Number(args[1]) || 0;
          const h = Number(args[2]) || 0;
          if (w && h) {
            add(...pdfjsLib.Util.applyTransform([0, 0], ctm));
            add(...pdfjsLib.Util.applyTransform([w, h], ctm));
          }
        } else if (fn === pdfjsLib.OPS.constructPath) {
          const points = Array.isArray(args[1]) ? args[1] : [];
          for (let k = 0; k + 1 < points.length; k += 2) {
            add(...pdfjsLib.Util.applyTransform([points[k], points[k + 1]], ctm));
          }
        }
      }

      for (const annot of await page.getAnnotations()) {
        const rect = annot.rect;
        if (!Array.isArray(rect) || rect.length !== 4) continue;
        add(Math.min(rect[0], rect[2]), vp.height - Math.max(rect[1], rect[3]));
        add(Math.max(rect[0], rect[2]), vp.height - Math.min(rect[1], rect[3]));
      }

      if (!xs.length) {
        out.push({ page: p.num, box: null, rotate: page.rotate || 0, pageWidth: vp.width, pageHeight: vp.height });
        continue;
      }
      const x1 = Math.max(0, Math.min(...xs) - pad);
      const y1 = Math.max(0, Math.min(...ys) - pad);
      const x2 = Math.min(vp.width, Math.max(...xs) + pad);
      const y2 = Math.min(vp.height, Math.max(...ys) + pad);
      out.push({
        page: p.num,
        rotate: page.rotate || 0,
        box: { x: round(x1), y: round(y1), w: round(x2 - x1), h: round(y2 - y1) },
        pageWidth: round(vp.width),
        pageHeight: round(vp.height)
      });
    }
    return out;
  }

  /* -------------------------------------------------------------- scroll */

  gotoPage(num, { center = false } = {}) {
    const p = this.pages[clamp(num, 1, this.pages.length) - 1];
    if (!p) return;
    const top = p.shell.offsetTop - 24;
    this.root.scrollTop = center
      ? top - (this.root.clientHeight - p.shell.offsetHeight) / 2
      : top;
    this.setCurrent(num);
    this.renderVisible();
  }

  setCurrent(num) {
    if (num === this.current) return;
    this.current = num;
    this.emit('page', num);
  }

  onScroll() {
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = null;
      const pos = this.root.scrollTop + 60;
      let num = 1;
      for (const p of this.pages) {
        if (p.shell.offsetTop + p.shell.offsetHeight > pos) { num = p.num; break; }
        num = p.num;
      }
      this.setCurrent(num);
    });
  }

  /* ---------------------------------------------------------- coordinates */

  /** Client (screen) point -> PDF points on a page. */
  pagePoint(p, clientX, clientY) {
    const r = p.shell.getBoundingClientRect();
    return {
      x: (clientX - r.left) / this.scale,
      y: (clientY - r.top) / this.scale
    };
  }

  /** Client rect -> PDF-point rect on the page that contains it. */
  pageRectFromClient(page, clientRect) {
    const r = page.shell.getBoundingClientRect();
    return {
      x: clamp((clientRect.left - r.left) / this.scale, 0, page.w),
      y: clamp((clientRect.top - r.top) / this.scale, 0, page.h),
      w: clamp(clientRect.width / this.scale, 1, page.w),
      h: clamp(clientRect.height / this.scale, 1, page.h)
    };
  }

  pageFromClientPoint(clientX, clientY) {
    for (const p of this.pages) {
      const r = p.shell.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return p;
    }
    return null;
  }

  pageShell(pageNum) {
    return this.pages[pageNum - 1]?.shell || null;
  }

  /** Try a page again after a cancelled or superseded paint, up to a point. */
  retryRender(p) {
    p.retries = (p.retries || 0) + 1;
    if (p.retries > 5) {
      p.retries = 0;
      console.warn('gave up rendering page', p.num);
      return;
    }
    setTimeout(() => { if (this.doc && !p.rendered) this.renderPage(p); }, 150);
  }

  /** Small canvas for the thumbnail strip. Shares the page proxy, so it is guarded. */
  async renderThumbnail(num, targetWidth) {
    if (!this.doc) return null;
    const page = await this.doc.getPage(num);
    if (page._thumbBusy) return null;
    page._thumbBusy = true;
    try {
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (targetWidth * this.dpr) / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = targetWidth + 'px';
      canvas.style.height = Math.round((targetWidth * base.height) / base.width) + 'px';
      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp }).promise;
      return canvas;
    } catch (err) {
      if (err?.name !== 'AbortException') console.warn('thumbnail failed', num, err);
      return null;
    } finally {
      page._thumbBusy = false;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
