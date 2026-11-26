/**
 * How long a double-click takes to show pages. Times spawn -> first page painted
 * for any exe: --exe path, repeated runs to see the portable re-extract cost.
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { ROOT, launch, attach, ensureSamples } = require('../test/cdp');

const SAMPLE = path.join(ROOT, 'samples', 'quire-sample.pdf');

function killTree(child) {
  if (process.platform === 'win32') spawnSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', shell: true });
  else child.kill();
}

async function runOnce(exe, port) {
  const t0 = Date.now();
  const { child } = launch({ binary: exe, app: null, port, args: [SAMPLE] });
  let browser;
  try {
    const { browser: b, page } = await attach(port, 120000);
    browser = b;
    const tAttach = Date.now();
    await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 3, { timeout: 120000 });
    await page.waitForFunction(() => {
      const c = document.querySelector('.page-wrap canvas');
      return c && c.width > 100;
    }, { timeout: 60000 });
    const tPaint = Date.now();
    return { toWindow: tAttach - t0, toPaint: tPaint - t0 };
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
    killTree(child);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function main() {
  ensureSamples();
  const args = process.argv.slice(2);
  const runsFlag = args.indexOf('--runs');
  const runs = runsFlag > -1 ? Math.max(1, Number(args[runsFlag + 1]) || 2) : 2;
  const targets = args.filter((a, i) => !a.startsWith('-') && !(runsFlag > -1 && i === runsFlag + 1));
  if (!targets.length) {
    console.log('usage: node tools/launch-time.js <exe> [<exe> ...] [--runs N]');
    return;
  }
  let port = 9233;
  for (const raw of targets) {
    const exe = path.resolve(raw);
    if (!fs.existsSync(exe)) { console.log('missing', exe); continue; }
    console.log(path.relative(ROOT, exe));
    for (let run = 1; run <= runs; run++) {
      const { toWindow, toPaint } = await runOnce(exe, port++);
      console.log(`  run ${run}: window ${toWindow} ms, pages painted ${toPaint} ms`);
    }
  }
}

main();
