#!/usr/bin/env node
/* Local development / preview server:  npm run dev
   Serves ./public and mounts the same /api handler that Vercel runs in production.
   (On Vercel this file is not used.) */
const http = require('http');
const fs = require('fs');
const path = require('path');
try { require('node:process').loadEnvFile?.('.env'); } catch { /* no .env file: use real environment */ }

const api = require('./api/[...path].js');
const ROOT = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain'
};

function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.statusCode = 400; return res.end('Bad request'); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || path.basename(file).startsWith('.')) { res.statusCode = 403; return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (!err && st.isDirectory()) { res.statusCode = 301; res.setHeader('Location', p + '/'); return res.end(); }
      res.statusCode = 404; return res.end('Not found');
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (p.startsWith('/admin')) { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'no-store'); }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {                                   // video/audio need byte-range support
      let start = range[1] ? parseInt(range[1], 10) : 0;
      let end = range[2] ? parseInt(range[2], 10) : st.size - 1;
      if (!range[1] && range[2]) { start = Math.max(0, st.size - parseInt(range[2], 10)); end = st.size - 1; }
      if (start > end || start >= st.size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${st.size}`); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
      res.setHeader('Content-Length', end - start + 1);
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.setHeader('Content-Length', st.size);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url === '/api') return api(req, res);
  serveStatic(req, res);
});
const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => console.log(`Jimson & Bismy invitation running at http://localhost:${PORT}`));
