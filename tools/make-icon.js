/**
 * Draw the brand mark into a multi-size .ico. No image library: the shapes are
 * the same paths as the logo in index.html, rasterised with 4x supersampling.
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'assets', 'quire.ico');
const SIZES = [16, 24, 32, 48, 256];

const PAPER = [245, 246, 248];
const FOLD = [205, 210, 218];
const ACCENT = [242, 200, 17];
const INK = [40, 44, 51];

/** Same outline as the SVG: page with a cut corner, folded flap, accent bar. */
function sample(u, v) {
  if (!inPoly(u, v, [[4, 2], [15, 2], [20, 7], [20, 22], [4, 22]])) return null;
  if (inPoly(u, v, [[15, 2], [20, 7], [15, 7]])) return FOLD;
  if (u >= 7 && u <= 14.2 && v >= 10.6 && v <= 13.4) return ACCENT;
  if (u >= 7 && u <= 12 && v >= 15.4 && v <= 17.2) return INK;
  if (u >= 7 && u <= 16 && v >= 18.6 && v <= 20.4) return INK;
  return PAPER;
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function render(size) {
  const rgba = new Uint8Array(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0; let g = 0; let b = 0; let hits = 0;
      for (let s = 0; s < SS; s++) {
        for (let t = 0; t < SS; t++) {
          const u = ((px + (s + 0.5) / SS) / size) * 24;
          const v = ((py + (t + 0.5) / SS) / size) * 24;
          const c = sample(u, v);
          if (!c) continue;
          hits++;
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = (py * size + px) * 4;
      if (!hits) continue;
      const area = hits / (SS * SS);
      rgba[o] = r / hits;
      rgba[o + 1] = g / hits;
      rgba[o + 2] = b / hits;
      rgba[o + 3] = Math.round(area * 255);
    }
  }
  return rgba;
}

/** BMP body: 40-byte header, BGRA rows bottom-up, then a 1bpp opaque mask. */
function bmp(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);

  const pixels = Buffer.alloc(size * size * 4);
  let o = 0;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      pixels[o++] = rgba[i + 2];
      pixels[o++] = rgba[i + 1];
      pixels[o++] = rgba[i];
      pixels[o++] = rgba[i + 3];
    }
  }

  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size); // all zeroes: nothing masked out
  return Buffer.concat([header, pixels, mask]);
}

function ico(images) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);            // palette colours
    entry.writeUInt8(0, 3);            // reserved
    entry.writeUInt16LE(1, 4);         // planes
    entry.writeUInt16LE(32, 6);        // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const file = ico(SIZES.map((size) => ({ size, data: bmp(size, render(size)) })));
fs.writeFileSync(OUT, file);
console.log('wrote', OUT, file.length, 'bytes,', SIZES.join('/'), 'px');
