/** Build Windows distributions using the locally installed Electron runtime. */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const requested = process.argv.slice(2);
const release = requested.includes('--release');
const targets = requested.filter((arg) => arg !== '--release');
if (!targets.length) targets.push('nsis', 'zip');

if (!release) {
  console.warn('Distribution may be unsigned. Use npm run dist:release with a configured code-signing certificate for a signed release.');
}
const args = ['electron-builder', '--win', ...targets, '--config.electronDist=node_modules/electron/dist'];
if (release) args.push('--config.forceCodeSigning=true');
const result = spawnSync('npx', args, { cwd: root, stdio: 'inherit', shell: true, env: process.env });
if (result.error) console.error('Could not start electron-builder:', result.error.message);
process.exit(result.status === null ? 1 : result.status);
