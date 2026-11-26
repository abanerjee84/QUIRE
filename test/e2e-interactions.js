/**
 * Human-behaviour pass over Quire: types at human speed, clicks the real
 * buttons, drags with the mouse, opens and closes dialogs. Every step is
 * independent so one failure reports alongside the rest instead of aborting.
 */
const path = require('node:path');
const fs = require('node:fs');
const { PDFDocument, PDFName, PDFArray } = require('pdf-lib');
const { ROOT, launch, attach, ensureSamples, sleep } = require('./cdp');

const PORT = 9241;
const SAMPLE = path.join(ROOT, 'samples', 'quire-sample.pdf');
const SCAN = path.join(ROOT, 'samples', 'scan-sample.pdf');
const NOTAPDF = path.join(ROOT, 'package.json');
const OUT = path.join(ROOT, 'test', 'out');
const SIDECAR = path.join(ROOT, 'samples', 'quire-sample.pdf.marks.json');

ensureSamples();
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SIDECAR, { force: true });
fs.rmSync(path.join(OUT, 'interactions-export.pdf'), { force: true });

const results = [];
let erasedId = null;
async function step(name, fn) {
  try {
    const detail = await fn();
    results.push(['ok  ', name, detail || '']);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
}

async function key(page, combo) {
  const parts = combo.split('+');
  const mods = parts.slice(0, -1);
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(parts[parts.length - 1].toLowerCase());
  for (const m of mods.reverse()) await page.keyboard.up(m);
}

async function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Drag across the page with the left button held. */
async function drag(page, from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(12);
  }
  await page.mouse.up();
}

