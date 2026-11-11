'use strict';
const crypto = require('crypto');
const config = require('../config');
const { query } = require('../db');
const { HttpError, send, readJson, clientIp, assertSameOriginJson, sha256 } = require('../http');
const { enforce } = require('../ratelimit');
const V = require('../validate');
const S = require('../security');

/* What a guest may see about their own booking (phone is always masked). */
async function guestView(row, { withTokens = true } = {}) {
  const { rows } = await query('select event_type, checked_in_at from public.checkins where rsvp_id = $1', [row.id]);
  const checked = { engagement: null, reception: null };
  rows.forEach(c => { checked[c.event_type] = c.checked_in_at; });
  const out = {
    reference: row.booking_reference,
    name: row.guest_name,
    phone_masked: V.maskPhone(row.phone),
    attendance: row.attendance_status,
    guests: row.guest_count,
    events: { engagement: row.engagement_selected, reception: row.reception_selected },
    message: row.message || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    checked_in: checked
  };
  if (withTokens) {
    out.manage_token = S.manageToken(row);
    if (row.attendance_status === 'attending') out.qr_token = S.checkinToken(row);
  }
  return out;
}

async function preamble(req, bucket, limit, windowSec) {
  assertSameOriginJson(req);
  const body = await readJson(req);
  await enforce(bucket, clientIp(req), limit, windowSec);
  return body;
}

/* ---------------- GET /api/token ---------------- */
async function token(req, res) {
  send(res, 200, { token: S.issueFormToken() });
}

/* ---------------- GET /api/wishes ---------------- */
async function listWishes(req, res) {
  const { rows } = await query(
    `select guest_name as name, message, created_at from public.wishes
      where approved and not is_private order by created_at desc limit 60`);
  send(res, 200, { wishes: rows }, { 'Cache-Control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=60' });
}

/* ---------------- POST /api/wishes ---------------- */
async function createWish(req, res) {
  const body = await preamble(req, 'wish', 10, 3600);
  if (body.website) return send(res, 200, { ok: true, status: 'pending' });   // honeypot: look successful, store nothing
  S.assertFormToken(body.ft);
  const v = V.validateWish(body);
  if (v.errors) throw V.invalid(v.errors);
  const w = v.value;
  const dedupe = sha256(`${w.guest_name.toLowerCase()}|${w.message.toLowerCase().replace(/\s+/g, ' ')}`);
  const approved = config.wishesAutoApprove() && !w.is_private;
  const r = await query(
    `insert into public.wishes (guest_name, message, approved, is_private, dedupe_hash)
     values ($1,$2,$3,$4,$5) on conflict (dedupe_hash) do nothing returning id`,
    [w.guest_name, w.message, approved, w.is_private, dedupe]);
  // A repeated click / replay hits the unique hash and is treated as success (idempotent).
  send(res, 201, { ok: true, status: approved ? 'published' : 'pending', duplicate: r.rowCount === 0, private: w.is_private });
}

/* ---------------- POST /api/rsvp ---------------- */
async function createRsvp(req, res) {
  const body = await preamble(req, 'rsvp-create', 12, 3600);
  if (body.website) return send(res, 200, { ok: true });
  S.assertFormToken(body.ft);
  const v = V.validateRsvp(body);
  if (v.errors) throw V.invalid(v.errors);
  const d = v.value;

  for (let attempt = 0; attempt < 6; attempt++) {
    const row = { id: crypto.randomUUID(), token_version: 1, booking_reference: S.newReference() };
    const hash = S.hashToken(S.checkinToken(row));
    try {
      const { rows } = await query(
        `insert into public.rsvps (id, guest_name, phone, attendance_status, guest_count, engagement_selected, reception_selected,
                                   message, booking_reference, checkin_token_hash, token_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1) returning *`,
        [row.id, d.guest_name, d.phone, d.attendance_status, d.guest_count, d.engagement_selected, d.reception_selected,
         d.message, row.booking_reference, hash]);
      return send(res, 201, { ok: true, reservation: await guestView(rows[0]) });
    } catch (e) {
      if (e.code === '23505') {
        if (e.constraint === 'rsvps_phone_key') {
          throw new HttpError(409, 'duplicate', 'A reservation already exists for this phone number. Use “Already reserved? Find my reservation” to view, update or cancel it.');
        }
        continue; // reference collision: try another one
      }
      throw e;
    }
  }
  throw new HttpError(500, 'reference_failed', 'Could not create your reservation. Please try again.');
}

