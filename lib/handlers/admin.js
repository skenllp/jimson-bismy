'use strict';
const config = require('../config');
const { query, tx } = require('../db');
const { HttpError, send, readJson, clientIp, assertSameOriginJson } = require('../http');
const { enforce } = require('../ratelimit');
const V = require('../validate');
const S = require('../security');

const EVENTS = ['engagement', 'reception'];
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/* ---------------- auth ---------------- */
async function login(req, res) {
  assertSameOriginJson(req);
  const body = await readJson(req, 2048);
  const ip = clientIp(req);
  await enforce('admin-login', ip, 8, 900, 'Too many sign-in attempts. Please wait 15 minutes.');
  if (!config.adminCode() && !config.staffCode()) throw new config.ConfigError('ADMIN_PASSWORD / STAFF_PASSWORD not set');
  const role = S.roleForCode(String(body.code || ''));
  if (!role) throw new HttpError(401, 'invalid_code', 'That access code is not correct.');
  const name = V.cleanText(String(body.name || ''), { max: 40 }) || (role === 'admin' ? 'Admin' : 'Staff');
  send(res, 200, { ok: true, role, name }, { 'Set-Cookie': S.sessionCookie(req, role, name) });
}
async function logout(req, res) {
  send(res, 200, { ok: true }, { 'Set-Cookie': S.clearCookie(req) });
}
async function me(req, res) {
  const s = S.readSession(req);
  if (!s) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  send(res, 200, { ok: true, role: s.role, name: s.name });
}

/* ---------------- shared row shapes ---------------- */
const rsvpSelect = `
  select r.id, r.booking_reference as reference, r.guest_name as name, r.phone, r.attendance_status as status,
         r.guest_count as guests, r.engagement_selected, r.reception_selected, r.message, r.created_at, r.updated_at,
         coalesce(jsonb_object_agg(c.event_type, jsonb_build_object('at', c.checked_in_at, 'by', c.checked_in_by, 'arrived', c.guests_arrived))
                  filter (where c.id is not null), '{}'::jsonb) as checkins
    from public.rsvps r left join public.checkins c on c.rsvp_id = r.id`;

async function getRsvp(client, where, params) {
  const { rows } = await client.query(`${rsvpSelect} where ${where} group by r.id`, params);
  return rows[0];
}

/* ---------------- stats ---------------- */
async function stats(req, res) {
  S.requireRole(req, 'admin', 'staff');
  const [a, b, c] = await Promise.all([
    query(`select
        count(*)::int as total_rsvps,
        count(*) filter (where attendance_status='attending')::int as confirmed,
        count(*) filter (where attendance_status='declined')::int as declined,
        count(*) filter (where attendance_status='cancelled')::int as cancelled,
        coalesce(sum(guest_count) filter (where attendance_status='attending'),0)::int as expected_guests,
        count(*) filter (where attendance_status='attending' and engagement_selected)::int as engagement_rsvps,
        coalesce(sum(guest_count) filter (where attendance_status='attending' and engagement_selected),0)::int as engagement_guests,
        count(*) filter (where attendance_status='attending' and reception_selected)::int as reception_rsvps,
        coalesce(sum(guest_count) filter (where attendance_status='attending' and reception_selected),0)::int as reception_guests
      from public.rsvps`),
    query(`select c.event_type, count(*)::int as parties, coalesce(sum(c.guests_arrived),0)::int as guests
             from public.checkins c join public.rsvps r on r.id = c.rsvp_id
            where r.attendance_status = 'attending' group by c.event_type`),
    query(`select count(*) filter (where not approved)::int as pending, count(*) filter (where approved)::int as approved,
                  count(*)::int as total, count(*) filter (where is_private)::int as private from public.wishes`)
  ]);
  const s = a.rows[0];
  const ci = { engagement: { parties: 0, guests: 0 }, reception: { parties: 0, guests: 0 } };
  b.rows.forEach(r => { ci[r.event_type] = { parties: r.parties, guests: r.guests }; });
  send(res, 200, {
    rsvps: { total: s.total_rsvps, confirmed: s.confirmed, declined: s.declined, cancelled: s.cancelled },
    expected_guests: s.expected_guests,
    events: {
      engagement: { rsvps: s.engagement_rsvps, expected_guests: s.engagement_guests,
        checked_in_parties: ci.engagement.parties, checked_in_guests: ci.engagement.guests,
        pending_parties: s.engagement_rsvps - ci.engagement.parties },
      reception: { rsvps: s.reception_rsvps, expected_guests: s.reception_guests,
        checked_in_parties: ci.reception.parties, checked_in_guests: ci.reception.guests,
        pending_parties: s.reception_rsvps - ci.reception.parties }
    },
    wishes: c.rows[0]
  });
}

