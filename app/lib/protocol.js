'use strict';
// Protocolo app://solfy : sirve la interfaz (renderer/) y el audio de la biblioteca, con soporte de Range.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { protocol } = require('electron');
const { CSP } = require('./security');

const RENDERER = path.join(__dirname, '..', 'renderer');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
};

function registerPrivileged() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

function notFound() {
  return new Response('No encontrado', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

async function serveFile(file, request) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
    if (!stat.isFile()) return notFound();
  } catch {
    return notFound();
  }
  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const size = stat.size;
  const range = request.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

function install(library) {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'solfy') return notFound();
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);

    if (parts[0] === 'media' && parts.length === 3) {
      let file;
      try {
        file = library.mediaPath(parts[1], parts[2]);
      } catch {
        return notFound();
      }
      return file ? serveFile(file, request) : notFound();
    }

    const rel = parts.length ? parts.join('/') : 'index.html';
    const file = path.resolve(RENDERER, rel);
    if (!file.startsWith(RENDERER + path.sep)) return notFound();
    return serveFile(file, request);
  });
}

module.exports = { registerPrivileged, install };
