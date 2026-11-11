'use strict';
const { HttpError } = require('./http');

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g;
const TAGS = /<\/?[a-zA-Z!?][^>]*>?/g;
const URLS = /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|io|ru|xyz|info|biz|top|click)\b)/gi;

/** Strip control/bidi characters and HTML tags, normalise whitespace. Output is plain text; the UI also renders it with textContent. */
function cleanText(input, { max, multiline = false } = {}) {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFC').replace(CONTROL, '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  s = s.replace(TAGS, '');
  if (multiline) s = s.replace(/[ ]{2,}/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  else s = s.replace(/\s+/g, ' ');
  s = s.trim();
  if (max && s.length > max) s = s.slice(0, max).trim();
  return s;
}

function tooManyLinks(s, allowed = 0) {
  const m = s.match(URLS);
  return !!m && m.length > allowed;
}

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'’\-]*$/u;

function validateName(raw, { min = 2, max = 80 } = {}) {
  const name = cleanText(raw, { max: max + 20 });
  if (name.length < min) return { error: 'Please enter your full name.' };
  if (name.length > max) return { error: `Name must be ${max} characters or fewer.` };
  if (!NAME_RE.test(name)) return { error: 'Names can include letters, spaces, apostrophes, dots and hyphens only.' };
  if (tooManyLinks(name)) return { error: 'Please enter a name, not a link.' };
  return { value: name };
}

/** Returns "+<digits>" or an error. A bare 10-digit number is assumed to be Indian (+91). */
function normalizePhone(raw) {
  if (typeof raw !== 'string') return { error: 'Please enter your phone number.' };
  let s = raw.trim();
  if (!s) return { error: 'Please enter your phone number.' };
  if (!/^[+\d][\d\s().\-]*$/.test(s)) return { error: 'Phone numbers can contain digits, spaces and + only.' };
  const hadPlus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!hadPlus && d.startsWith('00')) d = d.slice(2);
  else if (!hadPlus && d.length === 11 && d.startsWith('0')) d = d.slice(1);       // 0 98765 43210
  if (!hadPlus && d.length === 10) d = '91' + d;
  if (d.length < 8 || d.length > 15) return { error: 'Please enter a valid phone number (with country code if outside India).' };
  if (d.startsWith('91') && d.length === 12 && !/^[6-9]/.test(d.slice(2))) return { error: 'Please check the phone number — Indian mobile numbers start with 6, 7, 8 or 9.' };
  return { value: '+' + d };
}

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 5) return '••••';
  return '+' + d.slice(0, d.length > 10 ? d.length - 10 : 2) + ' ••••• ' + d.slice(-3);
}

const REF_RE = /^JB-[A-HJ-NP-Z2-9]{6}$/;
function normalizeReference(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (/^JB[A-Z0-9]{6}$/.test(s)) s = 'JB-' + s.slice(2);
  return REF_RE.test(s) ? s : null;
}

/** Shared by create + update. Returns { value } or { errors: {field: msg} } */
function validateRsvp(body, { requirePhone = true } = {}) {
  const errors = {};
  const out = {};

  const n = validateName(body.name);
  if (n.error) errors.name = n.error; else out.guest_name = n.value;

  if (requirePhone) {
    const p = normalizePhone(body.phone);
    if (p.error) errors.phone = p.error; else out.phone = p.value;
  }

  const attendance = body.attendance;
  if (attendance !== 'attending' && attendance !== 'declined') {
    errors.attendance = 'Please tell us whether you will attend.';
  } else {
    out.attendance_status = attendance;
    if (attendance === 'attending') {
      const g = Number(body.guests);
      if (!Number.isInteger(g) || g < 1 || g > 10) errors.guests = 'Please choose the number of guests (1–10).';
      else out.guest_count = g;
      const ev = body.events;
      if (!['engagement', 'reception', 'both'].includes(ev)) errors.events = 'Please choose which event(s) you will attend.';
      else {
        out.engagement_selected = ev === 'engagement' || ev === 'both';
        out.reception_selected = ev === 'reception' || ev === 'both';
      }
    } else {
      out.guest_count = 0; out.engagement_selected = false; out.reception_selected = false;
    }
  }

  const msg = cleanText(typeof body.message === 'string' ? body.message : '', { max: 300, multiline: true });
  if (tooManyLinks(msg)) errors.message = 'Please leave links out of your message.';
  out.message = msg || null;

  return Object.keys(errors).length ? { errors } : { value: out };
}

function validateWish(body) {
  const errors = {}; const out = {};
  const n = validateName(body.name, { min: 1, max: 60 });
  if (n.error) errors.name = n.error.replace('full name', 'name'); else out.guest_name = n.value;
  const msg = cleanText(typeof body.message === 'string' ? body.message : '', { max: 500, multiline: true });
  if (!msg) errors.message = 'Please write your wishes.';
  else if (msg.length < 2) errors.message = 'Your wishes are a little short.';
  else if (tooManyLinks(msg)) errors.message = 'Please leave links out of your wishes.';
  else out.message = msg;
  out.is_private = body.private === true || body.private === 'true';
  return Object.keys(errors).length ? { errors } : { value: out };
}

function invalid(errors) {
  return new HttpError(422, 'validation_failed', 'Please check the highlighted fields.', { errors });
}

module.exports = { cleanText, validateName, normalizePhone, maskPhone, normalizeReference, validateRsvp, validateWish, invalid, tooManyLinks };
