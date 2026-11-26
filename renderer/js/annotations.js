const SVG_NS = 'http://www.w3.org/2000/svg';

let seq = 0;
export function newId() {
  seq += 1;
  return 'a' + Date.now().toString(36) + seq.toString(36);
}

/** Kinds that carry rectangles of page coverage. */
export const RECT_KINDS = new Set(['highlight', 'underline', 'strikeout', 'rect', 'ellipse']);

/**
 * Annotation model + overlay painting + tool interaction.
 *
 * Geometry is stored in PDF points with a top-left origin so the same
 * annotation looks right at every zoom level and can be written back into the
 * PDF later (src/export-pdf.js flips the y axis there).
 */
export class Annotator {
  constructor(viewer, { onChange, onNote, onSelection }) {
    this.viewer = viewer;
    this.onChange = onChange || (() => {});
    this.onNote = onNote || (() => {});
    this.onSelection = onSelection || (() => {});

    this.list = [];
    this.tool = 'highlight';
    this.colors = {
      highlight: '#f2c811',
      underline: '#2f9e44',
      strikeout: '#e03131',
      ink: '#1d1d1f',
      rect: '#1971c2',
      ellipse: '#1971c2',
      arrow: '#e03131',
      note: '#f59f00'
    };
    this.inkWidth = 2;

    this.undoStack = [];
    this.redoStack = [];
    this.drag = null;
    this.surface = null;   // active document surface: the PDF viewer or Markdown

    this.bindPointer();
  }

  /* ------------------------------------------------------------ mutation */

