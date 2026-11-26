/**
 * Shared plumbing for the window tests: puppeteer resolution, launching
 * Electron with a debug port, and attaching to the renderer target.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function loadPuppeteer() {
  const roots = [process.env.PUPPETEER_PATH, 'puppeteer'];
  try {
    const out = spawnSync('npm root -g', { encoding: 'utf8', shell: true }).stdout;
    if (out && out.trim()) roots.push(path.join(out.trim(), 'puppeteer'));
  } catch { /* npm not on PATH */ }
  for (const from of roots) {
    try { return require(from); } catch { /* try the next */ }
  }
  throw new Error('puppeteer not found. Install it, or set PUPPETEER_PATH to an install.');
}

const puppeteer = loadPuppeteer();

function electronBinary() {
  try {
    const fromPackage = require('electron');
    if (typeof fromPackage === 'string' && fs.existsSync(fromPackage)) return fromPackage;
  } catch { /* not resolvable */ }
  const name = process.platform === 'win32' ? 'electron.exe'
    : process.platform === 'darwin' ? 'Electron' : 'electron';
  return path.join(ROOT, 'node_modules', 'electron', 'dist', name);
}

/** Start the app with extra argv and collect stdout/stderr for failure reports. */
function launch({ port, args = [], binary = electronBinary(), app = ROOT, userDataDir }) {
  // A packaged exe is its own app, so pass it no directory.
  const argv = [...(app ? [app] : []), ...args, `--remote-debugging-port=${port}`];
  const child = spawn(binary, argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, QUIRE_USER_DATA: userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'quire-test-')) }
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));
  return { child, log };
}

async function attach(port, timeout = 30000) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
      const pages = await browser.pages();
      const page = pages.find((p) => p.url().includes('index.html'));
      if (page) return { browser, page };
      browser.disconnect();
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('no debug target after ' + timeout + 'ms');
}

function ensureSamples() {
  const needed = ['quire-sample.pdf', 'scan-sample.pdf', 'quire-sample.md', 'notes.txt', 'quire-diagram.png']
    .map((f) => path.join(ROOT, 'samples', f));
  if (needed.some((p) => !fs.existsSync(p))) {
    execFileSync(process.execPath, [path.join(ROOT, 'test', 'make-sample.js')], { stdio: 'inherit' });
  }
  return needed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ROOT, puppeteer, launch, attach, sleep, ensureSamples };
