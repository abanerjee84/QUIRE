/**
 * Cold-start and chrome checks: the window opens with no document, the welcome
 * screen offers to open one, and the view-level controls (theme, sidebar, help,
 * print styles, recents) behave. Run with `npm run e2e:chrome`.
 */
const path = require('node:path');
const fs = require('node:fs');

const { ROOT, launch, attach, sleep, ensureSamples } = require('./cdp');

const SAMPLE = path.join(ROOT, 'samples', 'quire-sample.pdf');
const OUT = path.join(ROOT, 'test', 'out');
const PORT = 9225;

ensureSamples();

/** Hold the modifiers, tap the key, release. puppeteer rejects some combos. */
async function key(page, combo) {
  const parts = combo.split('+');
  const mods = parts.slice(0, -1);
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(parts[parts.length - 1].toLowerCase());
  for (const m of mods.reverse()) await page.keyboard.up(m);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // no PDF argument: the app should come up on the welcome screen
  const { child, log } = launch({ port: PORT });

  let browser;
  try {
    const { browser: b, page } = await attach(PORT);
    browser = b;

    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    await page.waitForFunction(() => !!window.__quire && !!window.api, { timeout: 20000 });
    const cold = await page.evaluate(() => ({
      doc: window.__quire.state.doc,
      welcome: getComputedStyle(document.getElementById('welcome')).display,
      openButton: !!document.getElementById('welcome-open'),
      theme: document.documentElement.dataset.theme,
      pages: document.querySelectorAll('.page-wrap').length
    }));
    console.log('cold start:', JSON.stringify(cold));
    if (cold.doc !== null) throw new Error('a document was opened without being asked for');
    if (cold.welcome === 'none') throw new Error('welcome screen hidden on cold start');
    if (!cold.openButton) throw new Error('welcome screen has no open button');
    if (cold.pages !== 0) throw new Error('pages rendered with no document');

    const boot = await page.evaluate(() => window.api.boot());
    console.log('boot:', JSON.stringify(boot));
    if (!boot || !boot.platform) throw new Error('boot info missing');

    await page.screenshot({ path: path.join(OUT, 'e2e-welcome.png') });

    await page.evaluate(async (p) => { await window.__quire.openPath(p); }, SAMPLE);
    await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 3, { timeout: 20000 });
    const opened = await page.evaluate(() => ({
      welcome: getComputedStyle(document.getElementById('welcome')).display,
      name: window.__quire.state.doc.name,
      title: document.title
    }));
    console.log('after open:', JSON.stringify(opened));
    if (opened.welcome !== 'none') throw new Error('welcome screen still visible after opening');
    if (!opened.title.includes(opened.name)) throw new Error('window title does not name the file: ' + opened.title);

    const recent = await page.evaluate(() => window.api.recentList());
    console.log('recent entries:', recent.length, recent[0] && recent[0].name);
    if (!recent.some((e) => e.path === SAMPLE)) throw new Error('opened file missing from the recent list');

    // theme flips and survives a reload
    await key(page, 'Control+Shift+L');
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    console.log('theme after Ctrl+Shift+L:', theme);
    if (theme !== 'light') throw new Error('theme did not flip to light');
    await page.screenshot({ path: path.join(OUT, 'e2e-light.png') });
    await page.screenshot({ path: path.join(OUT, 'e2e-topbar.png'), clip: { x: 0, y: 0, width: 780, height: 90 } });

    // sidebar toggle
    const wideBefore = await page.evaluate(() => document.querySelector('.viewer').clientWidth);
    await key(page, 'Control+B');
    await sleep(200);
    const wideAfter = await page.evaluate(() => ({
      width: document.querySelector('.viewer').clientWidth,
      hidden: document.body.classList.contains('no-sidebar')
    }));
    console.log('viewer width', wideBefore, '->', wideAfter.width, 'no-sidebar:', wideAfter.hidden);
    if (!wideAfter.hidden || wideAfter.width <= wideBefore) throw new Error('Ctrl+B did not widen the viewer');

    // help dialog lists the shortcuts
    await key(page, 'Control+/');
    await sleep(200);
    const help = await page.evaluate(() => {
      const d = document.getElementById('help');
      return { open: d.open, text: d.textContent };
    });
    console.log('help dialog open:', help.open, 'mentions Ctrl+O:', help.text.includes('Ctrl+O'));
    if (!help.open || !help.text.includes('Ctrl+O')) throw new Error('help dialog not usable');
    await page.evaluate(() => document.getElementById('help').close());

    // print rules exist and hide the chrome
    const printRules = await page.evaluate(() => {
      const out = [];
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule.conditionText && rule.conditionText.includes('print')) out.push(rule.cssText.slice(0, 120));
        }
      }
      return out;
    });
    console.log('print rules:', printRules.length);
    if (!printRules.some((r) => r.includes('topbar'))) throw new Error('no print rule hides the toolbar');

    // closing the document returns to the welcome screen
    await key(page, 'Control+W');
    await sleep(300);
    const closed = await page.evaluate(() => ({
      doc: window.__quire.state.doc,
      welcome: getComputedStyle(document.getElementById('welcome')).display,
      pages: document.querySelectorAll('.page-wrap').length
    }));
    console.log('after Ctrl+W:', JSON.stringify(closed));
    if (closed.doc !== null || closed.pages !== 0 || closed.welcome === 'none') {
      throw new Error('Ctrl+W left the document open');
    }

    if (errors.length) throw new Error('renderer errors:\n' + errors.join('\n'));
    console.log('\ne2e:chrome: ok');
  } catch (err) {
    console.error('e2e:chrome FAILED:', err.message);
    console.error('--- electron log ---\n' + log.join('').slice(-3000));
    process.exitCode = 1;
  } finally {
    if (browser) browser.disconnect();
    child.kill();
  }
}

main();