  mutate(fn) {
    const before = JSON.stringify(this.list);
    fn();
    const after = JSON.stringify(this.list);
    if (before === after) return false;
    this.undoStack.push(before);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
    this.redraw();
    this.onChange();
    return true;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.list));
    this.list = JSON.parse(this.undoStack.pop());
    this.redraw();
    this.onChange();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.list));
    this.list = JSON.parse(this.redoStack.pop());
    this.redraw();
    this.onChange();
    return true;
  }

  canUndo() { return this.undoStack.length > 0; }

  canRedo() { return this.redoStack.length > 0; }

  replace(list) {
    const kinds = new Set(['highlight', 'underline', 'strikeout', 'note', 'ink', 'rect', 'ellipse', 'arrow']);
    this.list = (Array.isArray(list) ? list : [])
      .filter((a) => a && kinds.has(a.kind) && Number.isFinite(a.page))
      .map((a) => ({ ...a, id: a.id || newId() }));
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.redraw();
  }

  byPage(num) {
    return this.list.filter((a) => a.page === num);
  }

  remove(id) {
    this.mutate(() => {
      this.list = this.list.filter((a) => a.id !== id);
    });
  }

  setTool(tool) {
    this.tool = tool;
    this.viewer.root.dataset.tool = tool;
  }

  /* ------------------------------------------------------------ painting */

  redraw() {
    if (this.surface?.mode === 'markdown') {
      this.surface.renderAnnotations(this.list);
      return;
    }
    const groups = new Map();
    for (const a of this.list) {
      if (!groups.has(a.page)) groups.set(a.page, []);
      groups.get(a.page).push(a);
    }

    for (const page of this.viewer.pages) {
      const marks = groups.get(page.num) || [];
      const children = [];
      const pins = [];

      for (const a of marks) {
        if (a.kind === 'note') { pins.push(this.makePin(a, page)); continue; }
        const node = this.paint(a);
        if (node) children.push(node);
      }

      page.svg.replaceChildren(...children);
      page.pins.replaceChildren(...pins);
    }
  }

  paint(a) {
    const g = el('g', { 'data-id': a.id, class: 'ann ' + a.kind });

    if (a.kind === 'highlight') {
      for (const r of a.rects || []) {
        g.appendChild(el('rect', {
          x: r.x, y: r.y, width: r.w, height: r.h, rx: 1.2,
          fill: a.color, 'fill-opacity': 0.38
        }));
      }
    } else if (a.kind === 'underline' || a.kind === 'strikeout') {
      for (const r of a.rects || []) {
        const y = a.kind === 'underline' ? r.y + r.h * 0.88 : r.y + r.h * 0.5;
        g.appendChild(el('line', {
          x1: r.x, y1: y, x2: r.x + r.w, y2: y,
          stroke: a.color, 'stroke-width': a.width || 1.1, 'stroke-linecap': 'round'
        }));
      }
    } else if (a.kind === 'ink') {
      const pts = a.points || [];
      if (pts.length > 1) {
        g.appendChild(el('path', {
          d: 'M ' + pts.map((p) => round(p[0]) + ' ' + round(p[1])).join(' L '),
          fill: 'none',
          stroke: a.color,
          'stroke-width': a.width || 2,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round'
        }));
      }
    } else if (a.kind === 'rect' || a.kind === 'ellipse') {
      const box = bbox(a.rects || []);
      if (box) {
        const shape = el(a.kind === 'ellipse' ? 'ellipse' : 'rect', a.kind === 'ellipse'
          ? { cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: Math.max(box.w / 2, 1), ry: Math.max(box.h / 2, 1) }
          : { x: box.x, y: box.y, width: box.w, height: box.h, rx: 2 });
        shape.setAttribute('fill', a.color);
        shape.setAttribute('fill-opacity', '0.06');
        shape.setAttribute('stroke', a.color);
        shape.setAttribute('stroke-width', a.width || 1.5);
        g.appendChild(shape);
      }
    } else if (a.kind === 'arrow') {
      const pts = a.points || [];
      if (pts.length > 1) {
        const [x1, y1] = pts[0];
        const [x2, y2] = pts[pts.length - 1];
        const width = a.width || 2;
        g.appendChild(el('line', {
          x1, y1, x2, y2,
          stroke: a.color, 'stroke-width': width, 'stroke-linecap': 'round'
        }));
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(7, width * 4);
        const left = [x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45)];
        const right = [x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45)];
        g.appendChild(el('polygon', {
          points: `${round(x2)},${round(y2)} ${round(left[0])},${round(left[1])} ${round(right[0])},${round(right[1])}`,
          fill: a.color
        }));
      }
    }
    return g;
  }

  makePin(a, page) {
    const pin = document.createElement('button');
    pin.className = 'note-pin';
    pin.dataset.id = a.id;
    pin.style.left = a.x * this.viewer.scale + 'px';
    pin.style.top = a.y * this.viewer.scale + 'px';
    pin.style.setProperty('--note-color', a.color);
    pin.title = a.text || 'Empty note';
    pin.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M5 3h14v18l-7-4-7 4z" fill="currentColor"/></svg>';
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.tool === 'eraser') { this.remove(a.id); return; }
      this.onNote(a);
    });
    return pin;
  }

  pulse(id) {
    if (this.surface?.mode === 'markdown') {
      this.surface.pulse(id);
      return;
    }
    for (const page of this.viewer.pages) {
      const node = page.svg.querySelector(`[data-id="${id}"]`) || page.pins.querySelector(`[data-id="${id}"]`);
      if (!node) continue;
      node.classList.add('pulse');
      setTimeout(() => node.classList.remove('pulse'), 1200);
      return;
    }
  }

  /* ---------------------------------------------------------- interaction */

  bindPointer() {
    const root = this.viewer.root;

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest?.('.note-editor')) return;
      const page = this.viewer.pageFromClientPoint(e.clientX, e.clientY);
      if (!page) return;

      if (this.tool === 'note') {
        e.preventDefault();
        const pt = this.viewer.pagePoint(page, e.clientX, e.clientY);
        const note = {
          id: newId(), page: page.num, kind: 'note',
          x: round(pt.x), y: round(pt.y), color: this.colors.note,
          text: '', createdAt: Date.now()
        };
        this.mutate(() => this.list.push(note));
        this.onNote(note, { create: true });
        return;
      }

      if (this.tool === 'ink' || this.tool === 'rect' || this.tool === 'ellipse' || this.tool === 'arrow') {
        e.preventDefault();
        const pt = this.viewer.pagePoint(page, e.clientX, e.clientY);
        this.drag = {
          page, kind: this.tool, color: this.colors[this.tool],
          width: this.inkWidth,
          points: [[pt.x, pt.y]],
          start: pt,
          ghost: null
        };
        this.showGhost();
        root.setPointerCapture(e.pointerId);
        return;
      }

      if (this.tool === 'highlight' || this.tool === 'underline' || this.tool === 'strikeout') {
        this.drag = { page, kind: this.tool, start: this.viewer.pagePoint(page, e.clientX, e.clientY), selectionDrag: true };
      }
    });

    root.addEventListener('pointermove', (e) => {
      if (!this.drag || this.drag.selectionDrag) return;
      const pt = this.viewer.pagePoint(this.drag.page, e.clientX, e.clientY);
      this.drag.points.push([pt.x, pt.y]);
      this.updateGhost(pt);
    });

    root.addEventListener('pointerup', (e) => {
      const drag = this.drag;
      this.drag = null;
      if (!drag) return;

      if (drag.kind === 'ink') {
        this.clearGhost();
        if (drag.points.length < 2) return;
        const xs = drag.points.map((p) => p[0]);
        const ys = drag.points.map((p) => p[1]);
        if (Math.max(...xs) - Math.min(...xs) < 2 && Math.max(...ys) - Math.min(...ys) < 2) return;
        const ink = {
          id: newId(), page: drag.page.num, kind: 'ink', color: drag.color,
          width: drag.width, points: drag.points.map((p) => [round(p[0]), round(p[1])]),
          createdAt: Date.now()
        };
        this.mutate(() => this.list.push(ink));
        return;
      }

      if (drag.kind === 'rect' || drag.kind === 'ellipse') {
        this.clearGhost();
        const pt = this.viewer.pagePoint(drag.page, e.clientX, e.clientY);
        const box = {
          x: Math.min(drag.start.x, pt.x),
          y: Math.min(drag.start.y, pt.y),
          w: Math.abs(pt.x - drag.start.x),
          h: Math.abs(pt.y - drag.start.y)
        };
        if (box.w < 4 || box.h < 4) return;
        const shape = {
          id: newId(), page: drag.page.num, kind: drag.kind, color: drag.color,
          width: drag.width, rects: [box].map(norm), createdAt: Date.now()
        };
        this.mutate(() => this.list.push(shape));
        return;
      }

      if (drag.kind === 'arrow') {
        this.clearGhost();
        const pt = this.viewer.pagePoint(drag.page, e.clientX, e.clientY);
        const dx = pt.x - drag.start.x;
        const dy = pt.y - drag.start.y;
        if (Math.hypot(dx, dy) < 6) return;
        const shape = {
          id: newId(), page: drag.page.num, kind: 'arrow', color: drag.color,
          width: drag.width,
          points: [[round(drag.start.x), round(drag.start.y)], [round(pt.x), round(pt.y)]],
          rects: [{
            x: Math.min(drag.start.x, pt.x), y: Math.min(drag.start.y, pt.y),
            w: Math.abs(dx), h: Math.abs(dy)
          }].map(norm),
          createdAt: Date.now()
        };
        this.mutate(() => this.list.push(shape));
        return;
      }

      if (drag.selectionDrag) {
        // Freeform highlight for scanned pages: drag with no text selected.
        const pt = this.viewer.pagePoint(drag.page, e.clientX, e.clientY);
        const dx = Math.abs(pt.x - drag.start.x);
        const dy = Math.abs(pt.y - drag.start.y);
        if (dx > 4 && dy > 4) {
          this.createFromRects(drag.kind, {
            [drag.page.num]: [{
              x: Math.min(drag.start.x, pt.x),
              y: Math.min(drag.start.y, pt.y),
              w: dx,
              h: dy
            }]
          }, '');
          return;
        }
      }

      if (this.surface?.mode === 'markdown') return;   // Markdown owns its selection
      this.createFromSelection();
    });

    root.addEventListener('click', (e) => {
      if (this.tool !== 'eraser') return;
      if (e.target.closest?.('.note-editor')) return;
      if (this.surface?.mode === 'markdown') return;   // Markdown marks handle their own erase
      const g = e.target.closest?.('.ann');
      if (!g) return;
      this.remove(g.dataset.id);
    });
  }

  showGhost() {
    const shape = this.drag.kind === 'ink' || this.drag.kind === 'arrow';
    this.ghost = shape
      ? el('path', {
        d: '', fill: 'none', stroke: this.drag.color,
        'stroke-width': this.drag.width, 'stroke-dasharray': '4 3', 'stroke-linecap': 'round'
      })
      : el('path', {
        d: '', fill: this.drag.color, 'fill-opacity': 0.06, stroke: this.drag.color,
        'stroke-width': this.drag.width, 'stroke-dasharray': '4 3'
      });
    this.drag.page.svg.appendChild(this.ghost);
  }

  updateGhost(pt) {
    if (!this.ghost) return;
    const start = this.drag.start;
    if (this.drag.kind === 'ink') {
      this.ghost.setAttribute('d', 'M ' + this.drag.points.map((p) => round(p[0]) + ' ' + round(p[1])).join(' L '));
      return;
    }
    if (this.drag.kind === 'arrow') {
      this.ghost.setAttribute('d', `M ${round(start.x)} ${round(start.y)} L ${round(pt.x)} ${round(pt.y)}`);
      return;
    }
    const w = Math.abs(pt.x - start.x);
    const h = Math.abs(pt.y - start.y);
    if (this.drag.kind === 'ellipse') {
      const cx = (start.x + pt.x) / 2;
      const cy = (start.y + pt.y) / 2;
      this.ghost.setAttribute('d',
        `M ${round(cx - w / 2)} ${round(cy)} a ${round(w / 2)} ${round(h / 2)} 0 1 0 ${round(w)} 0 a ${round(w / 2)} ${round(h / 2)} 0 1 0 ${round(-w)} 0 z`);
      return;
    }
    const x = Math.min(start.x, pt.x);
    const y = Math.min(start.y, pt.y);
    this.ghost.setAttribute('d', `M ${round(x)} ${round(y)} h ${round(w)} v ${round(h)} h ${round(-w)} z`);
  }

  clearGhost() {
    this.ghost?.remove();
    this.ghost = null;
  }

  /* ------------------------------------------------------- text selection */

  createFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const groups = this.rectsFromSelection(sel);
    if (!groups.size) return;
    this.createFromRects(this.tool, groups, sel.toString().trim());
    sel.removeAllRanges();
  }

  createFromRects(kind, groups, text) {
    if (!RECT_KINDS.has(kind)) return;
    const color = this.colors[kind];
    const created = [];
    const entries = groups instanceof Map ? [...groups.entries()] : Object.entries(groups);

    for (const [pageNum, rects] of entries) {
      const page = Number(pageNum);
      const duplicate = this.byPage(page).some((existing) =>
        existing.kind === kind &&
        (existing.rects || []).some((er) => rects.some((r) => sameRect(er, r)))
      );
      if (duplicate) continue;
      created.push({
        id: newId(),
        page,
        kind,
        color,
        width: kind === 'highlight' ? 0 : 1.1,
        rects: rects.map(norm),
        text: text || '',
        createdAt: Date.now()
      });
    }

    if (!created.length) return;
    this.mutate(() => this.list.push(...created));
    this.onSelection(text, created.length);
  }

  /** Selection client rects -> per-page PDF-point rects snapped to text boxes. */
  rectsFromSelection(sel) {
    const groups = new Map();
    for (let r = 0; r < sel.rangeCount; r++) {
      const range = sel.getRangeAt(r);
      for (const cr of range.getClientRects()) {
        if (cr.width < 1 || cr.height < 1) continue;
        const page = this.viewer.pageFromClientPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
        if (!page) continue;
        const rect = this.viewer.pageRectFromClient(page, cr);
        if (!groups.has(page.num)) groups.set(page.num, []);
        groups.get(page.num).push(rect);
      }
    }
    for (const [num, rects] of groups) {
      groups.set(num, snapToText(this.viewer.pages[num - 1], rects));
    }
    return groups;
  }
}

