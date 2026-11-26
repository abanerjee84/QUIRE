'use strict';

/**
 * Writes annotations back into a PDF with pdf-lib.
 *
 * Two modes:
 *   'annot'   real PDF annotations (/Highlight, /Text, /Ink, /Square, /Line)
 *             so Acrobat, Chrome and Preview show them as markup.
 *   'flatten' burns the markup into the page content, which any viewer draws
 *             whether or not it understands annotations.
 *
 * Annotation geometry is stored in PDF points with a top-left origin
 * (y grows downwards, the way pdf.js reports viewport coordinates); PDF user
 * space is bottom-left origin, so every y is flipped here.
 */
const {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFNumber,
  PDFString,
  PDFBool,
  PDFDict,
  PDFRef,
  BlendMode,
  rgb,
  moveTo,
  lineTo,
  closePath,
  fill,
  setFillingColor
} = require('pdf-lib');

const AUTHOR = 'Quire';

function toObj(doc, value) {
  if (value instanceof PDFRef || value instanceof PDFName || value instanceof PDFDict ||
      value instanceof PDFArray || value instanceof PDFNumber || value instanceof PDFString ||
      value instanceof PDFBool) {
    return value;
  }
  if (typeof value === 'number') return PDFNumber.of(value);
  if (typeof value === 'boolean') return value ? PDFBool.True : PDFBool.False;
  if (typeof value === 'string') return PDFString.of(value);
  if (Array.isArray(value)) {
    const arr = new PDFArray();
    for (const item of value) arr.push(toObj(doc, item));
    return arr;
  }
  throw new Error('Cannot convert to PDF object: ' + String(value));
}

function makeDict(doc, entries) {
  const dict = new PDFDict(new Map());
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null) continue;
    dict.set(PDFName.of(key), toObj(doc, value));
  }
  return dict;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return rgb(0.96, 0.85, 0.15);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Top-left rect -> PDF rect [llx, lly, urx, ury]. */
function pdfRect(pageHeight, rect) {
  return [rect.x, pageHeight - (rect.y + rect.h), rect.x + rect.w, pageHeight - rect.y];
}

function flip(pageHeight, y) {
  return pageHeight - y;
}

function bboxOf(rects) {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function pushAnnot(doc, page, dict) {
  const ref = doc.context.register(dict);
  const existing = doc.context.lookup(page.node.get(PDFName.of('Annots')), PDFArray);
  if (existing) {
    existing.push(ref);
  } else {
    page.node.set(PDFName.of('Annots'), doc.context.register(new PDFArray([ref])));
  }
  return ref;
}

function colorArray(a) {
  const c = hexToRgb(a.color);
  return [c.red, c.green, c.blue].map((v) => Number(v));
}

function buildAnnotationDict(doc, page, pageHeight, a) {
  const stamp = PDFString.of('D:' + new Date(a.createdAt || Date.now()).toISOString().replace(/[-:Z.]/g, ''));
  const common = {
    P: page.ref,
    T: PDFString.of(AUTHOR),
    M: stamp,
    F: 4 // print the annotation
  };

  switch (a.kind) {
    case 'highlight': {
      const quads = [];
      for (const r of a.rects) {
        const y1 = flip(pageHeight, r.y);
        const y2 = flip(pageHeight, r.y + r.h);
        // QuadPoints order: top-left, top-right, bottom-left, bottom-right
        quads.push(r.x, y1, r.x + r.w, y1, r.x, y2, r.x + r.w, y2);
      }
      const box = bboxOf(a.rects);
      return makeDict(doc, {
        ...common,
        Subtype: PDFName.of('Highlight'),
        Rect: pdfRect(pageHeight, box),
        QuadPoints: quads,
        C: colorArray(a),
        CA: 0.4,
        Contents: PDFString.of(a.text || '')
      });
    }

    case 'underline':
    case 'strikeout': {
      const lines = a.rects.map((r) =>
        flip(pageHeight, a.kind === 'underline' ? r.y + r.h * 0.88 : r.y + r.h * 0.5)
      );
      const r0 = a.rects[0];
      const y = lines[0];
      return makeDict(doc, {
        ...common,
        Subtype: PDFName.of('Line'),
        Rect: pdfRect(pageHeight, bboxOf(a.rects)),
        L: [r0.x, y, r0.x + r0.w, y],
        C: colorArray(a),
        Width: a.width || 1,
        CA: 1,
        Contents: PDFString.of(a.text || '')
      });
    }

    case 'ink': {
      const flat = [];
      for (const [x, y] of a.points) flat.push(x, flip(pageHeight, y));
      const xs = a.points.map((p) => p[0]);
      const ys = a.points.map((p) => p[1]);
      const box = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys)
      };
      return makeDict(doc, {
        ...common,
        Subtype: PDFName.of('Ink'),
        Rect: pdfRect(pageHeight, box),
        InkList: [flat],
        C: colorArray(a),
        Width: a.width || 2,
        CA: 1
      });
    }

    case 'rect':
    case 'ellipse': {
      const box = bboxOf(a.rects);
      return makeDict(doc, {
        ...common,
        Subtype: PDFName.of(a.kind === 'ellipse' ? 'Circle' : 'Square'),
        Rect: pdfRect(pageHeight, box),
        C: colorArray(a),
        CA: 1,
        Width: a.width || 1.5,
        Contents: PDFString.of(a.text || '')
      });
    }

    case 'arrow': {
      const pts = a.points || [];
      if (pts.length < 2) return null;
      const [x1, y1] = pts[0];
      const [x2, y2] = pts[pts.length - 1];
      return makeDict(doc, {
        ...common,
        Subtype: PDFName.of('Line'),
        Rect: pdfRect(pageHeight, bboxOf(a.rects || [{
          x: Math.min(x1, x2), y: Math.min(y1, y2),
          w: Math.abs(x2 - x1), h: Math.abs(y2 - y1)
        }])),
        L: [x1, flip(pageHeight, y1), x2, flip(pageHeight, y2)],
        // Arrow heads: none at the tail, open V at the point.
        Head: [PDFName.of('None'), PDFName.of('Open')],
        C: colorArray(a),
        Width: a.width || 2,
        CA: 1
      });
    }

    case 'note': {
      const size = 20;
      return makeDict(doc, {
        ...common,
        Subtype: PDFName.of('Text'),
        Name: PDFName.of('Comment'),
        Rect: [a.x, flip(pageHeight, a.y) - size, a.x + size, flip(pageHeight, a.y)],
        Contents: PDFString.of(a.text || ''),
        Open: PDFBool.False
      });
    }

    default:
      return null;
  }
}

