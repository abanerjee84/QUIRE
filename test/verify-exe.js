/**
 * Drive the packaged Windows exe the same way the dev window is driven: open the
 * sample PDF from argv, drag a highlight, save the sidecar, export, screenshot.
 * Run `npm run build` first.
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { ROOT, launch, attach, sleep, ensureSamples } = require('./cdp');
const { PDFDocument, PDFName, PDFArray } = require('pdf-lib');

// --exe runs a specific binary, --portable the newest exe in dist/, otherwise the unpacked build.
const flag = process.argv.indexOf('--exe');
function newestPortable() {
  // build/portable/ holds the copy banked by tools/dist.js; dist/ is where
  // electron-builder writes it, and antivirus tends to empty it.
  for (const dir of [path.join(ROOT, 'build', 'portable'), path.join(ROOT, 'dist')]) {
    if (!fs.existsSync(dir)) continue;
    const exes = fs.readdirSync(dir)
      .filter((f) => /portable/i.test(f) && f.toLowerCase().endsWith('.exe'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (exes.length) return path.join(dir, exes[0].f);
  }
  return null;
}
const EXE = flag > -1 ? path.resolve(process.argv[flag + 1])
  : process.argv.includes('--portable') ? newestPortable() || ''
  : path.join(ROOT, 'build', 'Quire-win32-x64', 'Quire.exe');
const SAMPLE = path.join(ROOT, 'samples', 'quire-sample.pdf');
const MARKDOWN = path.join(ROOT, 'samples', 'quire-sample.md');
const OUT = path.join(ROOT, 'test', 'out');
const SIDECAR = path.join(ROOT, 'samples', 'quire-sample.pdf.marks.json');
const MD_SIDECAR = path.join(ROOT, 'samples', 'quire-sample.md.marks.json');
const EXPORT = path.join(ROOT, 'test', 'out', 'exe-export.pdf');
const MD_EXPORT = path.join(ROOT, 'test', 'out', 'exe-markdown-export.pdf');
const PORT = 9228;

function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', shell: true });
  } else {
    child.kill();
  }
}

// Antivirus on this machine holds a freshly written exe under an exclusive
// handle — even a plain read open fails — for minutes after the build.
const SCAN_WAIT = Number(process.env.QUIRE_SCAN_WAIT || 10 * 60 * 1000);

/** Poll until the file can be opened for reading. False when the scanner never let go. */
async function waitForOpen(file, label, maxMs = SCAN_WAIT) {
  const t0 = Date.now();
  let reported = 0;
  while (Date.now() - t0 < maxMs) {
    try {
      const h = fs.openSync(file, 'r');
      fs.closeSync(h);
      if (Date.now() > t0 + 1000) console.log('  ' + label + ' unlocked after ' + Math.round((Date.now() - t0) / 1000) + ' s');
      return true;
    } catch {
      const secs = Math.round((Date.now() - t0) / 1000);
      if (secs >= reported + 30) { reported = secs; console.log('  ' + label + ' still locked by the scanner (' + secs + ' s)'); }
      await sleep(2000);
    }
  }
  return false;
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error('verify:exe FAILED — nothing to test at ' + EXE + '; run npm run build (or npm run dist) first');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  let target = EXE;
  if (!await waitForOpen(target, 'target exe', Math.min(SCAN_WAIT, 60000))) {
    console.error('verify:exe FAILED — requested executable is unavailable or locked; no substitute was tested.');
    process.exit(1);
  }
  console.log('testing ' + path.relative(ROOT, target));
  ensureSamples();
  fs.rmSync(SIDECAR, { force: true });
  fs.rmSync(MD_SIDECAR, { force: true });
  fs.rmSync(EXPORT, { force: true });
  fs.rmSync(MD_EXPORT, { force: true });
  // Marks left over in the appData fallback would be loaded instead of the
  // sidecar, so start from a clean slate.
  for (const name of ['Quire', 'quire']) {
    const dir = path.join(process.env.APPDATA || '', name, 'marks');
    for (const f of ['quire-sample.pdf.json', 'quire-sample.md.json', 'quire-sample.json']) fs.rmSync(path.join(dir, f), { force: true });
  }

    let child;
  let log = [];
  let browser;
  let page;
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (!fs.existsSync(target)) {
      console.error('verify:exe FAILED — ' + target + ' disappeared. Antivirus deletes portable exes shortly after a build; rebuild and verify in one command:\n  node tools/dist.js portable && npm run verify:portable');
      process.exit(1);
    }
    let started;
    try {
      started = launch({ binary: target, app: null, port: PORT, args: [SAMPLE] });
    } catch (err) {
      // Windows reports spawn UNKNOWN while antivirus still holds the file.
      console.log('  spawn attempt ' + attempt + ' threw ' + (err.code || '') + '; waiting for the scanner to let go');
      await waitForOpen(target, 'exe', 90000);
      continue;
    }
    child = started.child;
    log = started.log;
    // A spawn refused by an antivirus handle (Windows UNKNOWN, errno -4094) can
    // arrive long after 'spawn'. Keep a listener so it lands in the log instead
    // of becoming an unhandled 'error' event that takes the run down.
    child.on('error', (err) => log.push('spawn error: ' + (err.code || err.message)));
    const failure = await new Promise((resolve) => {
      const settle = (err) => { clearTimeout(timer); child.off('error', onError); child.off('spawn', onSpawn); resolve(err); };
      const onError = (err) => settle(err);
      const onSpawn = () => settle(null);
      child.once('error', onError);
      child.once('spawn', onSpawn);
      const timer = setTimeout(() => settle(null), 4000);
    });
    if (failure) {
      console.log('  spawn attempt ' + attempt + ' failed (' + (failure.code || failure.message) + '); waiting for the scanner to let go');
      killTree(child);
      child = null;
      await sleep(4000);
      continue;
    }
    try {
      ({ browser, page } = await attach(PORT, 90000));
      break;
    } catch (err) {
      console.log('  attempt ' + attempt + ': ' + err.message + ' — restarting the exe');
      killTree(child);
      child = null;
      await sleep(4000);
    }
  }
  if (!browser) {
    console.error('verify:exe FAILED — ' + target + ' gave no debug target after 6 attempts');
    console.log('--- exe log ---\n' + log.join(''));
    if (child) killTree(child);
    process.exit(1);
  }

  try {

    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    try {
      await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 3, { timeout: 25000 });
    } catch (err) {
      const diag = await page.evaluate(() => ({
        url: location.href,
        toast: document.querySelector('.toast')?.textContent || null,
        wraps: document.querySelectorAll('.page-wrap').length,
        hasApi: typeof window.api,
        hasApp: typeof window.__quire
      })).catch(() => 'evaluate failed');
      console.error('exe diagnostics:', JSON.stringify(diag));
      console.error('exe stderr:\n' + log.join(''));
      throw err;
    }
    console.log('exe loaded 3 pages from argv');

    const boot = await page.evaluate(() => window.api.boot());
    console.log('boot:', JSON.stringify({ initialFile: boot.initialFile ? path.basename(boot.initialFile) : null, version: boot.version }));
    if (!boot.initialFile) throw new Error('exe did not pick up the file argument');

    await page.waitForFunction(() => !!window.__quire.viewer.pages[0]?.text, { timeout: 20000 });
    const text = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.page-wrap .text-layer span')];
      return { spans: spans.length, chars: spans.reduce((n, s) => n + s.textContent.length, 0) };
    });
    console.log('text layer:', JSON.stringify(text));
    if (!text.spans) throw new Error('text layer empty in packaged build');

    // drag-select a line: the highlight must come out in PDF points. Fit-width
    // layout can still be settling when the page first paints, so measure, wait,
    // measure again and only drag once the span has stopped moving.
    const spotAt = () => page.evaluate(() => {
      const span = document.querySelector('.page-wrap .text-layer span');
      if (!span) return null;
      const r = span.getBoundingClientRect();
      return { x: r.left + 2, y: r.top + r.height / 2 };
    });
    await page.evaluate(() => window.__quire.annotator.setTool('highlight'));
    const marks = [];
    for (let attempt = 1; attempt <= 3 && !marks.length; attempt++) {
      const spot = await spotAt();
      if (!spot) break;
      await sleep(400);
      const settled = await spotAt();
      if (!settled) break;
      if (Math.abs(settled.y - spot.y) > 1 || Math.abs(settled.x - spot.x) > 1) continue;
      await page.mouse.move(settled.x, settled.y);
      await page.mouse.down();
      await page.mouse.move(settled.x + 120, settled.y, { steps: 8 });
      await page.mouse.up();
      await sleep(300);
      marks.push(...await page.evaluate(() => window.__quire.annotator.list.map((a) => ({ kind: a.kind, page: a.page, rects: a.rects.length }))));
      if (!marks.length) console.log('drag attempt ' + attempt + ' landed on nothing, trying again');
    }
    console.log('after drag:', JSON.stringify(marks));
    if (!marks.some((m) => m.kind === 'highlight')) throw new Error('drag produced no highlight in packaged build');

    // Autosave is the promise the README makes: give it a few seconds on its own
    // before asking for the save explicitly.
    let autosaved = null;
    for (let i = 0; i < 8 && !autosaved; i++) {
      await sleep(500);
      if (fs.existsSync(SIDECAR)) autosaved = (i + 1) * 500;
    }
    console.log(autosaved ? `autosave wrote the sidecar in ~${autosaved} ms` : 'autosave did not write within 4 s');

    // Ask for the save directly: the autosave debounce is covered by the e2e run,
    // here we want the IPC write itself and the path it chose.
    fs.rmSync(SIDECAR, { force: true });
    const saved = await page.evaluate(() => window.__quire.saveMarks());
    console.log('saveMarks wrote:', JSON.stringify(saved));
    if (typeof saved !== 'string' || !fs.existsSync(saved)) {
      const why = await page.evaluate(() => ({ doc: window.__quire.state.doc?.path, saveFile: window.__quire.state.saveFile }));
      throw new Error('no sidecar written by the packaged app (' + JSON.stringify(why) + ' -> ' + JSON.stringify(saved) + ')');
    }
    if (saved !== SIDECAR) throw new Error('sidecar went to the fallback instead of beside the document: ' + saved);
    const sidecar = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
    console.log('sidecar:', sidecar.format, sidecar.annotations.length, 'annotation(s) ->', sidecar.document.name);
    if (sidecar.format !== 'quire-marks/1' || !sidecar.annotations.length) throw new Error('sidecar wrong');

    // export with a forced target: real PDF annotation objects
    const written = await page.evaluate((target) => window.__quire.exportPdf('annot', target), EXPORT);
    console.log('export wrote:', written ? path.basename(written) : null);
    if (!fs.existsSync(EXPORT)) throw new Error('exported file missing');
    const doc = await PDFDocument.load(fs.readFileSync(EXPORT));
    const subtypes = [];
    for (const p of doc.getPages()) {
      const arr = doc.context.lookup(p.node.get(PDFName.of('Annots')), PDFArray);
      if (!arr) continue;
      for (let i = 0; i < arr.size(); i++) {
        const node = doc.context.lookup(arr.get(i));
        const sub = node?.get?.(PDFName.of('Subtype'));
        if (sub) subtypes.push(String(sub));
      }
    }
    console.log('exported annotation objects:', JSON.stringify(subtypes.sort()));
    if (!subtypes.includes('/Highlight')) throw new Error('export has no /Highlight annotation');

    /* ------------------------------------------- markdown in the packaged build */
    // marked and katex ship as vendor mounts; a pruned package is the easy way
    // to lose them, so render, typeset, search, mark and export one here.
    await page.evaluate((p) => window.__quire.openPath(p), MARKDOWN);
    await page.waitForFunction(() => window.__quire.state.kind === 'markdown' && document.querySelector('.md-article'), { timeout: 25000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.md-article img')].every((i) => i.complete), { timeout: 20000 }).catch(() => {});
    const md = await page.evaluate(() => ({
      blocks: document.querySelectorAll('.md-article > *').length,
      math: document.querySelectorAll('.md-article .katex').length,
      outline: document.querySelectorAll('.outline-item').length,
      tab: document.getElementById('tab-thumbs').textContent,
      images: [...document.querySelectorAll('.md-article img')].filter((i) => i.complete && i.naturalWidth).length
    }));
    console.log('markdown in packaged build:', JSON.stringify(md));
    if (md.blocks < 10 || md.math < 1 || md.outline < 1 || md.tab !== 'Outline' || md.images !== 1) {
      throw new Error('markdown did not render in the packaged build: ' + JSON.stringify(md));
    }

    await page.evaluate(() => {
      const i = document.getElementById('search-input');
      i.value = 'sidecar';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => window.__quire.search.hits.length > 0, { timeout: 15000 });
    const hits = await page.evaluate(() => ({ hits: window.__quire.search.hits.length, count: document.getElementById('search-count').textContent }));
    console.log('markdown search:', JSON.stringify(hits));
    if (!hits.hits) throw new Error('markdown search found nothing in the packaged build');

    // Clear hit marks first: they replace text nodes, and a node picked before
    // them is detached by the time the drag runs.
    await page.evaluate(() => window.__quire.search.reset());
    await page.waitForFunction(() => !window.__quire.search.busy && !document.querySelector('.hit-flash, .hit-current'), { timeout: 15000 });
    await sleep(500);

    // Pick a paragraph, put it on screen, then measure it again — rects taken
    // before the scroll settles would aim at the wrong pixels.
    const pick = (prefix) => page.evaluate((prefix) => {
      const article = document.querySelector('.md-article');
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      let node = null;
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.textContent.trim().length < 30) continue;
        if (n.parentElement.closest('.katex')) continue;
        const r = n.parentElement.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (prefix && !n.textContent.startsWith(prefix)) continue;
        node = n;
        break;
      }
      if (!node) return null;
      if (!prefix) { node.parentElement.scrollIntoView({ block: 'center' }); return { text: node.textContent.slice(0, 24), scrolled: true }; }
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 24);
      const a = range.getBoundingClientRect();
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: a.right - 1, y2: a.top + a.height / 2 };
    }, prefix);

    const picked = await pick();
    if (!picked) throw new Error('no paragraph text to select in the packaged markdown build');
    await sleep(500);
    const dragTo = await pick(picked.text);
    if (!dragTo) throw new Error('selected paragraph disappeared before the drag');
    // Read it twice: if the article is still moving, the first drag lands on the
    // wrong line and marks nothing.
    const settledAgain = await pick(picked.text);
    if (!settledAgain || Math.abs(settledAgain.y1 - dragTo.y1) > 1 || Math.abs(settledAgain.x1 - dragTo.x1) > 1) {
      throw new Error('markdown layout still moving before the drag');
    }
    await page.evaluate((p) => { window.__mdDragX = p.x1; window.__mdDragY = p.y1; }, dragTo);
    console.log('drag rect:', JSON.stringify(dragTo), 'paragraph', JSON.stringify(picked.text), 'viewport', await page.evaluate(() => [window.innerWidth, window.innerHeight]));
    await sleep(300);
    await page.evaluate(() => window.__quire.annotator.setTool('highlight'));
    const marksBefore = await page.evaluate(() => window.__quire.annotator.list.length);
    await page.mouse.move(dragTo.x1, dragTo.y1);
    await page.mouse.down();
    await page.mouse.move(dragTo.x1 + 20, dragTo.y1, { steps: 5 });
    await page.mouse.move(dragTo.x2, dragTo.y2, { steps: 10 });
    await page.mouse.up();
    await sleep(400);
    const diag = await page.evaluate(() => ({
      tool: window.__quire.annotator.tool,
      kind: window.__quire.state.kind,
      sel: (() => { const s = window.getSelection(); return s && !s.isCollapsed ? s.toString().slice(0, 30) : 'collapsed'; })(),
      under: (() => { const el = document.elementFromPoint(window.__mdDragX, window.__mdDragY); return el ? el.tagName + '.' + el.className : null; })()
    }));
    console.log('drag diagnostics:', JSON.stringify(diag));
    const mdMarks = await page.evaluate(() => window.__quire.annotator.list.map((a) => ({
      kind: a.kind,
      segs: (a.segs || []).map((s) => `block ${s.block}:${s.start}-${s.end}`),
      anchor: a.anchor || null
    })));
    console.log('markdown marks:', JSON.stringify(mdMarks));
    if (mdMarks.length !== marksBefore + 1) throw new Error(`markdown drag made no new mark (${marksBefore} -> ${mdMarks.length})`);
    if (!mdMarks.some((m) => m.kind === 'highlight' && m.segs.length)) throw new Error('dragging markdown text made no anchored highlight');

    const mdWrote = await page.evaluate(() => window.__quire.saveMarks());
    await sleep(600);
    if (!fs.existsSync(MD_SIDECAR)) throw new Error('markdown sidecar missing (' + mdWrote + ')');
    if (mdWrote !== MD_SIDECAR) throw new Error('markdown sidecar went to the fallback instead of beside the document: ' + mdWrote);
    const mdSidecar = JSON.parse(fs.readFileSync(MD_SIDECAR, 'utf8'));
    console.log('markdown sidecar:', mdSidecar.format, 'kind', mdSidecar.document.kind, mdSidecar.annotations.length, 'annotation(s)');
    if (mdSidecar.document.kind !== 'markdown' || !mdSidecar.annotations.length) throw new Error('markdown sidecar wrong');

    const mdWritten = await page.evaluate((target) => window.__quire.exportPdf('rendered', target), MD_EXPORT);
    if (!fs.existsSync(MD_EXPORT)) throw new Error('no rendered PDF from the packaged markdown view (' + mdWritten + ')');
    const mdHead = fs.readFileSync(MD_EXPORT).subarray(0, 5).toString('latin1');
    console.log('markdown export:', path.basename(MD_EXPORT), fs.statSync(MD_EXPORT).size, 'bytes, header', JSON.stringify(mdHead));
    if (mdHead !== '%PDF-') throw new Error('markdown export is not a PDF');

    await page.screenshot({ path: path.join(OUT, 'exe-view.png') });
    if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
    console.log('\nverify:exe: ok');
  } catch (err) {
    console.log('\nverify:exe FAILED: ' + err.message);
    if (log.length) console.log('--- exe log ---\n' + log.join('').slice(-2500));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
    killTree(child);
  }
}

main();
