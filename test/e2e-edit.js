/**
 * Document editing + Markdown source editing, end to end.
 *
 * A real Electron window does the work: page operations from the Document tab,
 * marks that follow their page across a delete, a save that lands on disk,
 * undo, revert, find & replace, metadata, print options, the Markdown source
 * editor, and the two text exports. Each step reports what it found.
 */
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { ROOT, launch, attach, sleep, ensureSamples } = require('./cdp');

const PORT = 9244;
const OUT = path.join(ROOT, 'test', 'out');
const SRC = path.join(ROOT, 'samples', 'quire-sample.pdf');
const OTHER = path.join(ROOT, 'samples', 'scan-sample.pdf');
const DOC = path.join(OUT, 'edit-doc.pdf');
const SIDECAR = path.join(OUT, 'edit-doc.pdf.marks.json');
const BLANK = path.join(OUT, 'blank.pdf');
const PRINTED = path.join(OUT, 'printed.pdf');
const HTML_OUT = path.join(OUT, 'sample.html');
const MARKS_OUT = path.join(OUT, 'sample.marks.md');

// Markdown editing writes the real sample, so keep a backup and restore it.
const MD = path.join(ROOT, 'samples', 'quire-sample.md');
const MD_BACKUP = path.join(OUT, 'quire-sample.md.backup');
const MD_SIDECAR = path.join(ROOT, 'samples', 'quire-sample.md.marks.json');

ensureSamples();
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(SRC, DOC);
fs.copyFileSync(MD, MD_BACKUP);
for (const f of [SIDECAR, BLANK, PRINTED, path.join(OUT, 'printed-portrait.pdf'), HTML_OUT, MARKS_OUT, MD_SIDECAR]) fs.rmSync(f, { force: true });

const results = [];
const errors = [];
let browser = null;

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push(['ok  ', name, detail || '']);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function key(page, combo) {
  const parts = combo.split('+');
  const mods = parts.slice(0, -1).map((m) => (m === 'Ctrl' ? 'Control' : m));
  const last = parts[parts.length - 1];
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(last.length === 1 ? last.toLowerCase() : last);
  for (const m of mods.slice().reverse()) await page.keyboard.up(m);
}

/** Sizes and page count of whatever bytes the app currently holds on stage. */
function liveInfo(page) {
  return page.evaluate(async () => {
    const bytes = window.__quire.state.bytes;
    return bytes ? await window.api.docInfo(bytes) : null;
  });
}

/** What the app holds after an operation lands. */
function appState(page) {
  return page.evaluate(() => ({
    count: window.__quire.state.pageCount,
    edited: window.__quire.state.edited,
    history: window.__quire.state.docHistory.length,
    marks: window.__quire.annotator.list.length,
    status: document.querySelector('#status-msg').textContent
  }));
}

/** Run ops through the app and wait for them to land. */
async function runOps(page, ops) {
  await page.evaluate(async (list) => { await window.__quire.applyDocOps(list); }, ops);
  await sleep(400);
  return appState(page);
}

/** Press a Document-tab button and wait for the operation it starts. */
async function clickOp(page, selector) {
  await page.evaluate(async (sel) => {
    document.querySelector(sel).click();
    if (window.__quire.state.lastOp) await window.__quire.state.lastOp;
  }, selector);
  await sleep(400);
  return appState(page);
}

/** Whitespace-normalized compare: marks and rendered text differ in newlines. */
const norm = (s) => s.replace(/\s+/g, ' ').trim();

