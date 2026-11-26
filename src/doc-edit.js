'use strict';

/**
 * Structural PDF editing, on top of pdf-lib.
 *
 * Everything the UI can do to a document is an op in a list: reorder pages,
 * rotate, delete, duplicate, insert a blank page, merge another PDF, resize,
 * set metadata, stamp text, number pages, fill form fields. One call takes the
 * current bytes plus the ops and returns new bytes, together with a mapping
 * from the new page order back to the original page numbers, so annotation
 * anchors can follow their page.
 */

const fs = require('node:fs');
const { PDFDocument, PDFName, PDFRef, StandardFonts, degrees, rgb } = require('pdf-lib');

/** Page sizes in PDF points, portrait. */
const PAGE_SIZES = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
  b5: [498.9, 708.75],
  tabloid: [792, 1224]
};

const FONT_SIZE_DEFAULT = 11;
const MARGIN_DEFAULT = 36;

function bboxOf(rects) {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, size: Math.max(...rects.map((r) => r.size || 0)) };
}

/**
 * A page selection: an array of 1-based numbers, or a range string
 * ("1-3,7", "all", "even", "odd", "current" resolved by the caller).
 */
function parsePages(spec, count, { ordered = false } = {}) {
  if (!spec || spec === 'all') return range(1, count);
  if (Array.isArray(spec)) return spec.map((n) => Math.trunc(n)).filter((n) => n >= 1 && n <= count);
  const out = [];
  for (const part of String(spec).split(',')) {
    const bit = part.trim();
    if (!bit) continue;
    if (bit === 'even') { out.push(...range(2, count, 2)); continue; }
    if (bit === 'odd') { out.push(...range(1, count, 2)); continue; }
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(bit);
    if (m) {
      const a = Math.trunc(Number(m[1]));
      const b = Math.trunc(Number(m[2]));
      for (let i = Math.min(a, b); i <= Math.min(Math.max(a, b), count); i++) if (i >= 1) out.push(i);
      continue;
    }
    const n = Math.trunc(Number(bit));
    if (Number.isFinite(n) && n >= 1 && n <= count) out.push(n);
  }
  // A selection is a set; an order is a sequence, so `ordered` keeps the input order.
  const unique = [...new Set(out)];
  return ordered ? unique : unique.sort((a, b) => a - b);
}

