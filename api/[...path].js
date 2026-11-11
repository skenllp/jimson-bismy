'use strict';
/* Single serverless entry point for every /api/* route (Vercel: api/[...path].js).
   The same handler is mounted by server.js for local development and tests. */
const { HttpError, send } = require('../lib/http');
const { ConfigError } = require('../lib/config');
const pub = require('../lib/handlers/public');
const admin = require('../lib/handlers/admin');

const ID = '([0-9a-fA-F-]{36})';
const routes = [
  ['GET',    /^\/api\/health$/,                 pub.health],
  ['GET',    /^\/api\/token$/,                  pub.token],
  ['GET',    /^\/api\/wishes$/,                 pub.listWishes],
  ['POST',   /^\/api\/wishes$/,                 pub.createWish],
  ['POST',   /^\/api\/rsvp$/,                   pub.createRsvp],
  ['POST',   /^\/api\/rsvp\/lookup$/,           pub.lookupRsvp],
  ['POST',   /^\/api\/rsvp\/update$/,           pub.updateRsvp],
  ['POST',   /^\/api\/rsvp\/cancel$/,           pub.cancelRsvp],

  ['POST',   /^\/api\/admin\/login$/,           admin.login],
  ['POST',   /^\/api\/admin\/logout$/,          admin.logout],
  ['GET',    /^\/api\/admin\/me$/,              admin.me],
  ['GET',    /^\/api\/admin\/stats$/,           admin.stats],
  ['GET',    /^\/api\/admin\/rsvps$/,           admin.listRsvps],
  ['PATCH',  new RegExp(`^/api/admin/rsvps/${ID}$`), admin.updateRsvp],
  ['DELETE', new RegExp(`^/api/admin/rsvps/${ID}$`), admin.deleteRsvp],
  ['POST',   /^\/api\/admin\/checkin$/,         admin.checkin],
  ['POST',   /^\/api\/admin\/checkin\/undo$/,   admin.undoCheckin],
  ['GET',    /^\/api\/admin\/wishes$/,          admin.listWishes],
  ['PATCH',  new RegExp(`^/api/admin/wishes/${ID}$`), admin.moderateWish],
  ['DELETE', new RegExp(`^/api/admin/wishes/${ID}$`), admin.deleteWish],
  ['GET',    /^\/api\/admin\/export\.csv$/,     admin.exportCsv]
];

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let pathMatched = false;
    for (const [method, re, fn] of routes) {
      const m = re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (method !== req.method) continue;
      return await fn(req, res, { url, params: { id: m[1] } });
    }
    if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    throw new HttpError(404, 'not_found', 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) {
      const headers = e.extra && e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {};
      return send(res, e.status, { error: e.code, message: e.message, ...(e.extra && e.extra.errors ? { errors: e.extra.errors } : {}) }, headers);
    }
    if (e instanceof ConfigError) {
      console.error('[config]', e.message);
      return send(res, 503, { error: 'not_configured', message: 'The service is not configured yet.' });
    }
    console.error('[api] unexpected error:', e && e.code ? e.code + ' ' : '', e && e.message);
    return send(res, 500, { error: 'server_error', message: 'Something went wrong. Please try again in a moment.' });
  }
};