(async () => {
  const { child, log } = launch({ port: PORT, args: [SAMPLE] });
  let browser;
  try {
    const { browser: b, page } = await attach(PORT);
    browser = b;
    page.on('dialog', (d) => d.accept().catch(() => {}));

    await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 3, { timeout: 20000 });
    await page.waitForFunction(() => !!window.__quire.viewer.pages[0]?.text, { timeout: 20000 });

    const box = async (sel) => page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x, top: r.y, w: r.width, h: r.height };
    }, sel);

    // Pointer events land in viewport coordinates, so a page has to be on
    // screen before anything is clicked or dragged on it. The returned box is
    // clamped to the scrollable viewer area: a page taller than the viewport
    // has an edge above it, and offsets from that would aim at the toolbar.
    const pageBox = async (num) => {
      await page.evaluate((n) => document.querySelector(`.page-wrap[data-page="${n}"]`)?.scrollIntoView({ block: 'center' }), num);
      await sleep(400);
      return page.evaluate((s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        const v = document.getElementById('viewer').getBoundingClientRect();
        const top = Math.max(r.top, v.top + 30);
        const bottom = Math.min(r.bottom, v.bottom - 30);
        return { x: r.x + r.width / 2, left: Math.max(r.left, v.left + 30), top, bottom, w: r.width, h: bottom - top };
      }, `.page-wrap[data-page="${num}"]`);
    };

    // Toasts stack; the newest one is the one to read.
    const lastToast = async () => page.evaluate(() => {
      const all = document.querySelectorAll('.toast');
      return all.length ? all[all.length - 1].textContent : '';
    });

    // Search runs on a debounce. Reading cursor state mid-run measures a scan
    // that is about to throw its results away, so wait for the run to land.
    const settled = async (query) => {
      await page.waitForFunction((q) => {
        const s = window.__quire.search;
        return s.query === q && !s.busy && s.hits.length > 0 && s.cursor >= 0;
      }, { timeout: 15000 }, query);
      await sleep(300);
    };

    /* ------------------------------------------------------------------ search */

    await step('Ctrl+F puts the caret in the search box', async () => {
      await key(page, 'Control+f');
      const id = await page.evaluate(() => document.activeElement.id);
      assert(id === 'search-input', 'focus went to ' + id);
      return 'activeElement=search-input';
    });

    await step('typing at human speed keeps the box editable (focus bug)', async () => {
      await page.evaluate(() => {
        document.getElementById('search-input').value = '';
        window.getSelection().removeAllRanges();
        document.getElementById('search-input').focus();
      });
      for (const ch of 'annotation') {
        await page.keyboard.type(ch);
        await sleep(340);                       // debounce fires between keystrokes
        const st = await page.evaluate(() => ({
          v: document.getElementById('search-input').value,
          a: document.activeElement.id
        }));
        assert(st.a === 'search-input', `focus left the box after ${ch}`);
        assert(st.v.endsWith(ch), `keystroke ${ch} never reached the box (value "${st.v}")`);
      }
      const v = await page.evaluate(() => document.getElementById('search-input').value);
      assert(v === 'annotation', 'typed query was "' + v + '"');
      await settled('annotation');
      const count = await page.evaluate(() => document.getElementById('search-count').textContent);
      assert(/matches|match\b/.test(count), 'match count not shown: ' + count);
      return `"${v}" · ${count}`;
    });

    await step('current match is marked while typing', async () => {
      const n = await page.evaluate(() => document.querySelectorAll('.text-layer span.hit-current').length);
      assert(n >= 1, 'no .hit-current marker on the first match');
      return n + ' marked span(s)';
    });

    await step('Enter jumps to the next match and numbers it', async () => {
      await page.keyboard.press('Enter');
      await sleep(500);
      const text = await page.evaluate(() => document.getElementById('search-count').textContent);
      assert(/^\d+ of \d+$/.test(text), 'count reads "' + text + '"');
      await sleep(400);
      const stillTyping = await page.evaluate(() => document.activeElement.id);
      assert(stillTyping === 'search-input', 'Enter moved focus to ' + stillTyping);
      return text;
    });

    await step('Shift+Enter goes to the previous match', async () => {
      await settled('annotation');
      const before = await page.evaluate(() => window.__quire.search.cursor);
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await sleep(500);
      const after = await page.evaluate(() => window.__quire.search.cursor);
      assert(after < before || (before === 0 && after > 0), `cursor ${before} -> ${after}`);
      return `cursor ${before} -> ${after}`;
    });

    await step('typing after Enter still appends to the query', async () => {
      await page.keyboard.type('s');
      await sleep(80);
      const v = await page.evaluate(() => document.getElementById('search-input').value);
      assert(v.endsWith('s'), 'value is "' + v + '"');
      await settled('annotations');
      return v;
    });

    await step('next / prev buttons walk the matches', async () => {
      const a = await page.evaluate(() => window.__quire.search.cursor);
      await page.click('#btn-search-next');
      await sleep(450);
      const b = await page.evaluate(() => window.__quire.search.cursor);
      await page.click('#btn-search-prev');
      await sleep(450);
      const c = await page.evaluate(() => window.__quire.search.cursor);
      assert(b === a + 1 && c === a, `cursor ${a} -> ${b} -> ${c}`);
      return `cursor ${a} -> ${b} -> ${c}`;
    });

    await step('a query with no hits says so', async () => {
      await page.evaluate(() => {
        const i = document.getElementById('search-input');
        i.value = 'zzqx-never-in-this-pdf';
        i.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForFunction(() => document.getElementById('search-count').textContent === 'no matches', { timeout: 15000 });
      return 'no matches';
    });

    await step('Escape clears the search and leaves the box', async () => {
      await page.evaluate(() => document.getElementById('search-input').focus());
      await page.keyboard.press('Escape');
      await sleep(200);
      const st = await page.evaluate(() => ({
        value: document.getElementById('search-input').value,
        count: document.getElementById('search-count').textContent,
        active: document.activeElement.id
      }));
      assert(st.value === '', 'query still "' + st.value + '"');
      assert(st.count === '', 'count still "' + st.count + '"');
      assert(st.active !== 'search-input', 'still focused');
      return 'cleared, blurred';
    });

    /* ------------------------------------------------------------------ fields */

    await step('Ctrl+G then typing a page number goes to that page', async () => {
      await key(page, 'Control+g');
      const focused = await page.evaluate(() => document.activeElement.id);
      assert(focused === 'page-input', 'focus went to ' + focused);
      await page.keyboard.type('3');
      await page.keyboard.press('Enter');
      await sleep(500);
      const cur = await page.evaluate(() => window.__quire.viewer.current);
      assert(cur === 3, 'viewer.current is ' + cur);
      return 'page 3';
    });

    await step('page number typing is not swallowed by a page selection', async () => {
      await page.evaluate(() => {
        const i = document.getElementById('page-input');
        i.value = '';
        i.focus();
      });
      await page.keyboard.type('1');
      await page.keyboard.press('Enter');
      await sleep(400);
      const cur = await page.evaluate(() => window.__quire.viewer.current);
      assert(cur === 1, 'viewer.current is ' + cur);
      return 'back to page 1';
    });

    /* ------------------------------------------------------------------- zoom */

    await step('zoom in / out / reset buttons change the scale', async () => {
      const base = await page.evaluate(() => window.__quire.viewer.scale);
      await page.click('#btn-zoom-in');
      await sleep(400);
      const up = await page.evaluate(() => window.__quire.viewer.scale);
      await page.click('#btn-zoom-out');
      await page.click('#btn-zoom-out');
      await sleep(400);
      const down = await page.evaluate(() => window.__quire.viewer.scale);
      await page.click('#zoom-label');
      await sleep(400);
      const reset = await page.evaluate(() => window.__quire.viewer.scale);
      assert(up > base, `zoom in did nothing (${base} -> ${up})`);
      assert(down < up, `zoom out did nothing (${up} -> ${down})`);
      assert(Math.abs(reset - 1) < 0.001, 'reset landed at ' + reset);
      return `${base.toFixed(2)} -> ${up.toFixed(2)} -> ${down.toFixed(2)} -> 1.00`;
    });

    await step('fit width and fit page set sane scales', async () => {
      await page.click('#btn-fit-width');
      await sleep(400);
      const w = await page.evaluate(() => window.__quire.viewer.scale);
      await page.click('#btn-fit-page');
      await sleep(400);
      const p = await page.evaluate(() => window.__quire.viewer.scale);
      assert(w > 0 && p > 0 && p <= w, `width ${w} page ${p}`);
      await page.click('#btn-fit-width');
      await sleep(300);
      return `width ${w.toFixed(2)}, page ${p.toFixed(2)}`;
    });

    await step('prev / next page buttons walk the document', async () => {
      await page.click('#btn-next');
      await sleep(400);
      const n = await page.evaluate(() => window.__quire.viewer.current);
      await page.click('#btn-prev');
      await sleep(400);
      const p = await page.evaluate(() => window.__quire.viewer.current);
      assert(n === 2 && p === 1, `${n} then ${p}`);
      return '2 then 1';
    });

    await step('status bar tracks page and zoom', async () => {
      const st = await page.evaluate(() => ({
        page: document.getElementById('status-page').textContent,
        zoom: document.getElementById('status-zoom').textContent,
        file: document.getElementById('status-file').textContent,
        kind: window.__quire.state.kind,
        pageCount: window.__quire.state.pageCount,
        hasDoc: document.body.classList.contains('has-doc')
      }));
      assert(/page 1 \/ 3/.test(st.page), `page status reads "${st.page}" (kind=${st.kind}, pages=${st.pageCount}, hasDoc=${st.hasDoc})`);
      assert(/%$/.test(st.zoom), 'zoom reads "' + st.zoom + '"');
      assert(/quire-sample\.pdf/.test(st.file), st.file);
      return `${st.page} · ${st.zoom}`;
    });

    /* ------------------------------------------------------------------ tools */

    await step('every tool button selects its tool and marks itself active', async () => {
      const tools = await page.evaluate(() => [...document.querySelectorAll('.tool-btn')].map((b) => b.dataset.tool));
      for (const t of tools) {
        await page.click(`.tool-btn[data-tool="${t}"]`);
        await sleep(120);
        const st = await page.evaluate(() => ({
          tool: window.__quire.annotator.tool,
          active: [...document.querySelectorAll('.tool-btn.active')].map((b) => b.dataset.tool),
          swatches: document.querySelectorAll('#swatches .swatch').length,
          widthCtl: !document.getElementById('width-ctl').hidden
        }));
        assert(st.tool === t, `${t}: annotator.tool is ${st.tool}`);
        assert(st.active.length === 1 && st.active[0] === t, `${t}: active buttons ${st.active}`);
        if (['select', 'eraser'].includes(t)) assert(st.swatches === 0, `${t} should show no palette`);
        else assert(st.swatches > 0, `${t} shows no colour palette`);
        assert(st.widthCtl === ['ink', 'rect', 'ellipse', 'arrow', 'underline', 'strikeout'].includes(t), `${t}: width control ${st.widthCtl}`);
      }
      return tools.join(', ');
    });

    await step('clicking a swatch changes the tool colour', async () => {
      await page.click('.tool-btn[data-tool="highlight"]');
      await sleep(150);
      const swatches = await page.$$('#swatches .swatch');
      await swatches[2].click();
      await sleep(150);
      const c = await page.evaluate(() => window.__quire.annotator.colors.highlight);
      assert(c === '#63b3ed', 'colour is ' + c);
      const active = await page.evaluate(() => document.querySelectorAll('#swatches .swatch.active').length);
      assert(active === 1, active + ' swatches marked active');
      return 'highlight=' + c;
    });

    await step('the ink width slider reaches the annotator and its label', async () => {
      await page.click('.tool-btn[data-tool="ink"]');
      await sleep(150);
      await page.evaluate(() => {
        const s = document.getElementById('ink-width');
        s.value = '5';
        s.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const st = await page.evaluate(() => ({
        w: window.__quire.annotator.inkWidth,
        label: document.getElementById('ink-width-label').textContent
      }));
      assert(st.w === 5, 'inkWidth is ' + st.w);
      assert(st.label === '5 pt', 'label reads "' + st.label + '"');
      return `inkWidth=${st.w}, ${st.label}`;
    });

    await step('Ctrl+2 selects highlight even with the caret in a field', async () => {
      await page.evaluate(() => document.getElementById('search-input').focus());
      await key(page, 'Control+2');
      await sleep(150);
      const t = await page.evaluate(() => window.__quire.annotator.tool);
      assert(t === 'highlight', 'tool is ' + t);
      return 'highlight while typing';
    });

    /* ---------------------------------------------------------- annotations */

    await step('dragging over text makes a highlight and quotes the text', async () => {
      await page.click('.tool-btn[data-tool="highlight"]');
      await page.evaluate(() => {
        document.getElementById('viewer').scrollTop = 0;
        document.getElementById('search-input').value = '';
        window.getSelection().removeAllRanges();
      });
      await sleep(300);
      const span = await page.evaluate(() => {
        const s = document.querySelectorAll('.page-wrap[data-page="1"] .text-layer span')[3];
        const r = s.getBoundingClientRect();
        return { x: r.x, y: r.y + r.height / 2, w: r.width };
      });
      await drag(page, { x: span.x + 2, y: span.y }, { x: span.x + span.w - 2, y: span.y });
      await sleep(400);
      const st = await page.evaluate(() => ({
        kinds: window.__quire.annotator.list.map((a) => a.kind),
        quoted: document.getElementById('status-selection').textContent
      }));
      assert(st.kinds.includes('highlight'), 'kinds: ' + st.kinds);
      assert(st.quoted.length > 3, 'selection quote empty: "' + st.quoted + '"');
      return st.kinds.join(',') + ' · "' + st.quoted.slice(0, 40) + '"';
    });

    await step('a note can be dropped, typed into and saved', async () => {
      await page.click('.tool-btn[data-tool="note"]');
      await sleep(150);
      const p = await pageBox(1);
      await page.mouse.click(p.x + 60, p.top + 40);
      await page.waitForSelector('.note-editor textarea', { timeout: 5000 });
      const focused = await page.evaluate(() => document.activeElement.tagName);
      assert(focused === 'TEXTAREA', 'editor focus is ' + focused);
      await page.keyboard.type('Check figure sizing');
      await sleep(150);
      const typed = await page.evaluate(() => document.querySelector('.note-editor textarea').value);
      assert(typed === 'Check figure sizing', 'textarea holds "' + typed + '"');
      await page.evaluate(() => [...document.querySelectorAll('.note-editor .btn')].find((b) => b.textContent === 'Save').click());
      await sleep(400);
      const st = await page.evaluate(() => ({
        notes: window.__quire.annotator.list.filter((a) => a.kind === 'note').map((a) => a.text),
        pins: document.querySelectorAll('.note-pin').length
      }));
      assert(st.notes[0] === 'Check figure sizing', 'saved text: ' + st.notes[0]);
      assert(st.pins === 1, st.pins + ' pins');
      return 'note "' + st.notes[0] + '"';
    });

    await step('clicking the pin reopens the note with its text', async () => {
      await page.click('.tool-btn[data-tool="select"]');
      await sleep(150);
      const pin = await box('.note-pin');
      await page.mouse.click(pin.x, pin.y);
      await page.waitForSelector('.note-editor textarea', { timeout: 5000 });
      const v = await page.evaluate(() => document.querySelector('.note-editor textarea').value);
      assert(v === 'Check figure sizing', 'editor shows "' + v + '"');
      await page.evaluate(() => [...document.querySelectorAll('.note-editor .btn')].find((b) => b.textContent === 'Cancel').click());
      await sleep(300);
      const gone = await page.evaluate(() => document.querySelectorAll('.note-editor').length);
      assert(gone === 0, 'editor still open');
      return 'reopened and cancelled';
    });

    await step('Escape closes the note editor without saving', async () => {
      await page.click('.tool-btn[data-tool="note"]');
      const p = await pageBox(2);
      await page.mouse.click(p.x, p.top + 60);
      await page.waitForSelector('.note-editor textarea', { timeout: 5000 });
      await page.keyboard.type('draft only');
      await page.keyboard.press('Escape');
      await sleep(300);
      const st = await page.evaluate(() => ({
        editors: document.querySelectorAll('.note-editor').length,
        notes: window.__quire.annotator.list.filter((a) => a.kind === 'note').length
      }));
      assert(st.editors === 0, 'editor still open');
      assert(st.notes === 1, st.notes + ' notes after cancelling an empty one');
      return 'cancelled empty note, 1 left';
    });

    await step('dragging with ink and rectangle tools draws both', async () => {
      await page.click('.tool-btn[data-tool="ink"]');
      const p = await pageBox(1);
      await drag(page, { x: p.left + 40, y: p.top + 120 }, { x: p.left + 160, y: p.top + 150 });
      await sleep(300);
      await page.click('.tool-btn[data-tool="rect"]');
      await drag(page, { x: p.left + 200, y: p.top + 100 }, { x: p.left + 340, y: p.top + 180 });
      await sleep(300);
      const st = await page.evaluate(() => ({
        ink: window.__quire.annotator.list.filter((a) => a.kind === 'ink').map((a) => a.width),
        rect: window.__quire.annotator.list.filter((a) => a.kind === 'rect').length
      }));
      assert(st.ink.length === 1, st.ink.length + ' ink strokes');
      assert(st.ink[0] === 5, 'ink width should be 5 pt, got ' + st.ink[0]);
      assert(st.rect === 1, st.rect + ' rectangles');
      return `ink ${st.ink[0]}pt, rect ${st.rect}`;
    });

    await step('dragging with ellipse and arrow tools draws both', async () => {
      await page.click('.tool-btn[data-tool="ellipse"]');
      const p = await pageBox(2);
      await drag(page, { x: p.left + 60, y: p.top + 200 }, { x: p.left + 200, y: p.top + 290 });
      await sleep(300);
      await page.click('.tool-btn[data-tool="arrow"]');
      await drag(page, { x: p.left + 250, y: p.top + 260 }, { x: p.left + 380, y: p.top + 150 });
      await sleep(300);
      const st = await page.evaluate(() => ({
        ellipse: window.__quire.annotator.list.filter((a) => a.kind === 'ellipse'),
        arrow: window.__quire.annotator.list.filter((a) => a.kind === 'arrow'),
        shape: !!document.querySelector('.ann.ellipse ellipse'),
        shaft: !!document.querySelector('.ann.arrow line'),
        head: !!document.querySelector('.ann.arrow polygon')
      }));
      assert(st.ellipse.length === 1, st.ellipse.length + ' ellipses');
      assert(st.arrow.length === 1, st.arrow.length + ' arrows');
      assert(st.shape, 'no ellipse painted on the page');
      assert(st.shaft && st.head, 'arrow painted without a shaft or head');
      const box = st.ellipse[0].rects[0];
      assert(box.w > 60 && box.h > 40, `ellipse box ${box.w}×${box.h}`);
      return `ellipse ${Math.round(box.w)}×${Math.round(box.h)}, arrow ${Math.round(st.arrow[0].points[1][0] - st.arrow[0].points[0][0])}pt across`;
    });

    await step('the eraser deletes the mark you click on', async () => {
      await page.click('.tool-btn[data-tool="eraser"]');
      await sleep(200);
      const sel = '.ann.highlight rect';
      await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
      await sleep(400);
      const target = await box(sel);
      // Whatever actually sits under the cursor is what the eraser should take.
      const hit = await page.evaluate((x, y) => document.elementFromPoint(x, y)?.closest('.ann')?.dataset.id || null, target.x, target.y);
      assert(hit, 'no annotation under the cursor');
      const before = await page.evaluate(() => window.__quire.annotator.list.length);
      await page.mouse.click(target.x, target.y);
      await sleep(300);
      const st = await page.evaluate((id) => ({
        left: window.__quire.annotator.list.length,
        gone: !window.__quire.annotator.list.some((a) => a.id === id)
      }), hit);
      assert(st.gone && st.left === before - 1, `clicked ${hit}: ${before} -> ${st.left} marks, still present=${!st.gone}`);
      erasedId = hit;
      return `${hit} erased (${before} -> ${st.left})`;
    });

    await step('undo and redo buttons reverse and reapply', async () => {
      await page.click('#btn-undo');
      await sleep(300);
      const undone = await page.evaluate((id) => ({
        count: window.__quire.annotator.list.length,
        back: window.__quire.annotator.list.some((a) => a.id === id)
      }), erasedId);
      assert(undone.back, `undo did not bring ${erasedId} back`);
      await page.click('#btn-redo');
      await sleep(300);
      const redone = await page.evaluate((id) => ({
        count: window.__quire.annotator.list.length,
        gone: !window.__quire.annotator.list.some((a) => a.id === id)
      }), erasedId);
      assert(redone.gone && redone.count === undone.count - 1, `redo left ${redone.count} marks, id erased again=${redone.gone}`);
      return `undo restored ${erasedId} (${undone.count}), redo erased it again (${redone.count})`;
    });

    /* ---------------------------------------------------------------- sidebar */

    await step('sidebar tabs switch between pages and annotations', async () => {
      await page.click('.tab[data-tab="marks"]');
      await sleep(200);
      const marks = await page.evaluate(() => ({
        marksActive: document.getElementById('pane-marks').classList.contains('active'),
        thumbsActive: document.getElementById('pane-thumbs').classList.contains('active')
      }));
      assert(marks.marksActive && !marks.thumbsActive, JSON.stringify(marks));
      await page.click('.tab[data-tab="thumbs"]');
      await sleep(200);
      const thumbs = await page.evaluate(() => document.getElementById('pane-thumbs').classList.contains('active'));
      assert(thumbs, 'pages pane not active');
      const painted = await page.evaluate(() => document.querySelectorAll('.thumb-frame canvas').length);
      assert(painted >= 1, 'no thumbnails painted');
      return `${painted} thumbnails painted`;
    });

    await step('clicking a thumbnail jumps to that page', async () => {
      await page.evaluate(() => document.querySelector('.thumb[data-page="3"]').click());
      await sleep(400);
      const cur = await page.evaluate(() => window.__quire.viewer.current);
      assert(cur === 3, 'viewer.current is ' + cur);
      return 'page 3';
    });

    await step('the annotations pane lists every mark with a delete button', async () => {
      await page.click('.tab[data-tab="marks"]');
      await sleep(200);
      const st = await page.evaluate(() => ({
        rows: document.querySelectorAll('.mark-row').length,
        dels: document.querySelectorAll('.mark-row .del').length,
        badge: document.getElementById('mark-badge').textContent,
        live: window.__quire.annotator.list.length
      }));
      assert(st.rows === st.live, `${st.rows} rows for ${st.live} annotations`);
      assert(st.dels === st.live, 'delete buttons: ' + st.dels);
      assert(st.badge === String(st.live), 'badge reads ' + st.badge);
      return `${st.rows} rows, badge ${st.badge}`;
    });

    await step('clicking an annotation row jumps to its page and flashes it', async () => {
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.mark-row')];
        rows.find((r) => r.textContent.includes('Page 2') || true).click();
      });
      await sleep(400);
      const st = await page.evaluate(() => ({
        pulsed: document.querySelectorAll('.ann.pulse, .note-pin.pulse').length,
        current: window.__quire.viewer.current
      }));
      assert(st.pulsed >= 1, 'nothing pulsed');
      return `page ${st.current}, ${st.pulsed} pulsed`;
    });

    await step('the row delete button removes that annotation', async () => {
      const before = await page.evaluate(() => window.__quire.annotator.list.length);
      await page.evaluate(() => document.querySelector('.mark-row .del').click());
      await sleep(300);
      const after = await page.evaluate(() => window.__quire.annotator.list.length);
      assert(after === before - 1, `${before} -> ${after}`);
      return `${before} -> ${after}`;
    });

    await step('Ctrl+B hides and restores the sidebar', async () => {
      await key(page, 'Control+b');
      await sleep(250);
      const hidden = await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).display);
      await key(page, 'Control+b');
      await sleep(250);
      const shown = await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).display);
      assert(hidden === 'none', 'sidebar display ' + hidden);
      assert(shown !== 'none', 'sidebar stays hidden');
      return 'hidden, restored';
    });

    /* ------------------------------------------------------------ persistence */

    await step('Ctrl+S writes the sidecar and the status bar says saved', async () => {
      await key(page, 'Control+s');
      await sleep(600);
      const st = await page.evaluate(() => document.getElementById('save-state').textContent);
      assert(/saved/.test(st), 'save pill reads "' + st + '"');
      assert(fs.existsSync(SIDECAR), SIDECAR + ' not written');
      const data = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
      assert(data.format === 'quire-marks/1', 'format ' + data.format);
      assert(Array.isArray(data.annotations) && data.annotations.length > 0, 'no annotations in sidecar');
      return `${data.annotations.length} annotations -> ${path.basename(SIDECAR)}`;
    });

    await step('autosave picks up a new mark without Ctrl+S', async () => {
      await page.click('.tool-btn[data-tool="note"]');
      const p = await pageBox(1);
      await page.mouse.click(p.x - 80, p.top + 30);
      await page.waitForSelector('.note-editor textarea', { timeout: 5000 });
      await page.keyboard.type('autosaved');
      await page.evaluate(() => [...document.querySelectorAll('.note-editor .btn')].find((b) => b.textContent === 'Save').click());
      const deadline = Date.now() + 8000;
      let payload = null;
      while (Date.now() < deadline && !payload) {
        await sleep(300);
        try {
          const d = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
          if (d.annotations.some((a) => a.text === 'autosaved')) payload = d;
        } catch { /* not written yet */ }
      }
      assert(payload, 'autosave never reached the sidecar');
      return 'autosaved note reached the sidecar';
    });

    /* ----------------------------------------------------------------- export */

    await step('the export menu opens and closes on click', async () => {
      // Back to select first: a click on the page with the note tool active
      // would drop a note rather than just dismiss the menu.
      await page.click('.tool-btn[data-tool="select"]');
      await sleep(150);
      await page.click('#btn-export');
      await sleep(150);
      const open = await page.evaluate(() => !document.getElementById('export-menu').hidden);
      assert(open, 'menu did not open');
      await page.mouse.click(300, 300);
      await sleep(150);
      const closed = await page.evaluate(() => document.getElementById('export-menu').hidden);
      assert(closed, 'clicking away left the menu open');
      return 'opened, closed';
    });

    await step('export writes a PDF carrying real annotation objects', async () => {
      const out = path.join(OUT, 'interactions-export.pdf');
      const written = await page.evaluate((target) => window.__quire.exportPdf('annot', target), out);
      assert(written === out, 'returned ' + written);
      const buf = fs.readFileSync(out);
      assert(buf.length > 1000, 'exported file only ' + buf.length + ' bytes');
      // Subtypes live in compressed object streams, so read them through pdf-lib.
      const doc = await PDFDocument.load(buf);
      const subtypes = [];
      for (const p of doc.getPages()) {
        const arr = doc.context.lookup(p.node.get(PDFName.of('Annots')), PDFArray);
        if (!arr) continue;
        for (let i = 0; i < arr.size(); i++) {
          subtypes.push(String(doc.context.lookup(arr.get(i)).get(PDFName.of('Subtype'))));
        }
      }
      assert(subtypes.length > 0, 'no annotation objects in the export');
      return `${subtypes.length} annotation objects (${subtypes.join(', ')}) in ${path.basename(out)}`;
    });

    /* ----------------------------------------------------------------- chrome */

    await step('Ctrl+/ opens the shortcut list, Escape closes it', async () => {
      await key(page, 'Control+/');
      await sleep(250);
      const open = await page.evaluate(() => document.getElementById('help').open && document.getElementById('help-table').rows.length > 10);
      assert(open, 'help dialog not open with rows');
      await page.keyboard.press('Escape');
      await sleep(200);
      const closed = await page.evaluate(() => !document.getElementById('help').open);
      assert(closed, 'dialog stayed open after Escape');
      return 'help dialog';
    });

    await step('Ctrl+Shift+L flips the theme both ways', async () => {
      const a = await page.evaluate(() => document.documentElement.dataset.theme);
      await key(page, 'Control+Shift+l');
      await sleep(250);
      const b = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, stored: localStorage.getItem('quire-theme') }));
      assert(b.theme !== a, 'theme did not change');
      assert(b.stored === b.theme, 'stored ' + b.stored + ' but live ' + b.theme);
      await key(page, 'Control+Shift+l');
      await sleep(250);
      const c = await page.evaluate(() => document.documentElement.dataset.theme);
      assert(c === a, 'theme not restored');
      return a + ' -> ' + b.theme + ' -> ' + c;
    });

    await step('the window title follows the document', async () => {
      const t = await page.title();
      assert(t === 'quire-sample.pdf — Quire', 'title is "' + t + '"');
      return t;
    });

    /* ------------------------------------------------------------ error paths */

    await step('opening a file Quire cannot read reports a toast and keeps the document', async () => {
      await page.evaluate((p) => window.__quire.openPath(p), NOTAPDF);
      await sleep(700);
      const toast = await lastToast();
      const doc = await page.evaluate(() => window.__quire.state.doc?.name);
      assert(/not a PDF or Markdown/.test(toast), 'toast: "' + toast + '"');
      assert(doc === 'quire-sample.pdf', 'document changed to ' + doc);
      return toast;
    });

    await step('a missing path reports a toast', async () => {
      await page.evaluate(() => window.__quire.openPath('C:\\nope\\nothing.pdf'));
      await sleep(600);
      const toast = await lastToast();
      assert(/Could not open/.test(toast), 'toast: "' + toast + '"');
      return toast;
    });

    await step('an image-only PDF opens with an empty text layer', async () => {
      await page.evaluate((p) => window.__quire.openPath(p), SCAN);
      await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 1, { timeout: 15000 });
      const st = await page.evaluate(() => ({
        spans: document.querySelectorAll('.page-wrap[data-page="1"] .text-layer span').length,
        marks: window.__quire.annotator.list.length,
        count: document.getElementById('search-count').textContent
      }));
      assert(st.spans === 0, st.spans + ' text spans on a scanned page');
      assert(st.marks === 0, st.marks + ' marks carried over from the other document');
      assert(st.count === '', 'search count carried over: "' + st.count + '"');
      return '1 page, 0 spans, marks reset';
    });

    await step('search on a scanned PDF reports no matches without hanging', async () => {
      await page.evaluate(() => {
        const i = document.getElementById('search-input');
        i.focus();
        i.value = 'scanned';
        i.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForFunction(() => document.getElementById('search-count').textContent === 'no matches', { timeout: 15000 });
      return 'no matches';
    });

    await step('closing the document returns to the welcome screen', async () => {
      await key(page, 'Control+w');
      await sleep(400);
      const st = await page.evaluate(() => ({
        welcome: getComputedStyle(document.getElementById('welcome')).display,
        pages: document.querySelectorAll('.page-wrap').length,
        searchHidden: document.getElementById('search-group').hidden,
        title: document.title
      }));
      assert(st.welcome !== 'none', 'welcome still hidden');
      assert(st.pages === 0, st.pages + ' pages left');
      assert(st.searchHidden, 'search box still visible');
      assert(st.title === 'Quire', 'title "' + st.title + '"');
      return 'welcome screen, title reset';
    });

    /* --------------------------------------------------------------- visual */

    await page.evaluate(() => document.body.classList.contains('has-doc'));
    await page.screenshot({ path: path.join(OUT, 'interactions-welcome.png') });
    await page.evaluate((p) => window.__quire.openPath(p), SAMPLE);
    await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 3, { timeout: 20000 });
    await sleep(1200);
    await page.screenshot({ path: path.join(OUT, 'interactions-doc.png') });
  } catch (err) {
    console.log('e2e:interactions crashed:', err.message);
    console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    console.log(log.join('').slice(-1200));
    process.exitCode = 1;
  } finally {
    console.log('');
    for (const [status, name, detail] of results) {
      console.log(`${status} ${name}${detail ? '  — ' + detail : ''}`);
    }
    const failed = results.filter(([s]) => s === 'FAIL');
    console.log('');
    if (failed.length) {
      console.log(`e2e:interactions FAILED — ${failed.length} of ${results.length} steps`);
      process.exitCode = 1;
    } else if (!process.exitCode) {
      console.log(`e2e:interactions: ok — ${results.length} steps`);
    }
    if (browser) await browser.disconnect().catch(() => {});
    if (process.platform === 'win32') {
      require('child_process').spawnSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', shell: true });
    } else child.kill();
  }
})();