/* ---- guest authentication: confirmation-link token OR booking reference + phone ---- */
async function findGuest(req, body) {
  const generic = new HttpError(404, 'not_found', 'We couldn’t find a reservation matching those details.');
  let ref, phone, token;
  if (typeof body.token === 'string' && body.token) {
    token = body.token.trim();
    ref = V.normalizeReference(token.split('.')[0]);
  } else {
    ref = V.normalizeReference(body.reference);
    const p = V.normalizePhone(body.phone);
    phone = p.value;
  }
  await enforce('guest-ip', clientIp(req), 40, 900);
  if (!ref || (!token && !phone)) { await enforce('guest-bad', clientIp(req), 15, 900); throw generic; }
  await enforce('guest-ref', ref, 12, 900);     // blocks guessing the phone for a known reference
  const { rows } = await query('select * from public.rsvps where booking_reference = $1', [ref]);
  const row = rows[0];
  const ok = row && (token ? S.verifyManageToken(token, row) : row.phone === phone);
  if (!ok) { await enforce('guest-bad', clientIp(req), 15, 900); throw generic; }
  return row;
}

/* ---------------- POST /api/rsvp/lookup ---------------- */
async function lookupRsvp(req, res) {
  assertSameOriginJson(req);
  const body = await readJson(req);
  if (body.website) throw new HttpError(404, 'not_found', 'We couldn’t find a reservation matching those details.');
  const row = await findGuest(req, body);
  send(res, 200, { ok: true, reservation: await guestView(row) });
}

async function assertEditable(row) {
  const { rowCount } = await query('select 1 from public.checkins where rsvp_id = $1 limit 1', [row.id]);
  if (rowCount) throw new HttpError(409, 'already_checked_in', 'You have already checked in, so this reservation can no longer be changed online. Please speak to the hosts.');
}

/* ---------------- POST /api/rsvp/update ---------------- */
async function updateRsvp(req, res) {
  assertSameOriginJson(req);
  const body = await readJson(req);
  const row = await findGuest(req, body);
  await assertEditable(row);
  const v = V.validateRsvp(body, { requirePhone: false });
  if (v.errors) throw V.invalid(v.errors);
  const d = v.value;
  const { rows } = await query(
    `update public.rsvps set guest_name=$2, attendance_status=$3, guest_count=$4, engagement_selected=$5,
            reception_selected=$6, message=$7 where id=$1 returning *`,
    [row.id, d.guest_name, d.attendance_status, d.guest_count, d.engagement_selected, d.reception_selected, d.message]);
  send(res, 200, { ok: true, reservation: await guestView(rows[0]) });
}

/* ---------------- POST /api/rsvp/cancel ---------------- */
async function cancelRsvp(req, res) {
  assertSameOriginJson(req);
  const body = await readJson(req);
  const row = await findGuest(req, body);
  await assertEditable(row);
  const { rows } = await query(
    `update public.rsvps set attendance_status='cancelled' where id=$1 returning *`, [row.id]);
  send(res, 200, { ok: true, reservation: await guestView(rows[0]) });
}

async function health(req, res) {
  await query('select 1');
  send(res, 200, { ok: true });
}

module.exports = { token, listWishes, createWish, createRsvp, lookupRsvp, updateRsvp, cancelRsvp, health };
