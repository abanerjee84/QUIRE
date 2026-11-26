/**
 * End-to-end check against the real window: open the sample PDF, drag-select a
 * line to highlight, drop a note, ink, search, export both ways, erase, undo,
 * and mark a page that has no text layer. Screenshots land in test/out/.
 */
const path = require('node:path');
const fs = require('node:fs');

const { ROOT, launch, attach, sleep, ensureSamples } = require('./cdp');
const { PDFDocument, PDFName, PDFArray } = require('pdf-lib');

const SAMPLE = path.join(ROOT, 'samples', 'quire-sample.pdf');
const SCAN = path.join(ROOT, 'samples', 'scan-sample.pdf');
const OUT = path.join(ROOT, 'test', 'out');
const PORT = 9223;

ensureSamples();

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(path.join(ROOT, 'samples', 'quire-sample.pdf.marks.json'), { force: true });
  fs.rmSync(path.join(ROOT, 'samples', 'scan-sample.pdf.marks.json'), { force: true });

  const { child, log } = launch({ port: PORT, args: [SAMPLE] });

  let browser;
  try {
    const { browser: b, page } = await attach(PORT);
    browser = b;

    const errors = [];
    const consoleLines = [];
    page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); consoleLines.push('PAGEERROR ' + e.message); });
    page.on('console', (m) => {
      const line = m.type().toUpperCase() + ' ' + m.text();
      consoleLines.push(line);
      if (m.type() === 'error') errors.push('console: ' + m.text());
    });

    try {
      await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 3, { timeout: 20000 });
    } catch (err) {
      const diag = await page.evaluate(() => ({
        url: location.href,
        toast: document.querySelector('.toast')?.textContent || null,
        status: document.getElementById('status-file')?.textContent,
        wraps: document.querySelectorAll('.page-wrap').length,
        hasApi: typeof window.api,
        hasApp: typeof window.__quire
      })).catch(() => 'evaluate failed');
      console.error('console output:', consoleLines.join('\n'));
      console.error('diagnostics:', diag);
      throw err;
    }
    console.log('loaded 3 pages');

    // canvases actually painted?
    await page.waitForFunction(() => {
      const c = document.querySelector('.page-wrap canvas');
      return c && c.width > 100;
    }, { timeout: 20000 });
    console.log('page canvas painted');

    // text layer + item boxes (extracted right after each page paints)
    await page.waitForFunction(() => !!window.__quire.viewer.pages[0]?.text, { timeout: 20000 });
    const textStats = await page.evaluate(() => {
      const p = window.__quire.viewer.pages[0];
      return { spans: p.elems.length, boxes: p.itemBoxes.length, chars: p.text.str.length };
    });
    console.log('text layer:', textStats);
    if (textStats.spans < 10 || textStats.chars < 400) throw new Error('text layer too thin');

    // drag-select a phrase -> highlight
    const target = await page.evaluate(() => {
      const span = [...document.querySelectorAll('.text-layer span')].find((s) => s.textContent.includes('sidecar'));
      if (!span) return null;
      span.scrollIntoView({ block: 'center' });
      const r = span.getBoundingClientRect();
      return { x: r.left, y: r.top + r.height / 2, w: r.width };
    });
    if (!target) throw new Error('could not find sample text');
    await sleep(300);
    await page.mouse.move(target.x + 2, target.y);
    await page.mouse.down();
    await page.mouse.move(target.x + Math.min(target.w, 200), target.y, { steps: 12 });
    await page.mouse.up();
    await sleep(400);

    const marks = await page.evaluate(() => window.__quire.annotator.list);
    console.log('after drag:', marks.length, 'mark(s)', marks[0] && marks[0].kind, marks[0] && JSON.stringify(marks[0].rects));
    if (marks.length < 1 || marks[0].kind !== 'highlight') throw new Error('selection did not produce a highlight');

    // note tool
    await page.evaluate(() => document.querySelector('[data-tool="note"]').click());
    const spot = await page.evaluate(() => {
      const wrap = document.querySelectorAll('.page-wrap')[1];
      wrap.scrollIntoView({ block: 'start' });
      const r = wrap.getBoundingClientRect();
      return { x: r.left + r.width * 0.6, y: r.top + 100 };
    });
    await sleep(300);
    await page.mouse.click(spot.x, spot.y);
    await sleep(300);
    await page.type('.note-editor textarea', 'Verify margins');
    await page.click('.note-editor .btn.primary');
    await sleep(300);
    const kinds = await page.evaluate(() => window.__quire.annotator.list.map((a) => a.kind));
    console.log('kinds now:', kinds);
    if (!kinds.includes('note')) throw new Error('note not created');

    // ink stroke
    await page.evaluate(() => document.querySelector('[data-tool="ink"]').click());
    const box = await page.evaluate(() => {
      const wrap = document.querySelectorAll('.page-wrap')[0];
      wrap.scrollIntoView({ block: 'end' });
      const r = wrap.getBoundingClientRect();
      return { x: r.left + 80, y: r.bottom - 200 };
    });
    await sleep(300);
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + 60, { steps: 15 });
    await page.mouse.up();
    await sleep(300);
    const inkCount = await page.evaluate(() => window.__quire.annotator.list.filter((a) => a.kind === 'ink').length);
    console.log('ink strokes:', inkCount);

    // search
    await page.click('#search-input');
    await page.type('#search-input', 'annotations');
    await page.waitForFunction(() => /match/.test(document.getElementById('search-count').textContent), { timeout: 15000 });
    console.log('search:', await page.$eval('#search-count', (n) => n.textContent));

    // zoom
    await page.evaluate(() => window.__quire.viewer.fitPage());
    await sleep(400);
    console.log('zoom label:', await page.$eval('#zoom-label', (n) => n.textContent));

    // marks sidecar written by the autosave
    await sleep(1400);
    const sidecar = path.join(ROOT, 'samples', 'quire-sample.pdf.marks.json');
    const saved = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    console.log('sidecar:', saved.format, saved.annotations.length, 'annotations ->', saved.document.name);
    if (saved.annotations.length < 3) throw new Error('sidecar missing annotations');

    // sidebar index + thumbnail
    await page.click('.tab[data-tab="marks"]');
    await sleep(300);
    const rows = await page.$$eval('.mark-row', (n) => n.length);
    console.log('annotation rows in sidebar:', rows);
    const thumbs = await page.$$eval('.thumb-frame canvas', (n) => n.length);
    console.log('thumbnails painted:', thumbs);

    await page.evaluate(() => window.__quire.viewer.fitWidth());
    await sleep(600);
    await page.screenshot({ path: path.join(OUT, 'e2e-view.png'), fullPage: false });
    console.log('screenshot written');

    // export both ways into files this script can inspect
    const outAnnot = path.join(OUT, 'export-annot.pdf');
    const outFlat = path.join(OUT, 'export-flat.pdf');
    await page.evaluate(async (t) => { await window.__quire.exportPdf('annot', t); }, outAnnot);
    await page.evaluate(async (t) => { await window.__quire.exportPdf('flatten', t); }, outFlat);

    const exported = await PDFDocument.load(fs.readFileSync(outAnnot));
    const subtypes = [];
    for (const p of exported.getPages()) {
      const arr = exported.context.lookup(p.node.get(PDFName.of('Annots')), PDFArray);
      if (!arr) continue;
      for (let i = 0; i < arr.size(); i++) {
        subtypes.push(String(exported.context.lookup(arr.get(i)).get(PDFName.of('Subtype'))));
      }
    }
    console.log('exported annotation objects:', subtypes);
    for (const want of ['/Highlight', '/Ink', '/Text']) {
      if (!subtypes.includes(want)) throw new Error('export missing ' + want);
    }

    // reopen the flattened file: markup must survive with no sidecar at all
    await page.evaluate(async (p) => { await window.__quire.closeDocument(); await window.__quire.openPath(p); }, outFlat);
    await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 3, { timeout: 20000 });
    await sleep(1600);
    const flatMarks = await page.evaluate(() => window.__quire.annotator.list.length);
    console.log('flattened file reopened with', flatMarks, 'sidecar marks (expect 0)');
    await page.screenshot({ path: path.join(OUT, 'e2e-flattened.png') });

    // back to the original: annotations come from the sidecar
    await page.evaluate(() => window.__quire.closeDocument());
    await page.evaluate(async (p) => { await window.__quire.openPath(p); }, SAMPLE);
    await page.waitForFunction((p) => window.__quire.state.doc && window.__quire.annotator.list.length >= 3, { timeout: 20000 }, SAMPLE);
    console.log('reopened with', await page.evaluate(() => window.__quire.annotator.list.length), 'annotations restored');

    // eraser deletes what it clicks, undo puts it back
    await page.evaluate(() => document.querySelector('[data-tool="eraser"]').click());
    const annSpot = await page.evaluate(() => {
      const a = window.__quire.annotator.list.find((x) => x.kind === 'highlight');
      const page = window.__quire.viewer.pages[a.page - 1];
      page.shell.scrollIntoView({ block: 'start' });
      const r = page.shell.getBoundingClientRect();
      const s = window.__quire.viewer.scale;
      return { x: r.left + (a.rects[0].x + a.rects[0].w / 2) * s, y: r.top + (a.rects[0].y + a.rects[0].h / 2) * s };
    });
    await sleep(300);
    await page.mouse.click(annSpot.x, annSpot.y);
    await sleep(300);
    const afterErase = await page.evaluate(() => window.__quire.annotator.list.map((a) => a.kind));
    console.log('after erase:', afterErase);
    if (afterErase.includes('highlight')) throw new Error('eraser did not remove the highlight');

    await page.evaluate(() => window.__quire.annotator.undo());
    await sleep(300);
    const afterUndo = await page.evaluate(() => window.__quire.annotator.list.map((a) => a.kind));
    console.log('after undo:', afterUndo);
    if (!afterUndo.includes('highlight')) throw new Error('undo did not restore the highlight');

    // pages tab: thumbnails of every page
    await page.click('.tab[data-tab="thumbs"]');
    await sleep(900);
    await page.screenshot({ path: path.join(OUT, 'e2e-pages.png') });
    console.log('pages screenshot written');

    // scanned page: no text layer, so a dragged box becomes the highlight
    await page.evaluate(() => window.__quire.closeDocument());
    await page.evaluate(async (p) => { await window.__quire.openPath(p); }, SCAN);
    await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 1, { timeout: 20000 });
    await sleep(900);
    console.log('scan page text spans:', await page.evaluate(() => window.__quire.viewer.pages[0].elems.length));
    await page.evaluate(() => document.querySelector('[data-tool="highlight"]').click());
    const dragBox = await page.evaluate(() => {
      const r = document.querySelector('.page-wrap').getBoundingClientRect();
      return { x: r.left + r.width * 0.25, y: r.top + 140, w: r.width * 0.5 };
    });
    await page.mouse.move(dragBox.x, dragBox.y);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + dragBox.w, dragBox.y + 90, { steps: 12 });
    await page.mouse.up();
    await sleep(400);
    const freeform = await page.evaluate(() =>
      window.__quire.annotator.list.filter((a) => a.kind === 'highlight').map((a) => a.rects));
    console.log('freeform highlights:', JSON.stringify(freeform));
    if (!freeform.length || !freeform[0][0].w) throw new Error('freeform highlight not created on the scanned page');
    await page.screenshot({ path: path.join(OUT, 'e2e-scan.png') });

    if (errors.length) throw new Error('renderer errors:\n' + errors.join('\n'));
    console.log('\ne2e: ok');
  } catch (err) {
    console.error('e2e FAILED:', err.message);
    console.error('--- electron log ---\n' + log.join('').slice(-3000));
    process.exitCode = 1;
  } finally {
    if (browser) browser.disconnect();
    child.kill();
  }
}

main();