function range(from, to, step = 1) {
  const out = [];
  for (let i = from; i <= to; i += step) out.push(i);
  return out;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return rgb(0.15, 0.15, 0.18);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Where a stamp lands on the page: nine positions, PDF points from the bottom left. */
function stampPoint(position, width, height, textWidth, margin) {
  const m = Number.isFinite(margin) ? margin : MARGIN_DEFAULT;
  const x = {
    left: m,
    center: (width - textWidth) / 2,
    right: width - m - textWidth
  }[/^(left|center|right)/.test(position) ? position.split('-')[0] : 'center'];
  const row = /top/.test(position) ? 'top' : /middle|center-center|center$/.test(position) ? 'middle' : 'bottom';
  const y = { top: height - m, middle: height / 2, bottom: m }[row];
  return { x: Math.max(0, x), y };
}

/**
 * Run the ops against `bytes`.
 *
 * Returns `{ bytes, mapping, pageCount }` where `mapping[i]` is the original
 * 1-based page number that ended up as page `i + 1`, or `null` for a page that
 * was not in the original document.
 */
async function applyOps(bytes, ops = []) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  // Page objects outlive removePage/insertPage, so a plain list of
  // { page, from } entries is the working page order and its provenance.
  let entries = doc.getPages().map((page, index) => ({ page, from: index + 1 }));
  const report = [];

  const pageAt = (n) => entries.find((e) => e.from === n);
  const selected = (spec) => parsePages(spec, entries.length).map((n) => entries[n - 1]);

  for (const op of ops) {
    if (!op || !op.op) continue;
    switch (op.op) {
      case 'order': {
        const wanted = parsePages(op.pages, entries.length, { ordered: true });
        const rest = entries.filter((e) => !wanted.includes(e.from));
        const picked = wanted.map((n) => entries[n - 1]).filter(Boolean);
        entries = op.keepRest === false ? picked : [...picked, ...rest];
        break;
      }
      case 'move': {
        const picked = selected(op.pages);
        const left = entries.filter((e) => !picked.includes(e));
        if (op.to === 'start') entries = [...picked, ...left];
        else if (op.to === 'end') entries = [...left, ...picked];
        else {
          // Nudge each selected page one slot in the requested direction.
          const dir = op.to === 'left' ? -1 : 1;
          const order = [...entries];
          const sorted = picked.map((e) => order.indexOf(e)).sort((a, b) => (dir < 0 ? a - b : b - a));
          for (const i of sorted) {
            const j = i + dir;
            if (j < 0 || j >= order.length) continue;
            const tmp = order[i];
            order[i] = order[j];
            order[j] = tmp;
          }
          entries = order;
        }
        break;
      }
      case 'reverse':
        entries = [...entries].reverse();
        break;
      case 'delete': {
        const drop = new Set(selected(op.pages));
        entries = entries.filter((e) => !drop.has(e));
        if (!entries.length) throw new Error('Refusing to delete every page');
        break;
      }
      case 'duplicate': {
        const picked = selected(op.pages);
        // The document still holds pages in their original order until the last
        // step, so the copy indices come from the document, not from `entries`.
        const live = doc.getPages();
        const copies = await doc.copyPages(doc, picked.map((e) => live.indexOf(e.page)));
        const out = [];
        for (const e of entries) {
          out.push(e);
          const slot = picked.indexOf(e);
          if (slot >= 0) out.push({ page: copies[slot], from: null });
        }
        entries = out;
        break;
      }
      case 'insertBlank': {
        const size = op.size && Array.isArray(op.size) ? op.size : PAGE_SIZES.a4;
        const blank = doc.addPage(size);
        const after = Number.isFinite(op.after) ? op.after : entries.length;
        entries.splice(Math.min(Math.max(after, 0), entries.length), 0, { page: blank, from: null });
        break;
      }
      case 'merge': {
        const source = op.bytes != null ? op.bytes : (op.filePath ? fs.readFileSync(op.filePath) : null);
        if (source == null) throw new Error('merge needs a file path or bytes');
        const other = await PDFDocument.load(source, { updateMetadata: false, ignoreEncryption: true });
        const indices = parsePages(op.pages, other.getPageCount()).map((n) => n - 1);
        if (!indices.length) throw new Error('No pages to merge from ' + op.filePath);
        const copied = await doc.copyPages(other, indices);
        const after = Number.isFinite(op.after) ? op.after : entries.length;
        entries.splice(Math.min(Math.max(after, 0), entries.length), 0, ...copied.map((page) => ({ page, from: null })));
        const label = op.name || op.filePath || 'another PDF';
        report.push('merged ' + copied.length + ' page(s) from ' + String(label).split(/[\\/]/).pop());
        break;
      }
      case 'rotate': {
        const delta = Number(op.delta) || 0;
        for (const e of selected(op.pages)) {
          const now = e.page.getRotation().angle;
          e.page.setRotation(degrees(((now + delta) % 360 + 360) % 360));
        }
        break;
      }
      case 'resize': {
        const preset = PAGE_SIZES[String(op.size || '').toLowerCase()] || null;
        let target = preset ? [...preset] : [Number(op.width), Number(op.height)];
        if (!target.every((n) => Number.isFinite(n) && n > 0)) throw new Error('resize needs a size');
        if (op.landscape && target[0] < target[1]) target.reverse();
        for (const e of selected(op.pages)) {
          const box = e.page.getMediaBox();
          if (box.width <= 0 || box.height <= 0) continue;
          // `fit` keeps the aspect ratio and centres the page on the new sheet;
          // the default stretches the content to fill it exactly.
          const s = op.fit ? Math.min(target[0] / box.width, target[1] / box.height) : 0;
          e.page.setSize(target[0], target[1]);
          if (op.scale === false) continue;
          const sx = op.fit ? s : target[0] / box.width;
          const sy = op.fit ? s : target[1] / box.height;
          e.page.scaleContent(sx, sy);
          e.page.scaleAnnotations(sx, sy);
          if (op.fit) {
            e.page.translateContent((target[0] - box.width * sx) / 2, (target[1] - box.height * sy) / 2);
          }
        }
        break;
      }
      case 'crop': {
        // op.boxes: content rectangles in top-left points, keyed by page position,
        // as measured by the renderer. op.inset is a fallback percentage trim.
        const pct = Math.min(Math.max(Number(op.inset) || 0, 0), 40) / 100;
        for (const [index, e] of entries.entries()) {
          if (!selected(op.pages).includes(e)) continue;
          const box = e.page.getMediaBox();
          const found = op.boxes ? op.boxes[index + 1] : null;
          if (found && Number.isFinite(found.w) && Number.isFinite(found.h)) {
            if (e.page.getRotation().angle) {
              report.push('page ' + (index + 1) + ' skipped: it is rotated');
              continue;
            }
            const x = box.x + Math.min(Math.max(found.x, 0), box.width);
            const w = Math.min(Math.max(found.w, 20), box.x + box.width - x);
            const yTop = Math.min(Math.max(found.y, 0), box.height);
            const h = Math.min(Math.max(found.h, 20), box.height - yTop);
            const y = box.y + box.height - (yTop + h);
            e.page.setMediaBox(x, y, w, h);
            e.page.setCropBox(x, y, w, h);
            continue;
          }
          const insetX = box.width * pct;
          const insetY = box.height * pct;
          if (!insetX && !insetY) continue;
          e.page.setMediaBox(box.x + insetX, box.y + insetY, box.width - 2 * insetX, box.height - 2 * insetY);
          e.page.setCropBox(box.x + insetX, box.y + insetY, box.width - 2 * insetX, box.height - 2 * insetY);
        }
        break;
      }
      case 'replace': {
        // Text replacement paints over the old glyphs and writes the new word in
        // a standard font: pdf-lib cannot edit an existing text show operation.
        const hits = Array.isArray(op.hits) ? op.hits : [];
        const replacement = String(op.replacement ?? '');
        if (!hits.length) break;
        if (!replacement.trim()) throw new Error('Replacement text is empty');
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const cover = hexToRgb(op.cover || '#ffffff');
        const ink = hexToRgb(op.color || '#1d1d1f');
        let done = 0;
        for (const hit of hits) {
          const e = entries[Number(hit.page) - 1];
          const rects = (hit.rects || []).filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0);
          if (!e || !rects.length) continue;
          const box = bboxOf(rects);
          const height = e.page.getSize().height;
          e.page.drawRectangle({
            x: box.x - 1,
            y: height - (box.y + box.h) - 1,
            width: box.w + 2,
            height: box.h + 2,
            color: cover,
            opacity: 1
          });
          const baseline = Math.max(...rects.map((r) => Number(r.baseline) || box.y + box.h * 0.8));
          let size = Math.min(Math.max(box.size || 9, 4), 60);
          const text = replacement.trim();
          const wide = font.widthOfTextAtSize(text, size);
          if (wide > box.w) size = Math.max(4, (size * box.w) / wide);
          e.page.drawText(text, { x: box.x, y: height - baseline, size, font, color: ink });
          done += 1;
        }
        report.push(done + ' occurrence(s) replaced');
        break;
      }
      case 'metadata': {
        // An empty field clears the entry; undefined leaves it alone.
        if (op.title !== undefined) doc.setTitle(String(op.title).trim());
        if (op.author !== undefined) doc.setAuthor(String(op.author).trim());
        if (op.subject !== undefined) doc.setSubject(String(op.subject).trim());
        if (op.keywords !== undefined) doc.setKeywords(String(op.keywords).split(/[,;]+/).map((k) => k.trim()).filter(Boolean));
        if (op.creator !== undefined) doc.setCreator(String(op.creator).trim());
        if (op.producer !== undefined) doc.setProducer(String(op.producer).trim());
        break;
      }
      case 'stamp': {
        const text = String(op.text ?? '');
        if (!text.trim()) throw new Error('Stamp text is empty');
        const font = await doc.embedFont(op.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
        const size = Number(op.size) || FONT_SIZE_DEFAULT;
        const color = hexToRgb(op.color);
        const opacity = op.opacity == null ? 1 : Math.min(Math.max(Number(op.opacity), 0.05), 1);
        const width = font.widthOfTextAtSize(text, size);
        for (const e of selected(op.pages)) {
          const { width: pw, height: ph } = e.page.getSize();
          const at = stampPoint(op.position || 'bottom-center', pw, ph, width, op.margin);
          e.page.drawText(text, { x: at.x, y: at.y, size, font, color, opacity });
        }
        break;
      }
      case 'pageNumbers': {
        const font = await doc.embedFont(op.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
        const size = Number(op.size) || FONT_SIZE_DEFAULT;
        const color = hexToRgb(op.color);
        const total = entries.length;
        const format = String(op.format || '{n}');
        let shown = 0;
        for (const e of entries) {
          shown += 1;
          if (!parsePages(op.pages, total).includes(shown)) continue;
          const n = shown + (Number(op.start) || 1) - 1;
          const text = format
            .replaceAll('{n}', String(n))
            .replaceAll('{total}', String(total))
            .replaceAll('{page}', String(n));
          const width = font.widthOfTextAtSize(text, size);
          const { width: pw, height: ph } = e.page.getSize();
          const at = stampPoint(op.position || 'bottom-center', pw, ph, width, op.margin);
          e.page.drawText(text, { x: at.x, y: at.y, size, font, color });
        }
        break;
      }
      case 'formValues': {
        const form = doc.getForm();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const values = op.values || {};
        let touched = 0;
        for (const field of form.getFields()) {
          const name = field.getName();
          if (!(name in values)) continue;
          const value = values[name];
          if (field.constructor.name === 'PDFCheckBox') {
            if (value) field.check(); else field.uncheck();
          } else if (field.constructor.name === 'PDFRadioGroup') {
            if (value) field.select(String(value)); else field.clear();
          } else if (field.constructor.name === 'PDFDropdown' || field.constructor.name === 'PDFOptionList') {
            if (value) field.select(String(value)); else field.clear();
          } else if (typeof field.setText === 'function') {
            field.setText(String(value ?? ''));
          } else continue;
          touched += 1;
        }
        if (op.flatten) form.flatten();
        if (!op.flatten && touched) form.updateFieldAppearances(font);
        report.push(touched + ' field(s) updated');
        break;
      }
      case 'clearForm': {
        const form = doc.getForm();
        for (const field of form.getFields()) {
          if (typeof field.setText === 'function') field.setText('');
          else if (field.constructor.name === 'PDFCheckBox') field.uncheck();
          else field.clear?.();
        }
        report.push('form cleared');
        break;
      }
      case 'deleteXFA':
        doc.getForm().deleteXFA();
        break;
      case 'flattenForms':
        doc.getForm().flatten();
        report.push('form fields flattened');
        break;
      default:
        report.push('unknown op: ' + op.op);
    }
  }

  // Rebuild the page order from the working list: pdf-lib keeps page objects
  // across removePage, so this reorders without re-copying anything.
  for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
  entries.forEach((entry, index) => doc.insertPage(index, entry.page));

  const bytesOut = await doc.save();
  return {
    bytes: bytesOut,
    mapping: entries.map((e) => e.from),
    pageCount: entries.length,
    report
  };
}

/** Document summary page 1: page list plus document metadata. */
async function readInfo(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const keywords = doc.getKeywords();
  return {
    pageCount: doc.getPageCount(),
    pages: doc.getPages().map((page, index) => {
      const size = page.getSize();
      return {
        page: index + 1,
        width: Math.round(size.width * 100) / 100,
        height: Math.round(size.height * 100) / 100,
        rotation: page.getRotation().angle
      };
    }),
    metadata: {
      title: doc.getTitle() || '',
      author: doc.getAuthor() || '',
      subject: doc.getSubject() || '',
      keywords: Array.isArray(keywords) ? keywords.join(', ') : (keywords || ''),
      creator: doc.getCreator() || '',
      producer: doc.getProducer() || '',
      creationDate: doc.getCreationDate()?.toISOString?.() || '',
      modifiedDate: doc.getModificationDate()?.toISOString?.() || ''
    },
    hasForm: doc.getForm().getFields().length > 0,
    hasAcroForm: doc.catalog.get(PDFName.of('AcroForm')) !== undefined,
    fieldCount: doc.getForm().getFields().length,
    hasXFA: doc.getForm().hasXFA()
  };
}

/** Resolve whatever a dict entry points at — a reference or the object itself. */
function resolve(doc, value) {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}

/**
 * Which page a field's widget sits on. pdf-lib forms can leave the widgets out
 * of the page /Annots array, so a missing match reports null rather than a
 * guess; real PDFs from Word, Acrobat and print drivers always carry it.
 */
function pageForField(doc, field) {
  const want = new Set();
  if (field.acroField && field.acroField.dict) want.add(field.acroField.dict);
  const kids = resolve(doc, field.acroField && field.acroField.dict.get(PDFName.of('Kids')));
  if (kids && typeof kids.size === 'function') {
    for (let i = 0; i < kids.size(); i++) {
      const widget = resolve(doc, kids.lookup(i));
      if (widget) want.add(widget);
    }
  }
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const annots = resolve(doc, pages[i].node.Annots());
    if (!annots || typeof annots.size !== 'function') continue;
    for (let j = 0; j < annots.size(); j++) {
      const annot = resolve(doc, annots.lookup(j));
      if (annot && want.has(annot)) return i + 1;
    }
  }
  return null;
}

