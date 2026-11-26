const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { ROOT, launch, attach, ensureSamples } = require('./cdp');

ensureSamples();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-session-test-'));
const pdf = path.join(profile, 'session-test.pdf');
fs.copyFileSync(path.join(ROOT, 'samples', 'quire-sample.pdf'), pdf);
const md = path.join(ROOT, 'samples', 'quire-sample.md');
const port = 9258;
const exeFlag = process.argv.indexOf('--exe');
const binary = exeFlag < 0 ? null : path.resolve(process.argv[exeFlag + 1]);

async function start(args = []) {
  const process = launch({ port, args, userDataDir: profile, ...(binary ? { binary, app: null } : {}) });
  const connection = await attach(port);
  await connection.page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 20000 });
  return { ...process, ...connection };
}
async function stop(run) {
  const exited = new Promise((resolve) => run.child.once('exit', resolve));
  await run.page.evaluate(() => window.close()).catch(() => {});
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('app did not close')), 10000))]);
  run.browser.disconnect();
}

(async () => {
  let run;
  try {
    run = await start([pdf]);
    await run.page.evaluate((file) => window.__quire.openPath(file), md);
    await run.page.evaluate((file) => window.__quire.openPath(file), pdf);
    await run.page.evaluate(() => window.__quire.viewer.gotoPage(2));
    await run.page.waitForFunction(() => window.__quire.viewer.current === 2);
    await run.page.click('#btn-preferences');
    await run.page.screenshot({ path: path.join(ROOT, 'test', 'out', 'preferences.png') });
    await run.page.select('#pref-theme', 'light');
    await run.page.click('#preferences .dialog-actions button');
    await run.page.evaluate(() => window.__quire.annotator.mutate(() => window.__quire.annotator.list.push({ id: 'close-test', kind: 'note', page: 2, x: 50, y: 50, color: '#f59f00', text: 'Saved on close' })));
    await stop(run); run = null;
    assert.equal(JSON.parse(fs.readFileSync(pdf + '.marks.json', 'utf8')).annotations[0].id, 'close-test', 'closing flushes pending annotations');

    const sessionFile = path.join(profile, 'session.json');
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    session.tabs.push({ path: path.join(profile, 'missing.pdf'), view: null });
    fs.writeFileSync(sessionFile, JSON.stringify(session));

    run = await start();
    assert.equal(await run.page.$$('.doc-tab').then((items) => items.length), 2, 'restores both open files');
    assert.match(await run.page.$eval('.toast:last-child', (el) => el.textContent), /Could not reopen 1 file/);
    assert.match(await run.page.$eval('.doc-tab.active .tab-name', (el) => el.textContent), /session-test\.pdf/);
    assert.equal(await run.page.evaluate(() => window.__quire.annotator.list[0]?.id), 'close-test');
    await run.page.waitForFunction(() => window.__quire.viewer.current === 2, { timeout: 10000 });
    assert.equal(await run.page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await run.page.click('#btn-preferences');
    assert.equal(await run.page.$eval('#pref-restore', (el) => el.checked), true);
    await run.page.click('#pref-position');
    await run.page.click('#preferences .dialog-actions button');
    await stop(run); run = null;

    run = await start();
    assert.equal(await run.page.$$('.doc-tab').then((items) => items.length), 2, 'tabs still reopen when position memory is disabled');
    assert.equal(await run.page.evaluate(() => window.__quire.viewer.current), 1, 'disabled position memory starts at the first page');
    await run.page.click('#btn-preferences');
    await run.page.click('#pref-restore');
    assert.equal(await run.page.$eval('#pref-position', (el) => el.disabled), true);
    await run.page.click('#preferences .dialog-actions button');
    await stop(run); run = null;

    run = await start();
    assert.equal(await run.page.$$('.doc-tab').then((items) => items.length), 0, 'disabled restoration starts with no tabs');
    assert.equal(await run.page.evaluate(() => document.documentElement.dataset.theme), 'light', 'appearance persists independently');
    await stop(run); run = null;
    console.log('session: tabs, active file, reading position, appearance and opt-out survive restart: ok');
  } catch (err) {
    console.error(err, run?.log?.join('') || '');
    process.exitCode = 1;
  } finally {
    if (run) { run.browser?.disconnect(); run.child.kill(); }
    const resolved = path.resolve(profile);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('quire-session-test-')) {
      try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Windows may still hold a profile file briefly. */ }
    }
  }
})();
