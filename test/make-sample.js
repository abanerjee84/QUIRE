/** Builds a small multi-page PDF so the app has something to open in tests. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const PARAGRAPHS = [
  'Quire keeps annotations in a sidecar file next to the document, so the original PDF is never rewritten unless you export it.',
  'Select a line of text and the highlight snaps to the text boxes reported by pdf.js, then fragments on the same line merge into one stroke.',
  'Scanned pages have no text layer. With the highlight tool, drag a box over the image instead and a freeform region is created.',
  'Exporting writes real PDF annotations: Highlight, Text, Ink, Square and Line, which Acrobat and Chrome render as markup.',
  'Zoom never changes the stored geometry. Marks are kept in PDF points and the overlay is scaled by the SVG viewBox.'
];

async function main() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (let page = 0; page < 3; page++) {
    const sheet = doc.addPage([595.28, 841.89]); // A4
    sheet.drawText('Quire sample document', {
      x: 56, y: 780, size: 22, font: bold, color: rgb(0.12, 0.12, 0.14)
    });
    sheet.drawText('Page ' + (page + 1) + ' of 3', {
      x: 56, y: 756, size: 11, font, color: rgb(0.45, 0.45, 0.5)
    });

    let y = 712;
    for (let i = 0; i < PARAGRAPHS.length; i++) {
      const heading = 'Section ' + (page * PARAGRAPHS.length + i + 1);
      sheet.drawText(heading, { x: 56, y, size: 13, font: bold, color: rgb(0.1, 0.1, 0.12) });
      y -= 20;
      for (const line of wrap(PARAGRAPHS[i], 78)) {
        sheet.drawText(line, { x: 56, y, size: 11, font, color: rgb(0.18, 0.18, 0.2) });
        y -= 15;
      }
      y -= 14;
    }

    sheet.drawRectangle({
      x: 56, y: 90, width: 483, height: 120,
      borderColor: rgb(0.6, 0.6, 0.65), borderWidth: 1, opacity: 0
    });
    sheet.drawText('Figure ' + (page + 1) + ' — reserved for a diagram', {
      x: 66, y: 148, size: 10, font, color: rgb(0.5, 0.5, 0.55)
    });
  }

  const bytes = await doc.save();
  const out = path.join(__dirname, '..', 'samples', 'quire-sample.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log('wrote', out, bytes.length, 'bytes');

  // A page with an image and no text at all, to exercise the freeform path.
  const scan = await PDFDocument.create();
  const image = await scan.embedPng(scanPng(64, 83));
  const sheet = scan.addPage([612, 792]);
  sheet.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  const scanBytes = await scan.save();
  const scanOut = path.join(__dirname, '..', 'samples', 'scan-sample.pdf');
  fs.writeFileSync(scanOut, scanBytes);
  console.log('wrote', scanOut, scanBytes.length, 'bytes');

  writeMarkdown();
}

const MARKDOWN = String.raw`
# Quire Markdown sample

A sidecar file called @BT@<name>.marks.json@BT@ sits next to the document. Highlights,
underlines, strike-throughs and notes are anchored to the text they mark, so the
source file keeps its bytes and the markup survives a reopen.

## How marks are stored

Each annotation records the block it lives in and the character range inside that
block. A highlight over the phrase *character range* therefore survives reflow,
zoom and a theme switch.

- Highlights follow the selection, one entry per block it touches
- Underlines and strike-throughs use the same anchors
- Notes pin to a block and keep their text in the sidecar
- Ink and shapes belong to a PDF page, not to Markdown

### Colour

The palette is the same as for PDFs: amber, green, blue, red. The colour travels
with the annotation, so a highlight stays amber in the light theme and in a
printed export.

## Mathematics

Inline maths rides inside a sentence: the sidecar is compact because only offsets
are stored, so the payload for a highlight over $E = mc^2$ is a handful of bytes.

Display maths gets its own line:

$$
\int_0^{\infty} e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

\[
H\psi = \left(-\frac{\hbar^2}{2m}\nabla^2 + V\right)\psi = E\psi
\]

\(\sigma = \sqrt{\operatorname{var}(x)}\) is the standard deviation, written with
the LaTeX delimiters some documents use.

~~~text
format: quire-marks/1
savedAt: 2026-01-01T00:00:00.000Z
document: { path, name, size, kind, pageCount }
annotations: [ { kind, color, segs, text } ]
~~~

## Layout limits

| Surface | Anchors | Search unit | Navigation unit |
| --- | --- | --- | --- |
| PDF | page, rects in PDF points | rendered page | page |
| Markdown | block index, character offsets | whole document | heading |

> Zoom scales the type on Markdown and the canvas on a PDF. Neither changes the
> stored geometry of a mark.

![Sidecar layout](quire-diagram.png)

Links to the wider web open outside the app, links to a sibling file open inside
it: [the README](../README.md).

---

## Printing and export

Printing the rendered document is handled by Electron's print pipeline, which is
why the exported PDF looks like the screen rather than the source bytes.
`;

function writeMarkdown() {
  const dir = path.join(__dirname, '..', 'samples');
  fs.mkdirSync(dir, { recursive: true });

  const md = MARKDOWN.trim().replace(/@BT@/g, '`');
  const mdOut = path.join(dir, 'quire-sample.md');
  fs.writeFileSync(mdOut, md + '\n');
  console.log('wrote', mdOut, md.length, 'bytes');

  const pngOut = path.join(dir, 'quire-diagram.png');
  fs.writeFileSync(pngOut, diagramPng(320, 180));
  console.log('wrote', pngOut);

  const txtOut = path.join(dir, 'notes.txt');
  fs.writeFileSync(txtOut, 'Plain text is treated as Markdown.\n\nTwo blank lines separate paragraphs.\n');
  console.log('wrote', txtOut);
}

/** A labelled diagram so the Markdown sample has something real to embed. */
function diagramPng(w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const box = (x > 24 && x < w - 24 && y > 24 && y < h - 24);
      const band = box && y > h / 2 - 14 && y < h / 2 + 14;
      const edge = box && (x === 24 || x === w - 25 || y === 24 || y === h - 25);
      let r = 246, g = 248, b = 252;
      if (edge) { r = 40; g = 44; b = 52; }
      else if (band) { r = 242; g = 200; b = 17; }
      else if (box) { r = 232; g = 236; b = 242; }
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Tiny PNG encoder: a white page with grey bars, good enough to be a scan. */
function scanPng(w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const line = y % 5 === 2 && x > 6 && x < w - 6;
      const v = line ? 90 + (x % 7) * 6 : 247;
      raw[o++] = v; raw[o++] = v; raw[o++] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // 8-bit
  ihdr[9] = 2;   // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([head, typeBuf, data, crc]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return crc ^ 0xffffffff;
}

function wrap(text, max) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if ((line + ' ' + word).trim().length > max) { lines.push(line.trim()); line = word; }
    else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line.trim());
  return lines;
}

main().catch((err) => { console.error(err); process.exit(1); });