/** Everything the UI needs to know about a PDF's AcroForm fields. */
async function readFields(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const form = doc.getForm();
  const fields = [];
  for (const field of form.getFields()) {
    const kind = field.constructor.name;
    const entry = {
      name: field.getName() || '(unnamed)',
      kind,
      value: '',
      options: [],
      readOnly: !!field.isReadOnly?.(),
      required: !!field.isRequired?.(),
      multiline: false
    };
    if (kind === 'PDFTextField') {
      entry.kind = 'text';
      entry.value = field.getText() || '';
      entry.multiline = field.isMultiline();
      const max = field.getMaxLength?.();
      if (Number.isFinite(max)) entry.maxLength = max;
    } else if (kind === 'PDFCheckBox') {
      entry.kind = 'checkbox';
      entry.value = field.isChecked();
    } else if (kind === 'PDFRadioGroup') {
      entry.kind = 'radio';
      entry.options = field.getOptions();
      entry.value = field.getSelected() || '';
    } else if (kind === 'PDFDropdown') {
      entry.kind = 'dropdown';
      entry.options = field.getOptions();
      entry.value = field.getSelected() || '';
      entry.editable = field.isEditable();
    } else if (kind === 'PDFOptionList') {
      entry.kind = 'list';
      entry.options = field.getOptions();
      entry.value = field.getSelected() || '';
    } else if (kind === 'PDFSignature') {
      entry.kind = 'signature';
    }
    const page = pageForField(doc, field);
    entry.page = page;
    fields.push(entry);
  }
  return { fields, hasXFA: form.hasXFA() };
}

/** A one-page blank PDF, for File → New. */
async function createBlank(sizeKey = 'a4') {
  const doc = await PDFDocument.create();
  const size = PAGE_SIZES[String(sizeKey || '').toLowerCase()] || PAGE_SIZES.a4;
  doc.addPage(size);
  doc.setTitle('Untitled');
  doc.setProducer('Quire');
  return { bytes: await doc.save(), size };
}

module.exports = { applyOps, readFields, readInfo, createBlank, parsePages, PAGE_SIZES, MARGIN_DEFAULT };