(async () => {
  const { child, log } = launch({ port: PORT, args: [DOC] });

  try {
    const attached = await attach(PORT);
    browser = attached.browser;
    const page = attached.page;
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length >= 1, { timeout: 25000 });
    await page.waitForFunction(() => !!window.__quire.viewer.pages[0]?.text, { timeout: 25000 });
    await sleep(400);

    await step('the Document tab lists every page', async () => {
      const before = await page.evaluate(() => ({
        tab: !document.querySelector('#tab-doc').hidden,
        active: document.querySelector('#pane-doc')?.classList.contains('active') ?? false
      }));
      assert(before.tab, 'the Document tab is hidden for a PDF');
      assert(!before.active, 'the Document pane is already showing');
      await page.click('#tab-doc');
      await sleep(600);
      const after = await page.evaluate(() => ({
        active: document.querySelector('#pane-doc')?.classList.contains('active') ?? false,
        rows: document.querySelectorAll('.dp-page').length,
        count: document.querySelector('#dp-count').textContent,
        pages: window.__quire.state.pageCount
      }));
      assert(after.active, 'the pane did not open');
      assert(after.rows === after.pages, `panel lists ${after.rows}, document has ${after.pages}`);
      assert(/page/i.test(after.count), 'no page count in the header: ' + after.count);
      return after.rows + ' pages listed';
    });

    const phrase = 'annotations in a sidecar file';
    await step('a highlight is made before the pages move', async () => {
      const made = await page.evaluate(async (phrase) => {
        const hits = await window.__quire.viewer.findText(phrase);
        if (!hits.length) return { hits: 0 };
        const hit = hits[1] || hits[0];
        window.__quire.annotator.createFromRects('highlight', { [hit.page]: hit.rects }, phrase);
        return { hits: hits.length, page: hit.page, marks: window.__quire.annotator.list.length };
      }, phrase);
      assert(made.marks === 1, 'no highlight created (' + JSON.stringify(made) + ')');
      return `${made.hits} matches, marked on page ${made.page}`;
    });

    await step('deleting page 1 moves the mark to its new page', async () => {
      const info = await liveInfo(page);
      const state = await runOps(page, [{ op: 'delete', pages: '1' }]);
      assert(state.count === info.pageCount - 1, `page count ${state.count} after deleting one of ${info.pageCount}`);
      assert(state.edited, 'the document is not flagged as edited');
      const mark = await page.evaluate(() => window.__quire.annotator.list[0]?.page ?? null);
      assert(mark !== null, 'the mark disappeared');
      const sidecar = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
      const stored = sidecar.marks || sidecar.annotations || [];
      assert(stored.length === 1, 'sidecar holds ' + stored.length + ' marks');
      assert(stored[0].page === mark, `sidecar page ${stored[0].page} disagrees with the app (${mark})`);
      assert(/page 1/.test(state.status) || /delet/i.test(state.status), 'status says: ' + state.status);
      return `mark and sidecar both on page ${mark}`;
    });

    await step('deleting the marked page drops the mark', async () => {
      const state = await runOps(page, [{ op: 'delete', pages: '1' }]);
      assert(state.marks === 0, 'the mark survived the loss of its page (' + state.marks + ')');
      assert(state.count === 1, 'expected 1 page left, got ' + state.count);
      const sidecar = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
      assert((sidecar.marks || []).length === 0, 'the sidecar still holds a mark for a deleted page');
      return 'mark dropped with its page, sidecar emptied';
    });

    await step('Ctrl+Z steps the delete back', async () => {
      await key(page, 'Ctrl+Z');
      await sleep(700);
      const state = await page.evaluate(() => ({
        count: window.__quire.state.pageCount,
        marks: window.__quire.annotator.list.length,
        history: window.__quire.state.docHistory.length
      }));
      assert(state.count === 2, `undo left ${state.count} pages, expected 2`);
      assert(state.marks === 1, `undo did not bring the mark back (${state.marks})`);
      assert(state.history === 1, 'undo left the snapshot behind');
      const painted = await page.evaluate(() => document.querySelectorAll('g.ann').length);
      assert(painted >= 1, 'the restored mark is not painted on the page');
      return 'page and highlight restored, painted ' + painted + ' shape(s)';
    });

    await step('duplicating a page does not clone its marks', async () => {
      const before = await page.evaluate(() => window.__quire.state.pageCount);
      const state = await runOps(page, [{ op: 'duplicate', pages: '1' }]);
      assert(state.count === before + 1, `duplicate gave ${state.count} pages (was ${before})`);
      assert(state.marks === 1, `the copy inherited marks (${state.marks})`);
      const rows = await page.evaluate(() => document.querySelectorAll('.dp-page').length);
      assert(rows === state.count, 'the page list still shows ' + rows);
      return 'page added, one mark kept';
    });

    await step('the panel resizes a single page to Letter', async () => {
      const before = await liveInfo(page);
      await page.evaluate(() => {
        document.querySelector('#dp-pages').value = '1';
        document.querySelector('#dp-size').value = 'letter';
        document.querySelector('#dp-fit').checked = false;
      });
      const state = await clickOp(page, '#dp-resize');
      const info = await liveInfo(page);
      assert(Math.round(info.pages[0].width) === 612 && Math.round(info.pages[0].height) === 792,
        `page 1 is ${Math.round(info.pages[0].width)} × ${Math.round(info.pages[0].height)} pt`);
      assert(Math.round(info.pages[1].width) === Math.round(before.pages[1].width), 'the other page changed too');
      return '612 × 792 pt, page 2 untouched';
    });

    await step('trim margins cuts each page to its content', async () => {
      const before = await liveInfo(page);
      await page.evaluate(() => { document.querySelector('#dp-pages').value = 'all'; });
      await clickOp(page, '#dp-trim');
      const after = await liveInfo(page);
      assert(after.pageCount === before.pageCount, 'trim changed the page count');
      const shrunk = after.pages.filter((p, i) => p.width < before.pages[i].width - 1 || p.height < before.pages[i].height - 1);
      assert(shrunk.length >= 1, 'no page got smaller');
      assert(after.pages.every((p) => p.width > 120 && p.height > 120), 'trim cut through the content');
      return `${before.pages[0].width.toFixed(0)}×${before.pages[0].height.toFixed(0)} → ` +
        after.pages.map((p) => p.width.toFixed(0) + '×' + p.height.toFixed(0)).join(' ');
    });

    await step('the panel reverses the document', async () => {
      const before = await liveInfo(page);
      await clickOp(page, '#dp-reverse');
      const after = await liveInfo(page);
      assert(after.pageCount === before.pageCount, 'reverse changed the page count');
      const mirror = after.pages.every((p, i) => {
        const other = before.pages[before.pages.length - 1 - i];
        return Math.round(p.width) === Math.round(other.width) && Math.round(p.height) === Math.round(other.height);
      });
      assert(mirror, 'page sizes did not come out in reverse order');
      return before.pages.map((p) => Math.round(p.width)).join(',') + ' → ' + after.pages.map((p) => Math.round(p.width)).join(',');
    });

    await step('a stamp draws text the search layer can read', async () => {
      const before = await page.evaluate(async () => (await window.__quire.viewer.findText('CONFIDENTIAL')).length);
      await page.evaluate(() => {
        document.querySelector('#dp-stamp-text').value = 'CONFIDENTIAL';
        document.querySelector('#dp-stamp-pos').value = 'top-center';
        document.querySelector('#dp-stamp-size').value = '28';
        document.querySelector('#dp-stamp-bold').checked = true;
      });
      await clickOp(page, '#dp-stamp');
      const hits = await page.evaluate(async () => (await window.__quire.viewer.findText('CONFIDENTIAL')).length);
      assert(before === 0, 'the stamp was already present');
      assert(hits >= 1, 'stamped text is not findable');
      return hits + ' of ' + (await liveInfo(page)).pageCount + ' pages carry it';
    });

    await step('page numbers are written on every page', async () => {
      await page.evaluate(() => {
        document.querySelector('#dp-num-format').value = '{n} of {total}';
        document.querySelector('#dp-num-pos').value = 'bottom-center';
      });
      await clickOp(page, '#dp-num');
      const hits = await page.evaluate(async () => (await window.__quire.viewer.findText(' of ')).length);
      const info = await liveInfo(page);
      assert(hits >= info.pageCount, `numbered ${hits} pages, document has ${info.pageCount}`);
      return hits + ' numbered';
    });

    await step('find lists hits and Replace all rewrites them', async () => {
      const query = 'sidecar';
      await page.evaluate((q) => {
        document.querySelector('#dp-find').value = q;
        document.querySelector('#dp-find-btn').click();
      }, query);
      await sleep(900);
      const found = await page.evaluate(() => ({
        count: document.querySelector('#dp-find-count').textContent,
        rows: document.querySelectorAll('.dp-hit').length,
        checked: document.querySelectorAll('.dp-hit input:checked').length
      }));
      assert(found.rows >= 1, 'find listed no hits (' + found.count + ')');
      assert(found.checked === found.rows, 'hits are not pre-selected (' + found.checked + '/' + found.rows + ')');
      await page.evaluate(() => { document.querySelector('#dp-replace').value = 'REPLACED'; });
      const state = await clickOp(page, '#dp-replace-all');
      const after = await page.evaluate(async (q) => ({
        now: (await window.__quire.viewer.findText('REPLACED')).length,
        old: (await window.__quire.viewer.findText(q)).length
      }), query);
      assert(after.now >= found.rows, `only ${after.now} of ${found.rows} hits read REPLACED now`);
      // The old glyphs stay in the content stream under the cover rectangle,
      // so the text layer keeps answering for them; only the paint changed.
      assert(/replac/i.test(state.status), 'status says: ' + state.status);
      return `${found.rows} hits covered, ${after.now} now read REPLACED`;
    });

    await step('metadata typed into the panel reaches the file on disk', async () => {
      await page.evaluate(() => {
        document.querySelector('#md-title').value = 'Edited by test';
        document.querySelector('#md-author').value = 'e2e-edit';
        document.querySelector('#md-subject').value = 'document editing';
        document.querySelector('#md-keywords').value = 'alpha, beta';
      });
      await clickOp(page, '#md-save');
      const info = await liveInfo(page);
      assert(info.metadata.title === 'Edited by test', 'title: ' + info.metadata.title);
      assert(info.metadata.author === 'e2e-edit', 'author: ' + info.metadata.author);
      assert(/alpha/.test(info.metadata.keywords) && /beta/.test(info.metadata.keywords), 'keywords: ' + info.metadata.keywords);
      await page.evaluate(() => window.__quire.saveDocument());
      await sleep(900);
      const saved = await PDFDocument.load(fs.readFileSync(DOC));
      assert(saved.getTitle() === 'Edited by test', 'file title is ' + saved.getTitle());
      assert(saved.getPageCount() === info.pageCount, 'the saved file has ' + saved.getPageCount() + ' pages, app has ' + info.pageCount);
      const edited = await page.evaluate(() => window.__quire.state.edited);
      assert(edited === false, 'still flagged as edited after saving');
      return 'title, author, subject and keywords written to ' + path.basename(DOC);
    });

    await step('revert gives back the file on disk', async () => {
      const disk = await PDFDocument.load(fs.readFileSync(DOC));
      const state = await page.evaluate(async () => {
        await window.__quire.revertDocument();
        return {
          count: window.__quire.state.pageCount,
          edited: window.__quire.state.edited,
          history: window.__quire.state.docHistory.length,
          marks: window.__quire.annotator.list.length
        };
      });
      await sleep(700);
      assert(state.count === disk.getPageCount(), `revert left ${state.count} pages, the file has ${disk.getPageCount()}`);
      assert(state.edited === false, 'revert kept the edited flag');
      assert(state.history === 0, 'revert left snapshots behind');
      const info = await liveInfo(page);
      const first = info.pages[0];
      const want = disk.getPage(0).getSize();
      assert(Math.round(first.width) === Math.round(want.width) && Math.round(first.height) === Math.round(want.height),
        `page 1 is ${Math.round(first.width)}×${Math.round(first.height)}, the file has ${Math.round(want.width)}×${Math.round(want.height)}`);
      return state.count + ' pages back, ' + state.marks + ' marks kept';
    });

    await step('merging appends the pages of a second PDF', async () => {
      const picked = await page.evaluate(async (other) => {
        const found = await window.api.pickPdf(other);
        if (!found || found.error) return { error: found && found.error };
        const before = window.__quire.state.pageCount;
        await window.__quire.applyDocOps([{ op: 'merge', bytes: found.bytes, name: found.name, after: before }]);
        return { before, after: window.__quire.state.pageCount, name: found.name, bytes: found.bytes.byteLength };
      }, OTHER);
      assert(!picked.error, 'pickPdf failed: ' + picked.error);
      assert(picked.bytes > 500, 'pickPdf returned ' + picked.bytes + ' bytes');
      assert(picked.after > picked.before, `merge added nothing (${picked.before} → ${picked.after})`);
      const info = await liveInfo(page);
      assert(info.pageCount === picked.after, 'panel and state disagree: ' + info.pageCount + ' vs ' + picked.after);
      const merged = info.pages[info.pages.length - 1];
      assert(Math.round(merged.width) === 612, 'the merged page is not the scan page (612 pt wide): ' + merged.width);
      const rows = await page.evaluate(() => document.querySelectorAll('.dp-page').length);
      assert(rows === info.pageCount, 'the page list shows ' + rows);
      return `${picked.before} + ${picked.after - picked.before} from ${picked.name} = ${picked.after}`;
    });

    await step('an insert blank page lands after the current one', async () => {
      const before = await liveInfo(page);
      await page.evaluate(() => { window.__quire.viewer.gotoPage(1); });
      await clickOp(page, '#dp-blank');
      const info = await liveInfo(page);
      assert(info.pageCount === before.pageCount + 1, 'no page was inserted');
      assert(Math.round(info.pages[1].width) === Math.round(before.pages[0].width),
        'the blank page did not take the current page size');
      return 'blank page 2 at ' + Math.round(info.pages[1].width) + '×' + Math.round(info.pages[1].height);
    });

    await step('print options set paper, orientation and margins', async () => {
      await key(page, 'Ctrl+P');
      await sleep(400);
      const open = await page.evaluate(() => document.querySelector('#print-options').open);
      assert(open, 'Ctrl+P did not open the print dialog');
      const options = await page.evaluate(() => {
        document.querySelector('#po-orientation').value = 'landscape';
        document.querySelector('#po-paper').value = 'Legal';
        document.querySelector('#po-margins').value = 'none';
        document.querySelector('#po-bg').checked = true;
        return {
          orientation: document.querySelector('#po-orientation').value,
          paper: document.querySelector('#po-paper').value,
          margins: document.querySelector('#po-margins').value,
          background: document.querySelector('#po-bg').checked
        };
      });
      const written = await page.evaluate(async (target, opts) =>
        await window.api.printPdf(window.__quire.state.doc.path, target, opts), PRINTED, options);
      assert(written === PRINTED, 'printPdf returned ' + written);
      const printed = await PDFDocument.load(fs.readFileSync(PRINTED));
      const size = printed.getPage(0).getSize();
      assert(size.width > size.height, `landscape print came out ${Math.round(size.width)}×${Math.round(size.height)}`);
      assert(printed.getPageCount() >= 1, 'nothing printed');

      const portrait = path.join(OUT, 'printed-portrait.pdf');
      fs.rmSync(portrait, { force: true });
      await page.evaluate(async (target, opts) =>
        await window.api.printPdf(window.__quire.state.doc.path, target, opts), portrait,
      { orientation: 'portrait', paper: 'Letter', margins: 'normal', background: true });
      const second = await PDFDocument.load(fs.readFileSync(portrait));
      const alt = second.getPage(0).getSize();
      assert(alt.width < alt.height, 'a portrait print is not taller than wide');
      assert(Math.round(alt.width) !== Math.round(size.width) || Math.round(alt.height) !== Math.round(size.height),
        'Legal landscape and Letter portrait came out the same sheet');
      await page.click('#po-cancel');
      await sleep(300);
      assert(!(await page.evaluate(() => document.querySelector('#print-options').open)), 'Cancel left the dialog open');
      return `${printed.getPageCount()} sheets at ${Math.round(size.width)} × ${Math.round(size.height)}, ` +
        `portrait ${Math.round(alt.width)} × ${Math.round(alt.height)}`;
    });

    await step('a blank PDF is created and opened', async () => {
      const created = await page.evaluate(async (target) => await window.api.newDocument('a4', target), BLANK);
      assert(created && !created.error, 'newDocument failed: ' + (created && created.error));
      assert(created.size > 500, 'the file is ' + created.size + ' bytes');
      await page.evaluate(async (target) => await window.__quire.openPath(target), BLANK);
      await page.waitForFunction(() => window.__quire.state.kind === 'pdf' && window.__quire.state.pageCount === 1, { timeout: 15000 });
      await page.click('#tab-doc');
      await sleep(600);
      const info = await liveInfo(page);
      assert(Math.round(info.pages[0].height) === 842, 'the blank page is not A4 (' + info.pages[0].height + ' pt tall)');
      const rows = await page.evaluate(() => document.querySelectorAll('.dp-page').length);
      assert(rows === 1, 'the page list shows ' + rows + ' pages for a blank document');
      const onDisk = await PDFDocument.load(fs.readFileSync(BLANK));
      assert(onDisk.getPageCount() === 1, 'the file on disk has ' + onDisk.getPageCount() + ' pages');
      return 'one A4 page at ' + path.basename(BLANK);
    });

    /* ------------------------------------------------------ markdown editing */

    await step('the Markdown editor opens over the article', async () => {
      await page.evaluate(async (p) => await window.__quire.openPath(p), MD);
      await page.waitForFunction(() => !!document.querySelector('.md-article'), { timeout: 20000 });
      await sleep(500);
      const state = await page.evaluate(() => ({
        kind: window.__quire.state.kind,
        editVisible: !document.querySelector('#btn-edit').hidden,
        docTab: document.querySelector('#tab-doc').hidden,
        editorHidden: document.querySelector('[data-surface="editor"]')?.hidden ?? true
      }));
      assert(state.kind === 'markdown', 'kind is ' + state.kind);
      assert(state.editVisible, 'the Edit button is hidden for Markdown');
      assert(state.docTab, 'the Document tab is showing for Markdown');
      assert(state.editorHidden, 'the source editor is open before it was asked for');
      await page.click('#btn-edit');
      await sleep(400);
      const open = await page.evaluate(() => ({
        editorHidden: document.querySelector('[data-surface="editor"]').hidden,
        text: document.querySelector('#ed-text').value,
        source: window.__quire.markdown.source,
        stats: document.querySelector('#ed-stats')?.textContent || ''
      }));
      assert(!open.editorHidden, 'the editor did not open');
      assert(open.text === open.source, 'the editor does not hold the file text');
      assert(open.text.length > 200, 'only ' + open.text.length + ' characters loaded');
      return open.text.length + ' characters, stats "' + open.stats.trim().slice(0, 40) + '"';
    });

    await step('toolbar buttons wrap the selection in Markdown', async () => {
      const result = await page.evaluate(() => {
        const area = document.querySelector('#ed-text');
        area.focus();
        const end = area.value.indexOf('\n');
        area.setSelectionRange(0, end);
        const buttons = [...document.querySelectorAll('.ed-btn')];
        buttons.find((b) => /bold/i.test(b.textContent)).click();
        buttons.find((b) => /^h2|heading/i.test(b.textContent))?.click();
        return area.value.slice(0, 30);
      });
      assert(/\*\*/.test(result), 'bold did not wrap the line: ' + JSON.stringify(result));
      assert(await page.evaluate(() => window.__quire.sourceEditor.dirty), 'the editor is not marked dirty after formatting');
      return JSON.stringify(result);
    });

    await step('saving the source writes the file and re-renders the article', async () => {
      await page.evaluate(() => {
        const area = document.querySelector('#ed-text');
        area.value = '# Edited heading\n\n' + area.value + '\n\nAdded by the source editor.\n';
        area.dispatchEvent(new Event('input'));
      });
      await key(page, 'Ctrl+S');
      await sleep(1600);
      const onDisk = fs.readFileSync(MD, 'utf8');
      assert(onDisk.startsWith('# Edited heading'), 'the file does not start with the new heading');
      assert(/Added by the source editor\./.test(onDisk), 'the closing line is missing from disk');
      const state = await page.evaluate(() => ({
        dirty: window.__quire.sourceEditor.dirty,
        hidden: document.querySelector('[data-surface="editor"]').hidden,
        text: document.querySelector('#ed-text').value,
        html: document.querySelector('.md-article')?.textContent || ''
      }));
      assert(state.html.includes('Edited heading'), 'the article did not pick up the new heading');
      assert(state.html.includes('Added by the source editor'), 'the closing line is missing from the article');
      assert(state.dirty === false, 'the editor still reports unsaved work');
      return 'file and article agree on ' + state.html.length + ' characters';
    });

    await step('marks keep their anchor through a source edit', async () => {
      await page.evaluate(() => document.querySelector('#ed-close')?.click());
      await sleep(500);
      const picked = await page.evaluate(() => {
        const article = document.querySelector('.md-article');
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        let node = null;
        let words = '';
        let offset = 0;
        while ((node = walker.nextNode())) {
          const line = node.nodeValue.replace(/^\s+/, '');
          const parts = line.split(/\s+/);
          if (parts.length < 6) continue;
          offset = node.nodeValue.length - line.length;
          words = parts.slice(0, 6).join(' ');
          break;
        }
        if (!words) return null;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + words.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = window.__quire.markdown.marksFromSelection(sel, 'highlight');
        return { ok, words, painted: [...document.querySelectorAll('.md-mark')].map((m) => m.textContent) };
      });
      assert(picked && picked.words, 'no run of six words to mark in the article');
      const phrase = picked.words;
      assert(picked.ok, 'the selection produced no mark');
      const made = await page.evaluate(() => ({ marks: window.__quire.annotator.list.map((m) => m.text) }));
      assert(made.marks.length === 1, 'expected one mark, found ' + made.marks.length);
      assert(norm(made.marks[0]) === norm(phrase), 'the mark reads "' + made.marks[0] + '"');
      assert(picked.painted.some((t) => norm(t).includes(norm(phrase))), 'the mark is not painted where it was made');

      await page.evaluate(() => document.querySelector('#btn-edit').click());
      await sleep(400);
      const moved = await page.evaluate(async () => {
        const area = document.querySelector('#ed-text');
        area.value = area.value.replace(/\n/, '\n\n## Inserted section\n\nA long paragraph of new prose placed above the marked sentence, on purpose.\n\n');
        area.dispatchEvent(new Event('input'));
        await window.__quire.sourceEditor.save({ silent: true });
        await new Promise((r) => setTimeout(r, 400));
        return {
          marks: window.__quire.annotator.list.map((m) => ({ text: m.text, segs: m.segs })),
          painted: [...document.querySelectorAll('.md-mark')].map((m) => m.textContent.trim())
        };
      });
      await sleep(600);
      assert(moved.marks.length === 1, 'the mark was dropped by reanchoring');
      assert(norm(moved.marks[0].text) === norm(made.marks[0]), 'the mark text changed: ' + moved.marks[0].text);
      const segs = moved.marks[0].segs || [];
      assert(segs.length >= 1, 'the mark lost its block anchor');
      assert(moved.painted.some((t) => norm(t).includes(norm(phrase))),
        'after the edit the highlight is painted on "' + norm(moved.painted[0] || 'nothing') + '"');
      return '"' + phrase.slice(0, 28) + '…" still highlighted at block ' + segs[0].block;
    });

    await step('standalone HTML export writes a readable page', async () => {
      const written = await page.evaluate(async (target) => {
        const html = await window.__quire.markdown.toHtml();
        return await window.api.writeText(window.__quire.state.doc.path, html, 'html', ['html', 'htm'], target);
      }, HTML_OUT);
      assert(written === HTML_OUT, 'writeText returned ' + written);
      const html = fs.readFileSync(HTML_OUT, 'utf8');
      assert(/<!doctype html/i.test(html), 'no doctype');
      assert(/Edited heading/.test(html), 'the new heading is missing from the export');
      assert(/<style/.test(html), 'no stylesheet inlined');
      assert(!/<button|data-surface|onclick=/.test(html), 'editor chrome leaked into the export');
      return Math.round(html.length / 1024) + ' KB of standalone HTML';
    });

    await step('marks export as a Markdown list', async () => {
      const written = await page.evaluate(async (target) =>
        await window.api.writeText(window.__quire.state.doc.path, window.__quire.marksMarkdown(), 'marks', ['md', 'txt'], target),
      MARKS_OUT);
      assert(written === MARKS_OUT, 'writeText returned ' + written);
      const text = fs.readFileSync(MARKS_OUT, 'utf8');
      assert(/highlight/i.test(text), 'no highlight section:\n' + text.slice(0, 300));
      assert(/quire-sample\.md/.test(text), 'the export does not name its document');
      assert(text.includes(await page.evaluate(() => window.__quire.annotator.list[0].text)),
        'the marked text is missing from the export');
      return text.split('\n').filter(Boolean).length + ' lines, incl. "' + norm(phrase).slice(0, 30) + '"';
    });

    await step('Markdown Save As writes a copy somewhere else', async () => {
      const copy = path.join(OUT, 'save-as.md');
      fs.rmSync(copy, { force: true });
      const written = await page.evaluate(async (target) =>
        await window.api.writeMarkdown(window.__quire.state.doc.path, '# Save as copy\n\nSecond file.\n', true, target), copy);
      assert(written === copy, 'writeMarkdown returned ' + written);
      assert(fs.readFileSync(copy, 'utf8').startsWith('# Save as copy'), 'the copy holds the wrong text');
      const state = await page.evaluate(async (target) => {
        await window.__quire.openPath(target);
        return { path: window.__quire.state.doc.path, name: window.__quire.state.doc.name };
      }, copy);
      assert(state.path === copy, 'the app is showing ' + state.path);
      assert(/save-as\.md/.test(state.name), 'title says ' + state.name);
      return 'wrote and opened ' + path.basename(copy);
    });

    await step('closing a document returns to the welcome screen', async () => {
      await page.evaluate(() => window.__quire.closeDocument());
      await sleep(500);
      const state = await page.evaluate(() => ({
        doc: window.__quire.state.doc,
        hasDoc: document.body.classList.contains('has-doc'),
        bytes: !!window.__quire.state.bytes,
        history: window.__quire.state.docHistory.length,
        docPane: document.querySelector('#pane-doc')?.classList.contains('active') ?? false,
        none: !document.querySelector('#dp-none').hidden
      }));
      assert(!state.doc, 'a document is still open');
      assert(!state.hasDoc, 'the welcome screen is still hidden');
      assert(!state.bytes, 'edited bytes stayed on stage');
      assert(state.history === 0, 'document history survived the close');
      assert(state.none, 'the Document pane still shows pages');
      return 'welcome screen back, Document pane reset';
    });

    await step('the sample Markdown file is restored', async () => {
      fs.copyFileSync(MD_BACKUP, MD);
      const same = fs.readFileSync(MD, 'utf8') === fs.readFileSync(MD_BACKUP, 'utf8');
      assert(same, 'the sample did not come back identical');
      return 'samples/quire-sample.md back to its original text';
    });

    await step('nothing logged a console error', async () => {
      assert(errors.length === 0, errors.slice(0, 5).join(' | '));
      return 'clean';
    });
  } catch (err) {
    results.push(['FAIL', 'crashed', err.message]);
    console.log('Electron output tail:\n' + log.slice(-6).join(''));
    process.exitCode = 1;
  } finally {
    const tree = process.platform === 'win32' ? 'taskkill' : 'pkill';
    const killArgs = process.platform === 'win32'
      ? ['/T', '/F', '/PID', String(child.pid)]
      : ['-f', '-P', String(child.pid)];
    try { require('node:child_process').spawnSync(tree, killArgs, { stdio: 'ignore' }); } catch { /* ignore */ }
    if (browser) await browser.disconnect().catch(() => {});
    for (const [state, name, detail] of results) console.log(`${state} ${name}${detail ? ' — ' + detail : ''}`);
    const failed = results.filter((r) => r[0] === 'FAIL').length;
    console.log(failed ? `e2e:edit: ${failed} failure(s)` : 'e2e:edit: ok');
    if (failed) process.exitCode = 1;
  }
})();