/** Rough word wrap for flattened note text. */
function wrapText(text, maxChars) {
  const out = [];
  for (const paragraph of String(text || '').split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if ((line + ' ' + word).trim().length > maxChars) {
        out.push(line.trim());
        line = word;
      } else {
        line = (line + ' ' + word).trim();
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

function flattenAnnotation(page, pageHeight, a) {
  const color = hexToRgb(a.color);

  if (a.kind === 'highlight') {
    for (const r of a.rects) {
      page.drawRectangle({
        x: r.x,
        y: pageHeight - (r.y + r.h),
        width: r.w,
        height: r.h,
        color,
        opacity: 0.35,
        blendMode: BlendMode.Multiply
      });
    }
    return;
  }

  if (a.kind === 'underline' || a.kind === 'strikeout') {
    for (const r of a.rects) {
      const y = pageHeight - (a.kind === 'underline' ? r.y + r.h * 0.88 : r.y + r.h * 0.5);
      page.drawLine({
        start: { x: r.x, y },
        end: { x: r.x + r.w, y },
        thickness: a.width || 1,
        color,
        opacity: 0.9
      });
    }
    return;
  }

  if (a.kind === 'ink' && a.points.length > 1) {
    for (let i = 1; i < a.points.length; i++) {
      const [x0, y0] = a.points[i - 1];
      const [x1, y1] = a.points[i];
      page.drawLine({
        start: { x: x0, y: pageHeight - y0 },
        end: { x: x1, y: pageHeight - y1 },
        thickness: a.width || 2,
        color,
        opacity: 1
      });
    }
    return;
  }

  if (a.kind === 'rect') {
    const box = bboxOf(a.rects);
    page.drawRectangle({
      x: box.x,
      y: pageHeight - (box.y + box.h),
      width: box.w,
      height: box.h,
      borderColor: color,
      borderWidth: a.width || 1.5,
      opacity: 0
    });
    return;
  }

  if (a.kind === 'ellipse') {
    const box = bboxOf(a.rects);
    page.drawEllipse({
      x: box.x + box.w / 2,
      y: pageHeight - (box.y + box.h / 2),
      xScale: Math.max(box.w / 2, 1),
      yScale: Math.max(box.h / 2, 1),
      borderColor: color,
      borderWidth: a.width || 1.5,
      opacity: 0
    });
    return;
  }

  if (a.kind === 'arrow') {
    const pts = a.points || [];
    if (pts.length < 2) return;
    const [sx, sy] = pts[0];
    const [ex, ey] = pts[pts.length - 1];
    const x1 = sx, y1 = pageHeight - sy, x2 = ex, y2 = pageHeight - ey;
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.width || 2, color, opacity: 1 });
    // Open V head, drawn as a filled triangle in PDF user space.
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(7, (a.width || 2) * 4);
    const lx = x2 - head * Math.cos(angle - 0.45), ly = y2 - head * Math.sin(angle - 0.45);
    const rx = x2 - head * Math.cos(angle + 0.45), ry = y2 - head * Math.sin(angle + 0.45);
    page.pushOperators(setFillingColor(color), moveTo(x2, y2), lineTo(lx, ly), lineTo(rx, ry), closePath(), fill());
    return;
  }

  if (a.kind === 'note') {
    const markerY = pageHeight - a.y;
    page.drawRectangle({
      x: a.x,
      y: markerY - 14,
      width: 14,
      height: 14,
      color,
      opacity: 0.9
    });
    const lines = wrapText(a.text, 48).slice(0, 24);
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: a.x + 18,
        y: markerY - 12 - i * 11,
        size: 9,
        color: rgb(0.12, 0.12, 0.12),
        opacity: 0.95
      });
    });
  }
}

/**
 * @param {Uint8Array|Buffer} pdfBytes original document
 * @param {object[]} annotations Quire annotation list
 * @param {'annot'|'flatten'} mode
 * @returns {Promise<Uint8Array>}
 */
async function exportPdf(pdfBytes, annotations, mode = 'annot') {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false, ignoreEncryption: true });
  const marks = annotations.filter((a) => a.page >= 1 && a.page <= doc.getPageCount());

  for (const a of marks) {
    const page = doc.getPage(a.page - 1);
    const { height } = page.getSize();

    if (mode === 'flatten') {
      flattenAnnotation(page, height, a);
      continue;
    }

    const dict = buildAnnotationDict(doc, page, height, a);
    if (dict) pushAnnot(doc, page, dict);
  }

  if (mode === 'annot' && marks.length) {
    doc.setCreator(AUTHOR);
  }

  return doc.save();
}

module.exports = { exportPdf, hexToRgb, wrapText, flattenAnnotation };