/* ---------------- list / search ---------------- */
async function listRsvps(req, res, { url }) {
  S.requireRole(req, 'admin', 'staff');
  const p = url.searchParams;
  const where = []; const params = [];
  const add = (v) => { params.push(v); return '$' + params.length; };

  const q = (p.get('q') || '').trim().slice(0, 60);
  if (q) {
    const conds = [`r.guest_name ilike ${add('%' + likeEsc(q) + '%')}`, `r.booking_reference ilike ${add('%' + likeEsc(q) + '%')}`];
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 3) conds.push(`r.phone like ${add('%' + digits + '%')}`);
    where.push('(' + conds.join(' or ') + ')');
  }
  const status = p.get('status');
  if (['attending', 'declined', 'cancelled'].includes(status)) where.push(`r.attendance_status = ${add(status)}`);
  const event = p.get('event');
  if (event === 'engagement') where.push(`r.attendance_status='attending' and r.engagement_selected`);
  if (event === 'reception') where.push(`r.attendance_status='attending' and r.reception_selected`);
  const ci = p.get('checkin');
  const m = /^(engagement|reception)_(in|pending)$/.exec(ci || '');
  if (m) {
    const sel = m[1] === 'engagement' ? 'r.engagement_selected' : 'r.reception_selected';
    const ex = `exists (select 1 from public.checkins x where x.rsvp_id = r.id and x.event_type = ${add(m[1])})`;
    where.push(`r.attendance_status='attending'`);
    where.push(m[2] === 'in' ? ex : `${sel} and not ${ex}`);
  }
  const limit = Math.min(Math.max(parseInt(p.get('limit') || '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(p.get('offset') || '0', 10) || 0, 0);
  const w = where.length ? 'where ' + where.join(' and ') : '';

  const total = await query(`select count(*)::int n from public.rsvps r ${w}`, params);
  const { rows } = await query(`${rsvpSelect} ${w} group by r.id order by r.created_at desc limit ${limit} offset ${offset}`, params);
  send(res, 200, { total: total.rows[0].n, rsvps: rows });
}

/* ---------------- edit / delete ---------------- */
async function updateRsvp(req, res, { params }) {
  S.requireRole(req, 'admin');
  assertSameOriginJson(req);
  const body = await readJson(req);
  const id = params.id;
  const existing = await getRsvp({ query }, 'r.id = $1', [id]);
  if (!existing) throw new HttpError(404, 'not_found', 'Reservation not found.');
  const merged = {
    name: body.name ?? existing.name,
    phone: body.phone ?? existing.phone,
    attendance: body.status === 'cancelled' ? 'cancelled' : (body.status ?? existing.status),
    guests: body.guests ?? existing.guests,
    events: body.events ?? (existing.engagement_selected && existing.reception_selected ? 'both' : existing.engagement_selected ? 'engagement' : 'reception'),
    message: body.message ?? existing.message
  };
  let d;
  if (merged.attendance === 'cancelled') {
    const n = V.validateName(merged.name), ph = V.normalizePhone(merged.phone);
    const errors = {}; if (n.error) errors.name = n.error; if (ph.error) errors.phone = ph.error;
    if (Object.keys(errors).length) throw V.invalid(errors);
    d = { guest_name: n.value, phone: ph.value, attendance_status: 'cancelled', guest_count: Number(existing.guests),
          engagement_selected: existing.engagement_selected, reception_selected: existing.reception_selected,
          message: V.cleanText(String(merged.message || ''), { max: 300, multiline: true }) || null };
  } else {
    const v = V.validateRsvp(merged);
    if (v.errors) throw V.invalid(v.errors);
    d = v.value;
  }
  try {
    await query(`update public.rsvps set guest_name=$2, phone=$3, attendance_status=$4, guest_count=$5,
                   engagement_selected=$6, reception_selected=$7, message=$8 where id=$1`,
      [id, d.guest_name, d.phone, d.attendance_status, d.guest_count, d.engagement_selected, d.reception_selected, d.message]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'duplicate', 'Another reservation already uses that phone number.');
    throw e;
  }
  send(res, 200, { ok: true, rsvp: await getRsvp({ query }, 'r.id = $1', [id]) });
}

async function deleteRsvp(req, res, { params }) {
  S.requireRole(req, 'admin');
  const r = await query('delete from public.rsvps where id = $1', [params.id]);
  if (!r.rowCount) throw new HttpError(404, 'not_found', 'Reservation not found.');
  send(res, 200, { ok: true });
}

/* ---------------- check-in ---------------- */
function brief(r) {
  return { id: r.id, reference: r.reference, name: r.name, phone_masked: V.maskPhone(r.phone), status: r.status, guests: r.guests,
           events: { engagement: r.engagement_selected, reception: r.reception_selected }, checkins: r.checkins };
}

async function checkin(req, res) {
  const sess = S.requireRole(req, 'admin', 'staff');
  assertSameOriginJson(req);
  const body = await readJson(req);
  const event = body.event;
  if (!EVENTS.includes(event)) throw new HttpError(422, 'validation_failed', 'Choose Engagement or Reception.');
  await enforce('checkin', sess.name + ':' + clientIp(req), 600, 3600);

  let rsvp;
  if (typeof body.token === 'string' && body.token) {
    if (!S.looksLikeCheckinToken(body.token)) return send(res, 200, { result: 'invalid', message: 'This is not a valid check-in QR code.' });
    rsvp = await getRsvp({ query }, 'r.checkin_token_hash = $1', [S.hashToken(body.token)]);
  } else if (typeof body.rsvp_id === 'string') {
    if (!/^[0-9a-f-]{36}$/i.test(body.rsvp_id)) return send(res, 200, { result: 'invalid', message: 'Guest not found.' });
    rsvp = await getRsvp({ query }, 'r.id = $1', [body.rsvp_id]);
  } else if (typeof body.reference === 'string') {
    const ref = V.normalizeReference(body.reference);
    rsvp = ref ? await getRsvp({ query }, 'r.booking_reference = $1', [ref]) : null;
  }
  if (!rsvp) return send(res, 200, { result: 'invalid', message: 'No reservation matches this code.' });

  if (rsvp.status !== 'attending') {
    return send(res, 200, { result: 'not_attending', guest: brief(rsvp),
      message: rsvp.status === 'cancelled' ? 'This reservation was cancelled.' : 'This guest replied that they cannot attend.' });
  }
  const selected = event === 'engagement' ? rsvp.engagement_selected : rsvp.reception_selected;
  if (!selected && body.force !== true) {
    return send(res, 200, { result: 'not_registered_for_event', guest: brief(rsvp),
      message: `This guest did not RSVP for the ${event}.` });
  }
  let arrived = rsvp.guests;
  if (body.guests_arrived !== undefined) {
    arrived = Number(body.guests_arrived);
    if (!Number.isInteger(arrived) || arrived < 0 || arrived > 20) throw new HttpError(422, 'validation_failed', 'Invalid guest count.');
  }
  const by = `${sess.name} (${sess.role})`.slice(0, 80);
  const ins = await query(
    `insert into public.checkins (rsvp_id, event_type, guests_arrived, checked_in_by) values ($1,$2,$3,$4)
     on conflict (rsvp_id, event_type) do nothing returning checked_in_at`,
    [rsvp.id, event, arrived, by]);
  const fresh = await getRsvp({ query }, 'r.id = $1', [rsvp.id]);
  send(res, 200, { result: ins.rowCount ? 'checked_in' : 'already_checked_in', event, guest: brief(fresh), checkin: fresh.checkins[event] });
}

async function undoCheckin(req, res) {
  S.requireRole(req, 'admin');
  assertSameOriginJson(req);
  const body = await readJson(req);
  if (!EVENTS.includes(body.event) || !/^[0-9a-f-]{36}$/i.test(String(body.rsvp_id))) throw new HttpError(422, 'validation_failed', 'Invalid request.');
  const r = await query('delete from public.checkins where rsvp_id = $1 and event_type = $2', [body.rsvp_id, body.event]);
  send(res, 200, { ok: true, removed: r.rowCount });
}

/* ---------------- wishes moderation ---------------- */
async function listWishes(req, res, { url }) {
  S.requireRole(req, 'admin');
  const st = url.searchParams.get('status');
  const w = st === 'pending' ? 'where not approved' : st === 'approved' ? 'where approved' : '';
  const { rows } = await query(`select id, guest_name as name, message, approved, is_private, created_at from public.wishes ${w} order by created_at desc limit 300`);
  send(res, 200, { wishes: rows });
}
async function moderateWish(req, res, { params }) {
  S.requireRole(req, 'admin');
  assertSameOriginJson(req);
  const body = await readJson(req);
  if (typeof body.approved !== 'boolean') throw new HttpError(422, 'validation_failed', 'approved must be true or false.');
  const r = await query('update public.wishes set approved=$2, moderated_at=now() where id=$1', [params.id, body.approved]);
  if (!r.rowCount) throw new HttpError(404, 'not_found', 'Wish not found.');
  send(res, 200, { ok: true });
}
async function deleteWish(req, res, { params }) {
  S.requireRole(req, 'admin');
  const r = await query('delete from public.wishes where id=$1', [params.id]);
  if (!r.rowCount) throw new HttpError(404, 'not_found', 'Wish not found.');
  send(res, 200, { ok: true });
}

/* ---------------- CSV export ---------------- */
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;           // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function exportCsv(req, res) {
  S.requireRole(req, 'admin');
  const { rows } = await query(`${rsvpSelect} group by r.id order by r.created_at asc`);
  const head = ['Booking reference', 'Guest name', 'Phone', 'Status', 'Guests', 'Engagement', 'Reception',
                'Engagement check-in (IST)', 'Reception check-in (IST)', 'Message', 'Created', 'Updated'];
  const ist = (t) => t ? new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: true }) : '';
  const lines = [head.map(csvCell).join(',')];
  rows.forEach(r => lines.push([
    r.reference, r.name, r.phone, r.status, r.guests,
    r.engagement_selected ? 'Yes' : 'No', r.reception_selected ? 'Yes' : 'No',
    ist(r.checkins.engagement && r.checkins.engagement.at), ist(r.checkins.reception && r.checkins.reception.at),
    r.message || '', ist(r.created_at), ist(r.updated_at)
  ].map(csvCell).join(',')));
  send(res, 200, '﻿' + lines.join('\r\n') + '\r\n', {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="jimson-bismy-guests.csv"'
  });
}

module.exports = { login, logout, me, stats, listRsvps, updateRsvp, deleteRsvp, checkin, undoCheckin, listWishes, moderateWish, deleteWish, exportCsv };
