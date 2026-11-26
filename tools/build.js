/**
 * Package the app into build/Quire-win32-x64/Quire.exe.
 *
 * Electron is taken from the already-installed dist, so nothing is downloaded,
 * and dev-only folders are left out of the shipped app.
 */
const path = require('node:path');
const fs = require('node:fs');
const { packager } = require('@electron/packager');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');

async function main() {
  const icon = path.join(ROOT, 'assets', 'quire.ico');
  if (!fs.existsSync(icon)) {
    console.error('assets/quire.ico missing — run npm run icon first');
    process.exit(1);
  }

  const builds = await packager({
    dir: ROOT,
    name: 'Quire',
    platform: 'win32',
    arch: 'x64',
    out: OUT,
    overwrite: true,
    prune: true,
    icon,
    electronPath: path.join(ROOT, 'node_modules', 'electron', 'dist'),
    // Replaces packager's defaults, so keep the dev junk out by hand.
    ignore: [
      /^\/node_modules\/(electron|@electron|puppeteer)/,
      /^\/(test|samples|dist|build|tools|README\.md|\.gitignore|package-lock\.json)/,
      /\/\.git\//
    ],
    // pdfjs-dist drags in @napi-rs/canvas for Node rendering; the renderer never uses it.
    afterPrune: [async (options) => {
      const native = path.join(options.buildPath, 'node_modules', '@napi-rs');
      if (fs.existsSync(native)) fs.rmSync(native, { recursive: true, force: true });
    }]
  });

  for (const b of Array.isArray(builds) ? builds : [builds]) {
    const exe = path.join(b, 'Quire.exe');
    console.log('built', exe, fs.existsSync(exe) ? '(' + Math.round(fs.statSync(exe).size / 1e6) + ' MB launcher)' : 'MISSING');
    console.log('app folder', Math.round(dirSize(path.join(b, 'resources')) / 1e6), 'MB');
  }
}

function dirSize(p) {
  let total = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

main().catch((err) => {
  console.error('build FAILED:', err.message || err);
  process.exit(1);
});
