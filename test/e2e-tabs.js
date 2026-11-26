const path = require('node:path');
const assert = require('node:assert/strict');
const { ROOT, launch, attach, ensureSamples } = require('./cdp');

ensureSamples();
const pdf = path.join(ROOT, 'samples', 'quire-sample.pdf');
const md = path.join(ROOT, 'samples', 'quire-sample.md');

(async () => {
  const { child, log } = launch({ port: 9256, args: [pdf] });
  let browser;
  try {
    const connection = await attach(9256);
    browser = connection.browser;
    const page = connection.page;
    await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 3);
    await page.evaluate(() => window.__quire.viewer.gotoPage(2));
    await page.waitForFunction(() => window.__quire.viewer.current === 2);
    await page.evaluate((file) => window.__quire.openPath(file), md);
    assert.equal(await page.$$('.doc-tab').then((items) => items.length), 2);
    assert.equal(await page.$eval('.doc-tab.active .tab-kind', (el) => el.textContent), 'MD');
    await page.focus('.doc-tab.active');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('.doc-tab.active .tab-kind')?.textContent === 'PDF' && window.__quire.viewer.pages.length === 3);
    assert.equal(await page.evaluate(() => window.__quire.viewer.current), 2);
    await page.evaluate((file) => window.__quire.openPath(file), md);
    assert.equal(await page.$$('.doc-tab').then((items) => items.length), 2, 'opening an existing file should select its tab');
    await page.click('.doc-tab.active .tab-close');
    await page.waitForFunction(() => document.querySelectorAll('.doc-tab').length === 1 && document.querySelector('.doc-tab.active .tab-kind')?.textContent === 'PDF');
    await page.click('.doc-tab.active .tab-close');
    await page.waitForFunction(() => !document.body.classList.contains('has-doc'));
    console.log('tabs: open, switch, restore, deduplicate and close: ok');
  } catch (err) {
    console.error(err, log.join(''));
    process.exitCode = 1;
  } finally {
    browser?.disconnect();
    child.kill();
  }
})();
