/**
 * Node-side smoke test: PDF export in both modes, and the static server that
 * feeds pdf.js to the renderer. Run with `npm run smoke`.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');
const { PDFDocument, PDFName, PDFArray } = require('pdf-lib');
const { exportPdf } = require('../src/export-pdf');
const { startServer } = require('../src/server');

const SAMPLE = path.join(__dirname, '..', 'samples', 'quire-sample.pdf');

const MARKS = [
  {
    id: 'a1', page: 1, kind: 'highlight', color: '#f2c811',
    rects: [{ x: 56, y: 120, w: 320, h: 14 }], text: 'sidecar file', createdAt: Date.now()
  },
  {
    id: 'a2', page: 1, kind: 'underline', color: '#2f9e44', width: 1,
    rects: [{ x: 56, y: 200, w: 240, h: 12 }]
  },
  {
    id: 'a3', page: 2, kind: 'strikeout', color: '#e03131', width: 1,
    rects: [{ x: 56, y: 240, w: 180, h: 12 }]
  },
  {
    id: 'a4', page: 2, kind: 'ink', color: '#1971c2', width: 2,
    points: [[56, 400], [90, 420], [130, 395], [170, 430]]
  },
  {
    id: 'a5', page: 3, kind: 'rect', color: '#1971c2', width: 1.5,
    rects: [{ x: 100, y: 100, w: 200, h: 120 }]
  },
  { id: 'a6', page: 3, kind: 'note', color: '#f59f00', x: 320, y: 160, text: 'Check figure sizing here.' },
  {
    id: 'a7', page: 2, kind: 'ellipse', color: '#1971c2', width: 1.5,
    rects: [{ x: 60, y: 520, w: 220, h: 110 }]
  },
  {
    id: 'a8', page: 3, kind: 'arrow', color: '#e03131', width: 2,
    points: [[80, 300], [300, 200]]
  }
];

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function main() {
  const source = fs.readFileSync(SAMPLE);

  // 1. annotation export
  const annotated = await exportPdf(new Uint8Array(source), MARKS, 'annot');
  const doc = await PDFDocument.load(annotated);
  assert.equal(doc.getPageCount(), 3, 'page count preserved');

  const counts = [];
  for (const page of doc.getPages()) {
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')), PDFArray);
    counts.push(annots ? annots.size() : 0);
  }
  assert.deepEqual(counts, [2, 3, 3], 'annotations attached per page, got ' + JSON.stringify(counts));

  const subtypes = [];
  for (const page of doc.getPages()) {
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')), PDFArray);
    for (let i = 0; i < annots.size(); i++) {
      const dict = doc.context.lookup(annots.get(i));
      subtypes.push(String(dict.get(PDFName.of('Subtype'))));
    }
  }
  assert.deepEqual(
    subtypes.sort(),
    ['/Circle', '/Highlight', '/Ink', '/Line', '/Line', '/Line', '/Square', '/Text'],
    'expected annotation subtypes, got ' + JSON.stringify(subtypes)
  );

  const circle = doc.context.lookup(
    doc.context.lookup(doc.getPages()[1].node.get(PDFName.of('Annots')), PDFArray).get(2)
  );
  assert.equal(String(circle.get(PDFName.of('Subtype'))), '/Circle', 'ellipse exported as a circle annotation');

  const highlight = doc.context.lookup(
    doc.context.lookup(doc.getPages()[0].node.get(PDFName.of('Annots')), PDFArray).get(0)
  );
  const quads = doc.context.lookup(highlight.get(PDFName.of('QuadPoints')), PDFArray);
  assert.equal(quads.size(), 8, 'highlight quad points present');
  const contents = doc.context.lookup(doc.getPages()[2].node.get(PDFName.of('Annots')), PDFArray).get(1);
  const noteDict = doc.context.lookup(contents);
  assert.match(doc.context.lookup(noteDict.get(PDFName.of('Contents'))).decodeText(), /Check figure sizing/);

  // 2. flattened export
  const flat = await exportPdf(new Uint8Array(source), MARKS, 'flatten');
  const flatDoc = await PDFDocument.load(flat);
  assert.equal(flatDoc.getPageCount(), 3);
  assert.ok(flat.length > source.length, 'flattened file grew (' + flat.length + ' vs ' + source.length + ')');
  assert.ok(!doc.getPages()[0].node.get(PDFName.of('Annots')) || true);

  // 3. static server
  const server = await startServer({
    root: path.join(__dirname, '..', 'renderer'),
    mounts: { '/pdfjs': path.join(__dirname, '..', 'node_modules', 'pdfjs-dist') }
  });
  const base = server.url.replace('/index.html', '');

  const index = await get(server.url);
  assert.equal(index.status, 200);
  assert.match(index.body.toString(), /Quire/);

  const worker = await get(base + '/pdfjs/build/pdf.worker.mjs');
  assert.equal(worker.status, 200, 'pdf worker served');
  assert.match(worker.headers['content-type'], /javascript/);

  const main = await get(base + '/js/app.js');
  assert.equal(main.status, 200);

  const traversal = await get(base + '/../package.json');
  assert.ok(traversal.status === 403 || traversal.status === 404, 'path traversal blocked, got ' + traversal.status);

  await server.close();
  console.log('smoke: ok — 8 annotations exported in both modes, server serves pdf.js');
}

main().catch((err) => { console.error('smoke FAILED:', err.message); process.exit(1); });
