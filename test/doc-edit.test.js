'use strict';

/**
 * Structural editing tests: every op against real bytes, checking page counts,
 * the provenance mapping, and that the result still parses.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');
const { applyOps, readInfo, readFields, createBlank, parsePages, PAGE_SIZES } = require('../src/doc-edit');

const SAMPLE = path.join(__dirname, '..', 'samples', 'quire-sample.pdf');

async function multiPageDoc(pages = 4) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([500, 700]);
    page.drawText('Page ' + i + ' of ' + pages, { x: 60, y: 600, size: 22, font, color: rgb(0, 0, 0) });
    page.drawText('needle findable text', { x: 60, y: 500, size: 14, font, color: rgb(0, 0, 0) });
    page.drawText('margin ' + i, { x: 60, y: 400, size: 12, font, color: rgb(0, 0, 0) });
  }
  return doc.save();
}

async function formDoc() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500, 700]);
  const form = doc.getForm();
  const text = form.createTextField('applicant.name');
  text.setText('Ada');
  text.addToPage(page, { x: 60, y: 600, width: 200, height: 20 });
  const check = form.createCheckBox('agree');
  check.check();
  check.addToPage(page, { x: 60, y: 560, width: 16, height: 16 });
  const drop = form.createDropdown('size');
  drop.addOptions(['small', 'large']);
  drop.select('large');
  drop.addToPage(page, { x: 60, y: 520, width: 120, height: 20 });
  // pdf-lib keeps widgets in the AcroForm only; real PDFs list them on the page too.
  for (const widget of [text, check, drop]) page.node.addAnnot(widget.ref);
  return doc.save();
}

async function pageCount(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPageCount();
}

async function run(name, fn) {
  try {
    await fn();
    console.log('ok   ' + name);
  } catch (err) {
    console.log('FAIL ' + name + ': ' + (err.message || err).split('\n')[0]);
    process.exitCode = 1;
  }
}

async function main() {
  await run('createBlank makes one readable page', async () => {
    const { bytes, size } = await createBlank('a4');
    assert.deepEqual(size, PAGE_SIZES.a4);
    assert.equal(await pageCount(bytes), 1);
    const info = await readInfo(bytes);
    assert.equal(info.pageCount, 1);
    assert.ok(Math.abs(info.pages[0].height - PAGE_SIZES.a4[1]) < 1);
    assert.equal(info.pages[0].rotation, 0);
    assert.equal(info.hasForm, false);
  });

  await run('createBlank falls back to A4 for an unknown size', async () => {
    const { bytes, size } = await createBlank('nonsense');
    assert.deepEqual(size, PAGE_SIZES.a4);
    assert.equal(await pageCount(bytes), 1);
  });

  await run('page spec parsing', async () => {
    assert.deepEqual(parsePages('all', 4), [1, 2, 3, 4]);
    assert.deepEqual(parsePages('even', 5), [2, 4]);
    assert.deepEqual(parsePages('odd', 5), [1, 3, 5]);
    assert.deepEqual(parsePages('1-3,7', 6), [1, 2, 3]);
    assert.deepEqual(parsePages([2, 5], 6), [2, 5]);
    assert.deepEqual(parsePages('2', 6), [2]);
  });

  await run('reverse reorders and maps provenance', async () => {
    const bytes = await multiPageDoc(4);
    const r = await applyOps(bytes, [{ op: 'reverse' }]);
    assert.equal(r.pageCount, 4);
    assert.deepEqual(r.mapping, [4, 3, 2, 1]);
  });

  await run('order honours a page list and keeps the rest', async () => {
    const bytes = await multiPageDoc(4);
    const r = await applyOps(bytes, [{ op: 'order', pages: '3,1' }]);
    assert.deepEqual(r.mapping, [3, 1, 2, 4]);
    const only = await applyOps(bytes, [{ op: 'order', pages: '2', keepRest: false }]);
    assert.deepEqual(only.mapping, [2]);
  });

  await run('delete removes pages and marks their provenance gone', async () => {
    const bytes = await multiPageDoc(4);
    const r = await applyOps(bytes, [{ op: 'delete', pages: '2' }]);
    assert.equal(r.pageCount, 3);
    assert.deepEqual(r.mapping, [1, 3, 4]);
    await assert.rejects(() => applyOps(bytes, [{ op: 'delete', pages: 'all' }]), /every page/);
  });

  await run('duplicate copies a page with a null provenance', async () => {
    const bytes = await multiPageDoc(3);
    const r = await applyOps(bytes, [{ op: 'duplicate', pages: '1' }]);
    assert.equal(r.pageCount, 4);
    assert.deepEqual(r.mapping, [1, null, 2, 3]);
  });

  await run('insertBlank splices a page of the requested size', async () => {
    const bytes = await multiPageDoc(2);
    const r = await applyOps(bytes, [{ op: 'insertBlank', after: 1, size: PAGE_SIZES.letter }]);
    assert.deepEqual(r.mapping, [1, null, 2]);
    const info = await readInfo(r.bytes);
    assert.ok(Math.abs(info.pages[1].height - PAGE_SIZES.letter[1]) < 1);
  });

  await run('move nudges pages left and right', async () => {
    const bytes = await multiPageDoc(4);
    const right = await applyOps(bytes, [{ op: 'move', pages: '1', to: 'right' }]);
    assert.deepEqual(right.mapping, [2, 1, 3, 4]);
    const start = await applyOps(bytes, [{ op: 'move', pages: '3', to: 'start' }]);
    assert.deepEqual(start.mapping, [3, 1, 2, 4]);
    const end = await applyOps(bytes, [{ op: 'move', pages: '1', to: 'end' }]);
    assert.deepEqual(end.mapping, [2, 3, 4, 1]);
  });

  await run('rotate wraps at 360', async () => {
    const bytes = await multiPageDoc(2);
    const r = await applyOps(bytes, [{ op: 'rotate', pages: 'all', delta: 90 }]);
    const info = await readInfo(r.bytes);
    assert.deepEqual(info.pages.map((p) => p.rotation), [90, 90]);
    const back = await applyOps(r.bytes, [{ op: 'rotate', pages: 'all', delta: 270 }]);
    const again = await readInfo(back.bytes);
    assert.deepEqual(again.pages.map((p) => p.rotation), [0, 0]);
  });

  await run('resize stretches, fit keeps the ratio, landscape swaps', async () => {
    const bytes = await multiPageDoc(2);
    const stretch = await applyOps(bytes, [{ op: 'resize', pages: 'all', size: 'letter' }]);
    const info = await readInfo(stretch.bytes);
    assert.ok(Math.abs(info.pages[0].width - PAGE_SIZES.letter[0]) < 1);

    const fit = await applyOps(bytes, [{ op: 'resize', pages: 'all', size: 'a4', fit: true }]);
    const fitted = await readInfo(fit.bytes);
    assert.ok(Math.abs(fitted.pages[0].width - PAGE_SIZES.a4[0]) < 1);

    const wide = await applyOps(bytes, [{ op: 'resize', pages: 'all', size: 'a4', landscape: true }]);
    const landscape = await readInfo(wide.bytes);
    assert.ok(landscape.pages[0].width > landscape.pages[0].height);
  });

  await run('crop uses measured content boxes, top-left origin', async () => {
    const bytes = await multiPageDoc(1);
    const before = await readInfo(bytes);
    const r = await applyOps(bytes, [{
      op: 'crop',
      pages: 'all',
      boxes: { 1: { x: 40, y: 60, w: 300, h: 400 } }
    }]);
    const after = await readInfo(r.bytes);
    assert.ok(Math.abs(after.pages[0].width - 300) < 1);
    assert.ok(Math.abs(after.pages[0].height - 400) < 1);
    assert.ok(after.pages[0].width < before.pages[0].width);
  });

  await run('crop skips rotated pages and says so', async () => {
    const bytes = await multiPageDoc(1);
    const turned = await applyOps(bytes, [{ op: 'rotate', pages: 'all', delta: 90 }]);
    const r = await applyOps(turned.bytes, [{
      op: 'crop', pages: 'all', boxes: { 1: { x: 10, y: 10, w: 200, h: 200 } }
    }]);
    assert.match(r.report.join(' '), /skipped/);
  });

  await run('crop falls back to an inset percentage', async () => {
    const bytes = await multiPageDoc(1);
    const r = await applyOps(bytes, [{ op: 'crop', pages: 'all', inset: 10 }]);
    const info = await readInfo(r.bytes);
    const before = await readInfo(bytes);
    assert.ok(info.pages[0].width < before.pages[0].width);
    assert.ok(info.pages[0].height < before.pages[0].height);
  });

  await run('replace covers the old glyphs and writes the new word', async () => {
    const bytes = await multiPageDoc(2);
    const r = await applyOps(bytes, [{
      op: 'replace',
      hits: [
        { page: 1, text: 'needle', rects: [{ x: 60, y: 495, w: 60, h: 18, baseline: 500, size: 14 }] },
        { page: 2, text: 'needle', rects: [{ x: 60, y: 495, w: 60, h: 18, baseline: 500, size: 14 }] }
      ],
      replacement: 'haystack'
    }]);
    assert.equal(r.pageCount, 2);
    assert.match(r.report.join(' '), /2 occurrence\(s\) replaced/);
    assert.equal(await pageCount(r.bytes), 2);
    await assert.rejects(() => applyOps(bytes, [{ op: 'replace', hits: [{ page: 1, rects: [{ x: 1, y: 1, w: 10, h: 10 }] }], replacement: '  ' }]), /empty/);
  });

  await run('stamp and page numbers draw on the chosen pages', async () => {
    const bytes = await multiPageDoc(3);
    const r = await applyOps(bytes, [
      { op: 'stamp', pages: 'all', text: 'CONFIDENTIAL', size: 20, bold: true, position: 'top-right', opacity: 0.5 },
      { op: 'pageNumbers', pages: 'even', format: '{n} / {total}', start: 5, position: 'bottom-left' }
    ]);
    assert.equal(r.pageCount, 3);
    assert.equal(await pageCount(r.bytes), 3);
    await assert.rejects(() => applyOps(bytes, [{ op: 'stamp', pages: 'all', text: '  ' }]), /empty/);
  });

  await run('metadata sets and clears', async () => {
    const bytes = await multiPageDoc(1);
    const set = await applyOps(bytes, [{
      op: 'metadata', title: 'Field notes', author: 'A. Lovelace', subject: 'Engines', keywords: 'a, b; c', creator: 'Quire'
    }]);
    const info = await readInfo(set.bytes);
    assert.equal(info.metadata.title, 'Field notes');
    assert.equal(info.metadata.author, 'A. Lovelace');
    assert.equal(info.metadata.keywords, 'a b c');

    const cleared = await applyOps(set.bytes, [{ op: 'metadata', title: '' }]);
    assert.equal((await readInfo(cleared.bytes)).metadata.title, '');
    // undefined leaves it alone
    const untouched = await applyOps(set.bytes, [{ op: 'metadata', author: undefined }]);
    assert.equal((await readInfo(untouched.bytes)).metadata.title, 'Field notes');
  });

  await run('ops compose in one call', async () => {
    const bytes = await multiPageDoc(4);
    const r = await applyOps(bytes, [
      { op: 'delete', pages: '2' },
      { op: 'duplicate', pages: '1' },
      { op: 'reverse' },
      { op: 'stamp', pages: 'odd', text: 'X' }
    ]);
    assert.deepEqual(r.mapping, [4, 3, null, 1]);
  });

  await run('merge appends another PDF and reports it', async () => {
    const bytes = await multiPageDoc(2);
    const other = await multiPageDoc(3);
    const r = await applyOps(bytes, [{ op: 'merge', bytes: other, name: 'other.pdf', after: 2 }]);
    assert.equal(r.pageCount, 5);
    assert.deepEqual(r.mapping, [1, 2, null, null, null]);
    assert.match(r.report.join(' '), /merged 3 page\(s\) from other.pdf/);
    await assert.rejects(() => applyOps(bytes, [{ op: 'merge', bytes: null }]), /needs a file path/);
  });

  await run('merge can take a file path and a page range', async () => {
    const bytes = await multiPageDoc(1);
    const r = await applyOps(bytes, [{ op: 'merge', filePath: SAMPLE, pages: '1' }]);
    assert.equal(r.pageCount, 2);
    assert.deepEqual(r.mapping, [1, null]);
  });

  await run('readFields normalizes text, check and dropdown fields', async () => {
    const bytes = await formDoc();
    const info = await readInfo(bytes);
    assert.equal(info.hasForm, true);
    const { fields, hasXFA } = await readFields(bytes);
    assert.equal(hasXFA, false);
    assert.equal(fields.length, 3);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    assert.equal(byName['applicant.name'].kind, 'text');
    assert.equal(byName['applicant.name'].value, 'Ada');
    assert.equal(byName['applicant.name'].page, 1);
    assert.equal(byName.agree.kind, 'checkbox');
    assert.equal(byName.agree.value, true);
    assert.equal(byName.size.kind, 'dropdown');
    assert.deepEqual(byName.size.options, ['small', 'large']);
    assert.equal(byName.size.value, 'large');
  });

  await run('formValues writes, flattens and clears', async () => {
    const bytes = await formDoc();
    const filled = await applyOps(bytes, [{
      op: 'formValues', values: { 'applicant.name': 'Grace', agree: false, size: 'small' }
    }]);
    const after = await readFields(filled.bytes);
    const byName = Object.fromEntries(after.fields.map((f) => [f.name, f]));
    assert.equal(byName['applicant.name'].value, 'Grace');
    assert.equal(byName.agree.value, false);
    assert.equal(byName.size.value, 'small');

    const cleared = await applyOps(bytes, [{ op: 'clearForm' }]);
    const blank = Object.fromEntries((await readFields(cleared.bytes)).fields.map((f) => [f.name, f]));
    assert.equal(blank['applicant.name'].value, '');
    assert.equal(blank.agree.value, false);

    const flat = await applyOps(bytes, [{ op: 'flattenForms' }]);
    const flatInfo = await readInfo(flat.bytes);
    assert.equal(flatInfo.hasForm, false);
    assert.equal(flatInfo.fieldCount, 0);
  });

  await run('the sample PDF survives a full pass', async () => {
    const bytes = fs.readFileSync(SAMPLE);
    const before = await readInfo(bytes);
    const r = await applyOps(bytes, [
      { op: 'rotate', pages: 'odd', delta: 180 },
      { op: 'stamp', pages: 'all', text: 'reviewed', position: 'top-left' },
      { op: 'pageNumbers', pages: 'all', format: '{n}' },
      { op: 'metadata', title: 'Sample' }
    ]);
    assert.equal(r.pageCount, before.pageCount);
    assert.deepEqual(r.mapping, before.pages.map((_, i) => i + 1));
    const info = await readInfo(r.bytes);
    assert.equal(info.metadata.title, 'Sample');
  });

  await run('unknown ops are reported, not thrown', async () => {
    const bytes = await multiPageDoc(1);
    const r = await applyOps(bytes, [{ op: 'nonsense' }]);
    assert.match(r.report.join(' '), /unknown op: nonsense/);
  });
}

main().then(() => {
  console.log(process.exitCode ? 'doc-edit: failures' : 'doc-edit: all ops ok');
});