/* ---------------------------------------------------------------- helpers */

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function norm(r) {
  return { x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) };
}

function bbox(rects) {
  if (!rects.length) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: round(x1), y: round(y1), w: round(x2 - x1), h: round(y2 - y1) };
}

function sameRect(a, b) {
  if (!a || !b) return false;
  const near = (x, y) => Math.abs(x - y) < 2;
  return near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
}

/**
 * Snap browser selection rectangles to the PDF text boxes they touch, then
 * merge fragments on the same line so a highlight reads as one stroke.
 */
function snapToText(page, rects) {
  const boxes = page?.itemBoxes || [];
  const out = [];

  for (const r of rects) {
    let snapped = null;
    for (const b of boxes) {
      if (b.x + b.w < r.x - 2 || b.x > r.x + r.w + 2) continue;
      if (b.y + b.h < r.y - 2 || b.y > r.y + r.h + 2) continue;
      if (!snapped) snapped = { x: r.x, y: b.y, w: r.w, h: b.h };
      else {
        const y1 = Math.min(snapped.y, b.y);
        const y2 = Math.max(snapped.y + snapped.h, b.y + b.h);
        snapped.y = y1;
        snapped.h = y2 - y1;
      }
    }
    out.push(snapped || r);
  }

  return mergeLines(out);
}

function mergeLines(rects) {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && overlapsY(last, r)) {
      const x1 = Math.min(last.x, r.x);
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y1 = Math.min(last.y, r.y);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = x1; last.y = y1; last.w = x2 - x1; last.h = y2 - y1;
    } else {
      out.push({ ...r });
    }
  }
  return out.filter((r) => r.w > 1.5 && r.h > 1).map(norm);
}

function overlapsY(a, b) {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap > 0.45 * Math.min(a.h, b.h);
}
