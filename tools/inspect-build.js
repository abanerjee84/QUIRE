const path = require('node:path');
const asar = require('@electron/asar');

const asarPath = path.join(__dirname, '..', 'build', 'Quire-win32-x64', 'resources', 'app.asar');
const list = asar.listPackage(asarPath).map((p) => p.replace(/\\/g, '/'));

const groups = {};
for (const p of list) {
  const m = p.match(/^\/node_modules\/((?:@[^/]+\/[^/]+)|[^/]+)/);
  if (m) groups[m[1]] = (groups[m[1]] || 0) + 1;
}
console.log('asar entries:', list.length);
console.log('shipped node_modules:', groups);

const fs = require('node:fs');
const unpacked = path.join(__dirname, '..', 'build', 'Quire-win32-x64', 'resources', 'app.asar.unpacked', 'node_modules');
if (fs.existsSync(unpacked)) console.log('unpacked:', fs.readdirSync(unpacked));
