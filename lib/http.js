'use strict';
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status; this.code = code; this.extra = extra || {};
  }
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(payload);
}

async function readJson(req, limit = 16 * 1024) {
  if (req.body !== undefined && req.body !== null && !(req.body instanceof Uint8Array && req.body.length === 0)) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)); }
    catch { throw new HttpError(400, 'bad_json', 'Invalid request body.'); }
  }
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request too large.');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'bad_json', 'Invalid request body.'); }
}

function clientIp(req) {
  const h = req.headers;
  const ip = (h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || 'unknown').trim();
  return ip || 'unknown';
}

function isHttps(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!(req.socket && req.socket.encrypted);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

/* Reject cross-site writes: JSON content-type is mandatory (a plain HTML <form> cannot send it)
   and, when the browser sends an Origin header, it must match this site. */
function assertSameOriginJson(req) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Expected JSON.');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { throw new HttpError(403, 'bad_origin', 'Forbidden.'); }
    const mine = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (host !== mine) throw new HttpError(403, 'bad_origin', 'Forbidden.');
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { HttpError, send, readJson, clientIp, isHttps, parseCookies, assertSameOriginJson, sha256 };
