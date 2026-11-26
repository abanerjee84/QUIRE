/**
 * Syntax check every source file. The renderer modules are ESM while
 * package.json says commonjs, so they get checked through stdin with
 * --input-type=module instead of as files.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const listIn = (dir) =>
  fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).map((f) => dir + '/' + f);

const cjs = [...new Set(['src/main.js', 'src/server.js', 'src/export-pdf.js', 'renderer/preload.js']
  .concat(listIn('src'))
  .concat(listIn('test'))
  .concat(listIn('tools')))];
const esm = listIn('renderer/js');

let failed = 0;

for (const rel of cjs) {
  const run = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
  if (run.status !== 0) { failed++; console.log('FAIL', rel, '\n' + run.stderr.trim()); }
}

for (const rel of esm) {
  const run = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    encoding: 'utf8',
    input: fs.readFileSync(path.join(ROOT, rel), 'utf8')
  });
  if (run.status !== 0) { failed++; console.log('FAIL', rel, '\n' + run.stderr.trim()); }
}

console.log(failed ? `${failed} file(s) failed` : `checked ${cjs.length + esm.length} files: ok`);
process.exit(failed ? 1 : 0);
