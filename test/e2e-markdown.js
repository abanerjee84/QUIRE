/**
 * Markdown + LaTeX end-to-end test.
 *
 * Opens samples/quire-sample.md in a real Electron window and exercises the
 * surface the way a person would: read the equations, search, jump between
 * headings, mark a sentence, write a note, undo it, save, reopen, export.
 * Each step reports on its own so one failure does not hide the rest.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, launch, attach, sleep, ensureSamples } = require('./cdp');

const PORT = 9243;
const MD = path.join(ROOT, 'samples', 'quire-sample.md');
const PDF = path.join(ROOT, 'samples', 'quire-sample.pdf');
const TXT = path.join(ROOT, 'samples', 'notes.txt');
const NOTADOC = path.join(ROOT, 'package.json');
const SIDECAR = path.join(ROOT, 'samples', 'quire-sample.md.marks.json');
const OUT = path.join(ROOT, 'test', 'out');
const EXPORT = path.join(OUT, 'markdown-export.pdf');

ensureSamples();
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SIDECAR, { force: true });
fs.rmSync(EXPORT, { force: true });

const results = [];
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
  for (const m of mods.reverse()) await page.keyboard.up(m);
}

/** Real mouse drag across a phrase of the rendered article. */
async function selectText(page, needle) {
  const box = await page.evaluate((needle) => {
    const article = document.querySelector('.md-article');
    const block = [...article.children].find((b) => b.textContent.includes(needle));
    if (!block) return null;
    block.scrollIntoView({ block: 'center' });
    // Map block-relative offsets onto text nodes, so a phrase split by an
    // earlier mark or hit span is still selectable.
    const at = block.textContent.indexOf(needle);
    const end = at + needle.length;
    const range = document.createRange();
    let pos = 0, started = false;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (!started && pos + len > at) {
        range.setStart(node, at - pos);
        started = true;
      }
      if (started && pos + len >= end) { range.setEnd(node, end - pos); break; }
      if (started) range.setEnd(node, len);
      pos += len;
    }
    if (!started) return null;
    const head = range.cloneRange(); head.collapse(true);
    const tail = range.cloneRange(); tail.collapse(false);
    const a = head.getBoundingClientRect(), b = tail.getBoundingClientRect();
    return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.left - 1, y2: b.top + b.height / 2 };
  }, needle);
  assert(box, 'phrase not found in the article: ' + needle);
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  const steps = Math.max(6, Math.round(Math.abs(box.x2 - box.x1) / 6));
  await page.mouse.move(box.x2, box.y2, { steps });
  await page.mouse.up();
  await sleep(300);
}

async function waitNewMark(page, kind) {
  await page.waitForFunction((kind) => window.__quire.annotator.list.some((a) => a.kind === kind),
    { timeout: 8000 }, kind);
}

async function count(page) {
  return page.evaluate(() => window.__quire.annotator.list.length);
}

