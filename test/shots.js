/**
 * Visual pass over the UI surfaces that unit tests cannot judge: the Document
 * tab, export menu, print dialog, welcome screen, Markdown reader, source
 * editor and shortcut list.
 *
 * Each step screenshots the window and asserts the surface is actually there,
 * so this doubles as a layout regression check. Images land in test/out as
 * ux-*.png. Run with `npm run shots`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, launch, attach, sleep, ensureSamples } = require('./cdp');

const OUT = path.join(ROOT, 'test', 'out');
const PORT = 9261;
const samples = ensureSamples();

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('ok   ' + name + ' — ' + detail);
  else { failures++; console.log('FAIL ' + name + ' — ' + detail); }
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, 'ux-' + name + '.png') });
  return 'test/out/ux-' + name + '.png';
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { child, log } = launch({ port: PORT, args: [samples[0]] });
  const { browser, page } = await attach(PORT);
  await sleep(2500);

  /* Document tab, scrolled through its sections. */
  await page.click('#tab-doc');
  await sleep(700);
  const pages = await page.evaluate(() => ({
    rows: document.querySelectorAll('.dp-page').length,
    count: document.querySelector('#dp-count').textContent,
    size: document.querySelector('.dp-page-size')?.textContent || '',
    paneW: document.querySelector('#pane-doc').clientWidth,
    scrollW: document.querySelector('#pane-doc').scrollWidth
  }));
  await shot(page, 'doc-tab');
  check('the Document tab lists the pages', pages.rows === 3, `${pages.rows} rows, header "${pages.count}"`);
  check('page sizes fit on one line', /\d+ × \d+/.test(pages.size) && !/pt/.test(pages.size), JSON.stringify(pages.size));
  check('the Document pane does not overflow sideways', pages.scrollW <= pages.paneW + 1, `${pages.scrollW} <= ${pages.paneW}`);

  for (const [name, top] of [['doc-tab-2', 220], ['doc-tab-3', 520], ['doc-tab-4', 900]]) {
    await page.evaluate((y) => { document.querySelector('#pane-doc').scrollTop = y; }, top);
    await sleep(300);
    await shot(page, name);
  }

  await page.evaluate(() => { document.querySelector('#sidebar').style.width = '320px'; });
  await sleep(400);
  const wide = await page.evaluate(() => ({
    paneW: document.querySelector('#pane-doc').clientWidth,
    scrollW: document.querySelector('#pane-doc').scrollWidth,
    gridCols: getComputedStyle(document.querySelector('.dp-grid')).gridTemplateColumns.split(' ').length
  }));
  await shot(page, 'doc-tab-wide');
  await page.evaluate(() => { document.querySelector('#sidebar').style.width = ''; });
  await sleep(300);
  check('metadata spreads over two columns on a wide sidebar', wide.gridCols >= 2 && wide.scrollW <= wide.paneW + 1,
    `${wide.gridCols} columns, ${wide.scrollW} <= ${wide.paneW}`);

  /* Export menu, and Escape closing it. */
  await page.evaluate(() => document.querySelector('#btn-export').click());
  await sleep(300);
  const items = await page.evaluate(() => [...document.querySelectorAll('#export-menu button:not([hidden])')].map((b) => b.textContent));
  await shot(page, 'export-menu');
  check('the export menu offers PDF modes', items.length >= 2, items.join(' / '));
  await page.keyboard.press('Escape');
  await sleep(300);
  const closed = await page.evaluate(() => document.querySelector('#export-menu').hidden);
  check('Escape closes the export menu', closed === true, 'menu hidden');

  /* Print options. */
  await page.keyboard.down('Control');
  await page.keyboard.press('p');
  await page.keyboard.up('Control');
  await sleep(500);
  const print = await page.evaluate(() => ({
    open: document.querySelector('#print-options').open,
    fields: [...document.querySelectorAll('#print-options select, #print-options input')].map((f) => f.id || f.name)
  }));
  await shot(page, 'print-dialog');
  check('the print dialog offers paper, orientation and margins', print.open && print.fields.length >= 4, print.fields.join(', '));
  await page.keyboard.press('Escape');
  await sleep(250);

  /* Welcome screen after closing the document. */
  await page.evaluate(() => window.__quire.closeDocument());
  await sleep(500);
  const welcome = await page.evaluate(() => ({
    welcome: getComputedStyle(document.querySelector('#welcome')).display,
    hasDoc: document.body.classList.contains('has-doc'),
    badge: document.querySelector('#mark-badge').hidden,
    rows: document.querySelectorAll('.dp-page').length,
    marks: window.__quire.annotator.list.length,
    note: document.querySelector('#pane-doc .empty-note')?.textContent || ''
  }));
  await shot(page, 'welcome');
  check('closing the document returns to the welcome screen', welcome.welcome === 'block' && !welcome.hasDoc && welcome.rows === 0,
    `${welcome.rows} page rows, note "${welcome.note}"`);
  check('closing clears the mark list and its badge', welcome.marks === 0 && welcome.badge === true, 'badge hidden, 0 marks');

  /* Markdown reader and source editor. */
  await page.evaluate((p) => window.__quire.openPath(p), samples[2]);
  await sleep(1600);
  const md = await page.evaluate(() => ({
    blocks: document.querySelectorAll('.md-article > *').length,
    edit: !document.querySelector('#btn-edit').hidden
  }));
  await shot(page, 'markdown');
  check('Markdown renders into the reader', md.blocks > 5 && md.edit, `${md.blocks} blocks, Edit button shown`);

  await page.evaluate(() => document.querySelector('#btn-edit').click());
  await sleep(500);
  const editor = await page.evaluate(() => ({
    open: !document.querySelector('.md-editor').hidden,
    pos: document.querySelector('#ed-pos').textContent,
    stats: document.querySelector('#ed-stats').textContent,
    tools: document.querySelectorAll('.ed-btn').length,
    divider: !!document.querySelector('.ed-div')
  }));
  await shot(page, 'md-editor');
  check('the source editor opens at the top of the file', editor.open && /Line 1, col 1/.test(editor.pos), `${editor.stats}, ${editor.pos}`);
  check('the toolbar separates formatting from file actions', editor.tools === 11 && editor.divider, `${editor.tools} buttons + divider`);

  /* Shortcut list. */
  await page.evaluate(() => document.querySelector('#help').showModal());
  await sleep(300);
  const help = await page.evaluate(() => ({
    open: document.querySelector('#help').open,
    rows: document.querySelectorAll('#help-table tr').length,
    text: document.querySelector('#help-table').textContent
  }));
  await shot(page, 'help');
  check('the shortcut list documents the new commands', help.open && /Ctrl\+N/.test(help.text) && /Ctrl\+Shift\+H/.test(help.text),
    `${help.rows} rows`);

  browser.disconnect();
  child.kill();
  const noisy = log.join('').match(/error|uncaught|failed/i);
  check('nothing logged a console error', !noisy, noisy ? log.join('').slice(0, 300) : 'clean');

  const written = fs.readdirSync(OUT).filter((f) => f.startsWith('ux-')).length;
  console.log(`\nshots: ${failures ? failures + ' FAILURES' : 'ok'} — ${written} images in test/out`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => { console.error('shots FAILED: ' + err.stack || err.message); process.exit(1); });
