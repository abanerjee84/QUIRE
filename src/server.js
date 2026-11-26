'use strict';

/**
 * Tiny static file server so the renderer runs on an http:// origin.
 * pdf.js spawns a module worker; Chromium refuses workers on file://, so the
 * UI is served over 127.0.0.1 instead of loaded from disk.
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

/** Files a Markdown document may embed. */
const EMBEDDABLE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

/**
 * @param {{root: string, mounts: Record<string,string>}} opts
 *   root      directory served at /
 *   mounts    url prefix -> absolute directory (e.g. '/pdfjs' -> node_modules/pdfjs-dist)
 * @returns {Promise<{server: http.Server, url: string, close: () => Promise<void>}>}
 */
async function startServer({ root, mounts }) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);

    // /local?path=<absolute file>: lets a Markdown page embed images from disk
    if (rel === '/local') {
      const wanted = url.searchParams.get('path');
      if (!wanted || !EMBEDDABLE.test(wanted)) {
        res.writeHead(400).end('path must be an image file');
        return;
      }
      try {
        const body = await fsp.readFile(wanted);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(wanted).toLowerCase()] || 'application/octet-stream',
          'Content-Length': body.length,
          'Cache-Control': 'no-store'
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch (err) {
        res.writeHead(404).end('Not found: ' + wanted);
      }
      return;
    }

    let base = root;
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (rel === prefix || rel.startsWith(prefix + '/')) {
        base = dir;
        rel = rel.slice(prefix.length) || '/';
        break;
      }
    }

    let target = path.normalize(path.join(base, rel === '/' ? 'index.html' : rel));
    // never escape the served directory
    if (!target.startsWith(path.normalize(base))) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const stat = await fsp.stat(target);
      if (stat.isDirectory()) target = path.join(target, 'index.html');
      const body = await fsp.readFile(target);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404).end('Not found: ' + rel);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}/index.html`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { startServer };