(async () => {
  const { child, log } = launch({ port: PORT, args: [MD] });
  let browser;
  const errors = [];
  try {
    const { browser: b, page } = await attach(PORT);
    browser = b;
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    await page.waitForSelector('.md-article', { timeout: 30000 });
    await sleep(700);

    await step('markdown document opened', async () => {
      const doc = await page.evaluate(() => ({
        kind: window.__quire.state.kind,
        name: window.__quire.state.doc?.name,
        surface: window.__quire.surface().mode
      }));
      assert(doc.kind === 'markdown', 'kind is ' + doc.kind);
      assert(doc.name === 'quire-sample.md', 'name is ' + doc.name);
      assert(doc.surface === 'markdown', 'surface is ' + doc.surface);
      return doc.name + ' on the markdown surface';
    });

    await step('markdown elements rendered', async () => {
      const stats = await page.evaluate(() => ({
        blocks: document.querySelectorAll('.md-article > *').length,
        headings: document.querySelectorAll('.md-article h1,.md-article h2,.md-article h3').length,
        lists: document.querySelectorAll('.md-article ul li').length,
        table: document.querySelectorAll('.md-article table tr').length,
        pre: document.querySelectorAll('.md-article pre').length,
        inline: document.querySelectorAll('.md-article :not(pre) > code').length,
        quote: document.querySelectorAll('.md-article blockquote').length,
        hr: document.querySelectorAll('.md-article hr').length,
        img: document.querySelectorAll('.md-article img').length
      }));
      assert(stats.blocks >= 15, 'blocks: ' + stats.blocks);
      assert(stats.headings >= 6, 'headings: ' + stats.headings);
      assert(stats.lists >= 4, 'list items: ' + stats.lists);
      assert(stats.table >= 3, 'table rows: ' + stats.table);
      assert(stats.pre === 1, 'fenced blocks: ' + stats.pre);
      assert(stats.inline >= 1, 'inline code: ' + stats.inline);
      assert(stats.quote === 1, 'quotes: ' + stats.quote);
      assert(stats.hr === 1, 'breaks: ' + stats.hr);
      assert(stats.img === 1, 'images: ' + stats.img);
      return `${stats.blocks} blocks, ${stats.headings} headings, table, code, quote, image`;
    });

    await step('LaTeX typeset by KaTeX', async () => {
      const math = await page.evaluate(() => ({
        katex: document.querySelectorAll('.md-article .katex').length,
        display: document.querySelectorAll('.md-article .md-math-block').length,
        errors: document.querySelectorAll('.md-article .md-math-error').length,
        frac: document.querySelectorAll('.md-article .mfrac').length,
        sup: document.querySelectorAll('.md-article .msupsub').length,
        sqrt: document.querySelectorAll('.md-article .sqrt').length,
        text: [...document.querySelectorAll('.md-article .katex')].map((el) => el.textContent).join(' '),
        stray: /%%qmath\d+%%/.test(document.querySelector('.md-article').textContent),
        codeUntouched: document.querySelector('.md-article pre').textContent.includes('{ path, name, size')
      }));
      assert(math.katex >= 4, 'katex nodes: ' + math.katex);
      assert(math.display >= 2, 'display equations: ' + math.display);
      assert(math.errors === 0, 'katex errors: ' + math.errors);
      assert(math.frac >= 2, 'fractions: ' + math.frac);
      assert(math.sup >= 1, 'superscripts: ' + math.sup);
      assert(math.sqrt >= 1, 'roots: ' + math.sqrt);
      assert(/mc2/.test(math.text), 'inline equation text: ' + math.text.slice(0, 60));
      assert(!math.stray, 'placeholder tokens left in the text');
      assert(math.codeUntouched, 'code block content preserved');
      return `${math.katex} formulas, ${math.display} display blocks, no errors`;
    });

    await step('images and links resolved', async () => {
      const assets = await page.evaluate(async () => {
        const img = document.querySelector('.md-article img');
        if (img && !img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; setTimeout(r, 5000); });
        const sibling = [...document.querySelectorAll('.md-article a[href]')]
          .find((a) => a.getAttribute('href').includes('README.md'));
        return {
          src: img?.getAttribute('src') || '',
          width: img?.naturalWidth || 0,
          sibling: sibling?.getAttribute('href') || '',
          external: [...document.querySelectorAll('.md-article a[target="_external"]')].length
        };
      });
      assert(assets.src.startsWith('/local?path='), 'image src: ' + assets.src);
      assert(assets.width > 0, 'image loaded at ' + assets.width + 'px');
      assert(/[\\/]README\.md$/.test(assets.sibling), 'sibling link: ' + assets.sibling);
      return 'local image served, sibling link resolved';
    });

    await step('outline replaces page thumbnails', async () => {
      const nav = await page.evaluate(() => ({
        tab: document.getElementById('tab-thumbs').textContent,
        rows: document.querySelectorAll('.outline-item').length,
        sections: window.__quire.state.pageCount,
        status: document.getElementById('status-page').textContent,
        levels: [...document.querySelectorAll('.outline-item')].map((r) => r.dataset.level)
      }));
      assert(nav.tab === 'Outline', 'tab label: ' + nav.tab);
      assert(nav.rows >= 6, 'outline rows: ' + nav.rows);
      assert(nav.sections === nav.rows, 'sections counted: ' + nav.sections);
      assert(/section 1 \/ \d+/.test(nav.status), 'status: ' + nav.status);
      assert(nav.levels.includes('3'), 'heading depth recorded');
      return `${nav.rows} sections, nesting preserved`;
    });

    await step('outline navigation', async () => {
      await page.click('.outline-item:nth-child(5)');
      await sleep(600);
      const jumped = await page.evaluate(() => ({
        current: window.__quire.markdown.current,
        status: document.getElementById('status-page').textContent,
        input: document.getElementById('page-input').value,
        top: document.getElementById('viewer').scrollTop
      }));
      assert(jumped.current >= 4, 'current section: ' + jumped.current);
      assert(/section \d+ \/ \d+/.test(jumped.status), 'status: ' + jumped.status);
      assert(jumped.input === String(jumped.current), 'page input: ' + jumped.input);
      assert(jumped.top > 0, 'scrolled to ' + jumped.top + 'px');

      await key(page, 'Ctrl+PageDown');
      await sleep(500);
      const next = await page.evaluate(() => window.__quire.markdown.current);
      assert(next > jumped.current, 'Ctrl+PageDown -> ' + next);
      await key(page, 'Ctrl+PageUp');
      await sleep(500);
      assert(await page.evaluate(() => window.__quire.markdown.current) === jumped.current, 'Ctrl+PageUp back');
      return `jumped to section ${jumped.current}, next ${next}`;
    });

    await step('zoom scales the article', async () => {
      await key(page, 'Ctrl+=');
      await key(page, 'Ctrl+=');
      await sleep(350);
      const zoomed = await page.evaluate(() => {
        const art = document.querySelector('.md-article');
        return {
          scale: window.__quire.markdown.scale,
          css: getComputedStyle(art).getPropertyValue('--md-scale').trim(),
          size: parseFloat(getComputedStyle(art).fontSize),
          label: document.getElementById('zoom-label').textContent,
          status: document.getElementById('status-zoom').textContent
        };
      });
      assert(zoomed.scale > 1.2, 'scale: ' + zoomed.scale);
      assert(Math.abs(parseFloat(zoomed.css) - zoomed.scale) < 0.01, 'css var: ' + zoomed.css);
      assert(zoomed.size > 19, 'font size: ' + zoomed.size + 'px');
      assert(zoomed.label === Math.round(zoomed.scale * 100) + '%', 'label: ' + zoomed.label);

      await key(page, 'Ctrl+Shift+F');
      await sleep(300);
      const wide = await page.evaluate(() => ({
        full: document.querySelector('.md-article').classList.contains('md-full'),
        width: document.querySelector('.md-article').getBoundingClientRect().width,
        pane: document.getElementById('viewer').clientWidth
      }));
      assert(wide.full, 'fit width class missing');
      assert(wide.width > wide.pane - 140, 'measure widened to ' + wide.width + ' of ' + wide.pane);

      await key(page, 'Ctrl+0');
      await sleep(300);
      const reset = await page.evaluate(() => ({
        scale: window.__quire.markdown.scale,
        full: document.querySelector('.md-article').classList.contains('md-full')
      }));
      assert(reset.scale === 1, 'reset scale: ' + reset.scale);
      assert(!reset.full, 'fit width released');
      return '115% per step, fit width, reset to 100%';
    });

    await step('search finds text in markdown', async () => {
      await page.click('#search-input');
      for (const ch of 'sidecar') {
        await page.keyboard.type(ch);
        await sleep(90);
      }
      await page.waitForFunction(() => /\d+ match/.test(document.getElementById('search-count').textContent), { timeout: 15000 });
      await sleep(350);
      const found = await page.evaluate(() => ({
        value: document.getElementById('search-input').value,
        active: document.activeElement.id,
        hits: window.__quire.search.hits.length,
        label: document.getElementById('search-count').textContent
      }));
      assert(found.value === 'sidecar', 'value after typing: ' + JSON.stringify(found.value));
      assert(found.active === 'search-input', 'focus left the field to ' + found.active);
      assert(found.hits >= 2, 'hits: ' + found.hits);
      return found.label;
    });

    await step('search navigation marks the hit', async () => {
      await key(page, 'Enter');
      await sleep(600);
      const first = await page.evaluate(() => ({
        cursor: window.__quire.search.cursor,
        marked: document.querySelectorAll('.md-article .hit-flash').length,
        scroll: document.getElementById('viewer').scrollTop
      }));
      assert(first.cursor === 1, 'cursor: ' + first.cursor);
      assert(first.marked >= 1, 'hit marked: ' + first.marked);

      await key(page, 'Shift+Enter');
      await sleep(600);
      assert(await page.evaluate(() => window.__quire.search.cursor === 0), 'Shift+Enter did not go back');

      await key(page, 'Escape');
      await sleep(350);
      const cleared = await page.evaluate(() => ({
        hits: window.__quire.search.hits.length,
        value: document.getElementById('search-input').value,
        marks: document.querySelectorAll('.md-article .hit-flash, .md-article .hit-current').length
      }));
      assert(cleared.hits === 0, 'hits after Escape: ' + cleared.hits);
      assert(cleared.value === '', 'input after Escape: ' + JSON.stringify(cleared.value));
      assert(cleared.marks === 0, 'hit marks left behind: ' + cleared.marks);
      return 'next, previous, clear';
    });

    await step('drag selection makes a highlight', async () => {
      await key(page, 'Ctrl+2');
      await page.evaluate(() => { document.getElementById('viewer').scrollTop = 0; });
      await sleep(300);
      const phrase = 'one entry per block it touches';
      await selectText(page, phrase);
      await waitNewMark(page, 'highlight');
      const ann = await page.evaluate((phrase) => {
        const a = window.__quire.annotator.list[0];
        const span = document.querySelector('.md-mark.md-highlight');
        return {
          kind: a?.kind,
          segs: a?.segs?.length || 0,
          anchor: a?.segs?.[0],
          text: a?.text,
          markdown: a?.markdown,
          spanText: span?.textContent || '',
          bg: span ? getComputedStyle(span).backgroundColor : ''
        };
      }, phrase);
      assert(ann.kind === 'highlight', 'kind: ' + ann.kind);
      assert(ann.segs === 1, 'segments: ' + ann.segs);
      assert(Number.isInteger(ann.anchor?.block) && ann.anchor.start >= 0 && ann.anchor.end > ann.anchor.start,
        'anchor: ' + JSON.stringify(ann.anchor));
      assert(ann.text.includes('block'), 'quoted text: ' + JSON.stringify(ann.text));
      assert(ann.spanText === phrase, 'wrapped span: ' + JSON.stringify(ann.spanText));
      assert(/rgba?\(|color\(/.test(ann.bg) && !/, 0\)$/.test(ann.bg), 'painted: ' + ann.bg);
      return 'anchored at block ' + ann.anchor.block + ', chars ' + ann.anchor.start + '-' + ann.anchor.end;
    });

    await step('underline and strike-through tools', async () => {
      await key(page, 'Ctrl+3');
      await selectText(page, 'survives reflow');
      await waitNewMark(page, 'underline');
      const underline = await page.evaluate(() => ({
        kind: window.__quire.annotator.list.some((a) => a.kind === 'underline'),
        spans: document.querySelectorAll('.md-mark.md-underline').length,
        shadow: getComputedStyle(document.querySelector('.md-mark.md-underline') || document.body).boxShadow
      }));
      assert(underline.kind, 'no underline annotation');
      assert(underline.spans >= 1, 'underline spans: ' + underline.spans);
      assert(/rgb/.test(underline.shadow), 'underline painted: ' + underline.shadow);

      await key(page, 'Ctrl+K');
      await selectText(page, 'amber, green, blue, red');
      await waitNewMark(page, 'strikeout');
      const strike = await page.evaluate(() => ({
        spans: document.querySelectorAll('.md-mark.md-strikeout').length,
        deco: getComputedStyle(document.querySelector('.md-mark.md-strikeout') || document.body).textDecorationLine
      }));
      assert(strike.spans >= 1, 'strike spans: ' + strike.spans);
      assert(strike.deco.includes('line-through'), 'decoration: ' + strike.deco);
      return 'underline + strikethrough painted';
    });

    await step('undo and redo move the marks', async () => {
      const before = await count(page);
      await key(page, 'Ctrl+Z');
      await sleep(400);
      const undone = await page.evaluate(() => ({
        count: window.__quire.annotator.list.length,
        strike: document.querySelectorAll('.md-mark.md-strikeout').length
      }));
      assert(undone.count === before - 1, 'count after undo: ' + undone.count + ' (was ' + before + ')');
      assert(undone.strike === 0, 'strike spans after undo: ' + undone.strike);

      await key(page, 'Ctrl+Shift+Z');
      await sleep(400);
      const redone = await page.evaluate(() => ({
        count: window.__quire.annotator.list.length,
        strike: document.querySelectorAll('.md-mark.md-strikeout').length
      }));
      assert(redone.count === before, 'count after redo: ' + redone.count);
      assert(redone.strike >= 1, 'strike spans after redo: ' + redone.strike);
      return 'undo removed, redo restored';
    });

    await step('sticky note on a block', async () => {
      await key(page, 'Ctrl+M');
      const spot = await page.evaluate(() => {
        const p = [...document.querySelectorAll('.md-article p')].find((el) => el.textContent.includes('compact because'));
        p.scrollIntoView({ block: 'center' });
        const r = p.getBoundingClientRect();
        return { x: r.left + 40, y: r.top + r.height / 2 };
      });
      await sleep(250);
      await page.mouse.click(spot.x, spot.y);
      await page.waitForSelector('.note-editor textarea', { timeout: 6000 });
      await page.keyboard.type('checked against the datasheet');
      await page.click('.note-editor .btn.primary');
      await sleep(400);
      const note = await page.evaluate(() => {
        const a = window.__quire.annotator.list.find((x) => x.kind === 'note');
        return {
          notes: window.__quire.annotator.list.filter((x) => x.kind === 'note').length,
          pins: document.querySelectorAll('.md-pin').length,
          text: a?.text,
          block: a?.anchor?.block,
          editorGone: !document.querySelector('.note-editor')
        };
      });
      assert(note.notes === 1, 'notes: ' + note.notes);
      assert(note.pins === 1, 'pins: ' + note.pins);
      assert(note.text === 'checked against the datasheet', 'text: ' + JSON.stringify(note.text));
      assert(Number.isInteger(note.block), 'anchor block: ' + note.block);
      assert(note.editorGone, 'editor still open after save');

      await page.click('.md-pin');
      await page.waitForSelector('.note-editor textarea', { timeout: 6000 });
      const reopened = await page.evaluate(() => document.querySelector('.note-editor textarea').value);
      assert(reopened === 'checked against the datasheet', 'reopened text: ' + JSON.stringify(reopened));
      await page.keyboard.type(' — still true');
      await page.click('.note-editor .btn.primary');
      await sleep(300);
      const edited = await page.evaluate(() =>
        window.__quire.annotator.list.find((x) => x.kind === 'note')?.text || '');
      assert(edited.includes('still true'), 'edited text: ' + JSON.stringify(edited));
      return 'note pinned, reopened and edited';
    });

    await step('eraser deletes a mark, undo brings it back', async () => {
      await key(page, 'Ctrl+4');
      const box = await page.evaluate(() => {
        const span = document.querySelector('.md-mark.md-highlight');
        span.scrollIntoView({ block: 'center' });
        const r = span.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await sleep(250);
      const before = await page.evaluate(() => window.__quire.annotator.list.length);
      await page.mouse.click(box.x, box.y);
      await sleep(400);
      const after = await page.evaluate(() => ({
        count: window.__quire.annotator.list.length,
        spans: document.querySelectorAll('.md-mark.md-highlight').length
      }));
      assert(after.count === before - 1, 'count: ' + after.count + ' (was ' + before + ')');
      assert(after.spans === 0, 'spans left in the DOM: ' + after.spans);
      await key(page, 'Ctrl+Z');
      await sleep(400);
      assert(await page.evaluate(() => document.querySelectorAll('.md-mark.md-highlight').length === 1),
        'undo did not restore the mark');
      await key(page, 'Ctrl+1');
      return 'deleted and restored';
    });

    await step('annotation list and jump', async () => {
      await page.click('[data-tab="marks"]');
      await sleep(350);
      const list = await page.evaluate(() => ({
        rows: document.querySelectorAll('.mark-row').length,
        heading: document.querySelector('.mark-group h4')?.textContent || '',
        kinds: [...document.querySelectorAll('.mark-body em')].map((e) => e.textContent)
      }));
      assert(list.rows >= 4, 'rows: ' + list.rows);
      assert(list.heading === 'In this document', 'group heading: ' + list.heading);
      assert(list.kinds.includes('Highlight') && list.kinds.includes('Note'), 'kinds: ' + list.kinds.join(','));

      await page.click('.mark-row');
      await sleep(450);
      assert(await page.evaluate(() => !!document.querySelector('.md-mark.pulse')), 'no pulse on jump');
      return `${list.rows} annotations listed`;
    });

    await step('sidecar saves markdown anchors', async () => {
      await key(page, 'Ctrl+S');
      await sleep(900);
      const saved = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
      assert(saved.format === 'quire-marks/1', 'format: ' + saved.format);
      assert(saved.document.kind === 'markdown', 'document.kind: ' + saved.document.kind);
      assert(saved.document.name === 'quire-sample.md', 'document.name: ' + saved.document.name);
      assert(saved.annotations.length >= 4, 'annotations: ' + saved.annotations.length);
      assert(saved.annotations.some((a) => a.kind === 'underline'), 'no underline saved');
      assert(saved.annotations.filter((a) => a.kind === 'note').every((a) => a.anchor?.block !== undefined),
        'a note has no block anchor');
      assert(saved.annotations.filter((a) => a.kind !== 'note').every((a) => Array.isArray(a.segs) && a.segs.length),
        'a text mark has no segs');
      assert(saved.annotations.some((a) => a.text && a.text.includes('still true')), 'note text missing');
      const pill = await page.evaluate(() => document.getElementById('save-state').textContent);
      assert(/saved .*marks\.json/.test(pill), 'save indicator: ' + JSON.stringify(pill));
      return `${saved.annotations.length} annotations, kind recorded`;
    });

    await step('autosave after an unsaved change', async () => {
      const before = fs.readFileSync(SIDECAR, 'utf8');
      const count = await page.evaluate(() => window.__quire.annotator.list.length);
      await key(page, 'Ctrl+2');
      await selectText(page, 'Zoom scales the type on Markdown');
      await page.waitForFunction((n) => window.__quire.annotator.list.length > n, { timeout: 8000 }, count);
      const deadline = Date.now() + 8000;
      let changed = false;
      while (Date.now() < deadline && !changed) {
        await sleep(300);
        changed = fs.readFileSync(SIDECAR, 'utf8') !== before;
      }
      assert(changed, 'the sidecar never updated on its own');
      return 'sidecar rewritten without Ctrl+S';
    });

    await step('marks survive a reload', async () => {
      const expected = JSON.parse(fs.readFileSync(SIDECAR, 'utf8')).annotations.length;
      await page.reload();
      await page.waitForSelector('.welcome', { timeout: 15000 });
      await page.evaluate((p) => window.__quire.openPath(p), MD);
      await page.waitForSelector('.md-article', { timeout: 20000 });
      await sleep(900);
      const back = await page.evaluate(() => ({
        kind: window.__quire.state.kind,
        marks: window.__quire.annotator.list.length,
        spans: document.querySelectorAll('.md-mark').length,
        pins: document.querySelectorAll('.md-pin').length,
        katex: document.querySelectorAll('.md-article .katex').length,
        saved: document.getElementById('save-state').textContent
      }));
      assert(back.kind === 'markdown', 'kind after reload: ' + back.kind);
      assert(back.marks === expected, 'marks: ' + back.marks + ' expected ' + expected);
      assert(back.spans >= 4, 'repainted spans: ' + back.spans);
      assert(back.pins === 1, 'repainted pins: ' + back.pins);
      assert(back.katex >= 4, 'math after reload: ' + back.katex);
      assert(/saved .*marks\.json/.test(back.saved), 'save indicator after reload: ' + JSON.stringify(back.saved));
      return `${back.marks} marks repainted`;
    });

    await step('markdown exports as a PDF', async () => {
      await page.evaluate((target) => window.__quire.exportPdf('rendered', target), EXPORT);
      await sleep(1500);
      const buf = fs.readFileSync(EXPORT);
      assert(buf.subarray(0, 5).toString('latin1') === '%PDF-', 'header: ' + buf.subarray(0, 8).toString('latin1'));
      assert(buf.length > 3000, 'size: ' + buf.length + ' bytes');
      return buf.length + ' byte PDF written';
    });

    await step('a PDF still opens as a PDF', async () => {
      await page.evaluate((p) => window.__quire.openPath(p), PDF);
      await sleep(1800);
      const doc = await page.evaluate(() => ({
        kind: window.__quire.state.kind,
        tab: document.getElementById('tab-thumbs').textContent,
        pages: window.__quire.state.pageCount,
        status: document.getElementById('status-page').textContent,
        inkDisabled: document.querySelector('.tool-btn[data-tool="ink"]').disabled,
        thumbs: document.querySelectorAll('.thumb').length,
        exportItems: [...document.querySelectorAll('#export-menu button')].map((b) => b.dataset.mode + ':' + b.hidden)
      }));
      assert(doc.kind === 'pdf', 'kind: ' + doc.kind);
      assert(doc.tab === 'Pages', 'tab: ' + doc.tab);
      assert(doc.pages === 3, 'pages: ' + doc.pages);
      assert(/page 1 \/ 3/.test(doc.status), 'status: ' + doc.status);
      assert(doc.inkDisabled === false, 'ink disabled on a PDF');
      assert(doc.thumbs === 3, 'thumbnails: ' + doc.thumbs);
      assert(doc.exportItems.includes('annot:false') && doc.exportItems.includes('rendered:true'),
        'export menu: ' + doc.exportItems.join(' '));
      return '3 pages, thumbnails, PDF export items';
    });

    await step('plain text is read as markdown', async () => {
      await page.evaluate((p) => window.__quire.openPath(p), TXT);
      await sleep(900);
      const txt = await page.evaluate(() => ({
        kind: window.__quire.state.kind,
        text: document.querySelector('.md-article')?.textContent.trim().slice(0, 30) || ''
      }));
      assert(txt.kind === 'markdown', 'kind: ' + txt.kind);
      assert(/Plain text/.test(txt.text), 'text: ' + JSON.stringify(txt.text));
      return 'notes.txt rendered as markdown';
    });

    await step('other file types are refused', async () => {
      await page.evaluate((p) => window.__quire.openPath(p), NOTADOC);
      await sleep(800);
      const toast = await page.evaluate(() => document.querySelector('.toast')?.textContent || '');
      assert(/is not a supported document or image/.test(toast), 'toast: ' + JSON.stringify(toast));
      return toast;
    });

    await step('theme keeps markdown readable', async () => {
      await page.evaluate((p) => window.__quire.openPath(p), MD);
      await sleep(900);
      await key(page, 'Ctrl+Shift+L');
      await sleep(400);
      const light = await page.evaluate(() => {
        const art = document.querySelector('.md-article');
        const span = document.querySelector('.md-mark.md-highlight');
        return {
          theme: document.documentElement.dataset.theme,
          bg: getComputedStyle(art).backgroundColor,
          color: getComputedStyle(art).color,
          mark: span ? getComputedStyle(span).backgroundColor : 'none'
        };
      });
      assert(light.theme === 'light', 'theme: ' + light.theme);
      const bgChannels = (light.bg.match(/\d+/g) || []).slice(0, 3);
      assert(bgChannels.length === 3 && bgChannels.every((channel) => Number(channel) >= 230), 'article background: ' + light.bg);
      assert(!/255, 255, 255/.test(light.color), 'text colour: ' + light.color);
      assert(light.mark !== 'none' && /rgba?\(|color\(/.test(light.mark), 'highlight in light theme: ' + light.mark);
      await page.screenshot({ path: path.join(OUT, 'markdown-light.png') });

      await key(page, 'Ctrl+Shift+L');
      await sleep(400);
      assert(await page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'did not switch back');
      await page.screenshot({ path: path.join(OUT, 'markdown-dark.png') });
      return 'light and dark both painted';
    });

    await step('pdf-only tools are refused on markdown', async () => {
      await key(page, 'Ctrl+D');
      await sleep(300);
      const guard = await page.evaluate(() => ({
        tool: window.__quire.annotator.tool,
        toast: Array.from(document.querySelectorAll('.toast')).at(-1)?.textContent || '',
        disabled: document.querySelector('.tool-btn[data-tool="ink"]').disabled
      }));
      assert(guard.tool !== 'ink', 'tool became ' + guard.tool);
      assert(/need a PDF page/.test(guard.toast), 'toast: ' + JSON.stringify(guard.toast));
      assert(guard.disabled, 'ink button not disabled');
      return 'shortcut and button both blocked';
    });

    await step('no console errors', async () => {
      assert(errors.length === 0, errors.slice(0, 4).join(' | '));
      return 'clean';
    });
  } catch (err) {
    results.push(['FAIL', 'crashed', err.message]);
    console.log('stdout/stderr tail:\n' + log.slice(-6).join(''));
    process.exitCode = 1;
  } finally {
    const tree = process.platform === 'win32' ? 'taskkill' : 'pkill';
    const killArgs = process.platform === 'win32'
      ? ['/T', '/F', '/PID', String(child.pid)]
      : ['-f', '-P', String(child.pid)];
    try { require('node:child_process').spawnSync(tree, killArgs, { stdio: 'ignore' }); } catch { /* ignore */ }
    if (browser) await browser.disconnect();
    for (const [state, name, detail] of results) console.log(`${state} ${name}${detail ? ' — ' + detail : ''}`);
    const failed = results.filter((r) => r[0] === 'FAIL').length;
    console.log(failed ? `e2e:markdown: ${failed} failure(s)` : 'e2e:markdown: ok');
    if (failed) process.exitCode = 1;
  }
})();
