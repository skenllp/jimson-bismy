'use strict';
const crypto = require('crypto');
const config = require('./config');
const { HttpError, isHttps, parseCookies, sha256 } = require('./http');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/* ---- keyed derivation ----
   Every secret the site hands out is an HMAC of server-side data under APP_SECRET with a distinct label,
   so a token for one purpose can never be replayed for another. */
function hmac(label, data) {
  const key = crypto.createHmac('sha256', config.appSecret()).update('jb-key:' + label).digest();
  return crypto.createHmac('sha256', key).update(data).digest();
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* QR check-in token: opaque, contains NO personal data. Only its hash is stored in the database. */
function checkinToken(rsvp) {
  return 'JB1:' + b64u(hmac('checkin', `${rsvp.id}:${rsvp.token_version}`));
}
function hashToken(token) { return sha256('jb-checkin:' + String(token).trim()); }
function looksLikeCheckinToken(t) { return typeof t === 'string' && /^JB1:[A-Za-z0-9_-]{43}$/.test(t.trim()); }

/* Guest "manage my RSVP" token (confirmation link). Different label => the QR shown at the door cannot edit or cancel a booking. */
function manageToken(rsvp) {
  return rsvp.booking_reference + '.' + b64u(hmac('manage', `${rsvp.id}:${rsvp.token_version}`)).slice(0, 32);
}
function verifyManageToken(token, rsvp) {
  return typeof token === 'string' && safeEqual(token, manageToken(rsvp));
}

/* ---- anti-bot form token: timestamp + signature, must be at least a few seconds old ---- */
function issueFormToken() {
  const ts = Date.now().toString(36);
  return ts + '.' + b64u(hmac('form', ts)).slice(0, 22);
}
function assertFormToken(token, { minAgeMs = 2500, maxAgeMs = 6 * 3600 * 1000 } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) throw new HttpError(400, 'bad_token', 'Please reload the page and try again.');
  const [ts, sig] = token.split('.');
  const expect = b64u(hmac('form', ts)).slice(0, 22);
  if (!safeEqual(sig, expect)) throw new HttpError(400, 'bad_token', 'Please reload the page and try again.');
  const age = Date.now() - parseInt(ts, 36);
  if (!(age >= minAgeMs)) throw new HttpError(400, 'too_fast', 'Please take a moment, then try again.');
  if (age > maxAgeMs) throw new HttpError(400, 'bad_token', 'This page has been open a while — please reload and try again.');
}

/* ---- booking reference ---- */
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newReference() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[bytes[i] % 32];
  return 'JB-' + s;
}

/* ---- admin / staff sessions (signed, HttpOnly cookie; nothing stored in the browser's JS) ---- */
const COOKIE = 'jb_session';
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + b64u(hmac('session', body));
}
function readSession(req) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const [body, sig] = raw.split('.');
  if (!safeEqual(sig, b64u(hmac('session', body)))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    if (p.role !== 'admin' && p.role !== 'staff') return null;
    return p;
  } catch { return null; }
}
function sessionCookie(req, role, name) {
  const maxAge = config.sessionHours * 3600;
  const value = sign({ role, name, exp: Date.now() + maxAge * 1000, n: b64u(crypto.randomBytes(6)) });
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
function clearCookie(req) {
  return `${COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
}
/** Constant-time check of an access code against the configured admin / staff codes. */
function roleForCode(code) {
  if (typeof code !== 'string' || !code) return null;
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  const given = digest(code);
  const admin = config.adminCode(); const staff = config.staffCode();
  let role = null;
  if (admin && crypto.timingSafeEqual(given, digest(admin))) role = 'admin';
  else if (staff && crypto.timingSafeEqual(given, digest(staff))) role = 'staff';
  return role;
}

function requireRole(req, ...roles) {
  const s = readSession(req);
  if (!s) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  if (!roles.includes(s.role)) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  // state-changing admin calls must carry the custom header (a cross-site page cannot set it)
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-jb-admin'] !== '1') throw new HttpError(403, 'forbidden', 'Forbidden.');
  return s;
}

module.exports = {
  checkinToken, hashToken, looksLikeCheckinToken, manageToken, verifyManageToken,
  issueFormToken, assertFormToken, newReference,
  readSession, sessionCookie, clearCookie, roleForCode, requireRole
};
