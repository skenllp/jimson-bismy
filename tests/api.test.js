'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, startServer, client, sleep, ENV } = require('./helpers');

const PORT = 4311;
let srv, formToken;
const ADMIN_HDR = { 'x-jb-admin': '1' };

test.before(async () => {
  await resetDb();
  srv = await startServer(PORT);
  const t = await client(srv.base).get('/api/token');
  formToken = t.json.token;
  await sleep(2700);                       // form tokens must age a couple of seconds (anti-bot)
});
test.after(() => srv && srv.stop());

const rsvpBody = (o = {}) => ({ name: 'Anna Joseph', phone: '98765 43210', attendance: 'attending', guests: 2, events: 'both', message: 'Excited!', ft: formToken, ...o });

test('health + not exposing anything on unknown routes', async () => {
  const c = client(srv.base);
  assert.equal((await c.get('/api/health')).status, 200);
  assert.equal((await c.get('/api/nope')).status, 404);
  assert.equal((await c.get('/api/rsvp')).status, 405);
});

test('form token: forged and too-fresh tokens are rejected', async () => {
  const c = client(srv.base, '10.1.0.1');
  const fresh = (await c.get('/api/token')).json.token;
  let r = await c.post('/api/wishes', { name: 'Sam', message: 'Congrats!', ft: fresh });
  assert.equal(r.json.error, 'too_fast');
  r = await c.post('/api/wishes', { name: 'Sam', message: 'Congrats!', ft: 'abc.def' });
  assert.equal(r.json.error, 'bad_token');
});

test('CSRF-style requests are refused', async () => {
  const c = client(srv.base, '10.1.0.2');
  let r = await c.post('/api/rsvp', 'name=x', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
  r = await c.post('/api/rsvp', rsvpBody(), { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('RSVP validation (server side)', async () => {
  const c = client(srv.base, '10.2.0.1');
  let r = await c.post('/api/rsvp', { ft: formToken });
  assert.equal(r.status, 422);
  assert.ok(r.json.errors.name && r.json.errors.phone && r.json.errors.attendance);
  r = await c.post('/api/rsvp', rsvpBody({ guests: '', events: '' }));
  assert.ok(r.json.errors.guests && r.json.errors.events);
  r = await c.post('/api/rsvp', rsvpBody({ guests: 11 }));
  assert.ok(r.json.errors.guests);
  r = await c.post('/api/rsvp', rsvpBody({ phone: '12345' }));
  assert.ok(r.json.errors.phone);
  r = await c.post('/api/rsvp', rsvpBody({ name: 'A' }));
  assert.ok(r.json.errors.name);
  r = await c.post('/api/rsvp', rsvpBody({ message: 'visit http://spam.example now' }));
  assert.ok(r.json.errors.message);
  r = await c.post('/api/rsvp', rsvpBody({ name: 'Bob', phone: '98765 43211', attendance: 'declined', guests: '', events: '' }));
  assert.equal(r.status, 201);                 // a decline needs no guests / events
  assert.equal(r.json.reservation.guests, 0);
  assert.equal(r.json.reservation.qr_token, undefined);
});

let created;
test('create RSVP, no duplicate bookings, private data stays private', async () => {
  const c = client(srv.base, '10.2.0.2');
  const r = await c.post('/api/rsvp', rsvpBody({ name: 'Anna Joseph', phone: '+91 91234 56789' }));
  assert.equal(r.status, 201);
  created = r.json.reservation;
  assert.match(created.reference, /^JB-[A-HJ-NP-Z2-9]{6}$/);
  assert.match(created.qr_token, /^JB1:[A-Za-z0-9_-]{43}$/);
  assert.ok(!r.text.includes('9123456789'), 'raw phone must never be returned');
  assert.ok(!created.qr_token.toLowerCase().includes('anna'));      // QR holds no personal data
  const dup = await c.post('/api/rsvp', rsvpBody({ name: 'Someone Else', phone: '09123456789' }));
  assert.equal(dup.status, 409);
  const dup2 = await c.post('/api/rsvp', rsvpBody({ phone: '919123456789' }));
  assert.equal(dup2.status, 409);
});

test('guest can look up, update and cancel — only with proof of ownership', async () => {
  const c = client(srv.base, '10.2.0.3');
  assert.equal((await c.post('/api/rsvp/lookup', { reference: created.reference, phone: '9000000000' })).status, 404);
  assert.equal((await c.post('/api/rsvp/lookup', { reference: 'JB-ZZZZZZ', phone: '9123456789' })).status, 404);
  let r = await c.post('/api/rsvp/lookup', { reference: created.reference.toLowerCase(), phone: '91234 56789' });
  assert.equal(r.status, 200);
  assert.equal(r.json.reservation.name, 'Anna Joseph');
  assert.match(r.json.reservation.phone_masked, /••••/);
  const manage = r.json.reservation.manage_token;
  r = await c.post('/api/rsvp/lookup', { token: manage });
  assert.equal(r.status, 200);
  // The QR token (shown at the door) must NOT open the booking for editing
  assert.equal((await c.post('/api/rsvp/lookup', { token: created.qr_token })).status, 404);
  assert.equal((await c.post('/api/rsvp/update', { token: created.qr_token, ...rsvpBody() })).status, 404);
  // update: engagement only, 3 guests
  r = await c.post('/api/rsvp/update', { token: manage, name: 'Anna Joseph', attendance: 'attending', guests: 3, events: 'engagement', message: '' });
  assert.equal(r.status, 200);
  assert.equal(r.json.reservation.guests, 3);
  assert.deepEqual(r.json.reservation.events, { engagement: true, reception: false });
  assert.equal(r.json.reservation.qr_token, created.qr_token);           // QR stays stable across edits
  r = await c.post('/api/rsvp/update', { token: manage, name: 'Anna Joseph', attendance: 'attending', guests: 3, events: '' });
  assert.equal(r.status, 422);
  // cancel + reactivate
  r = await c.post('/api/rsvp/cancel', { reference: created.reference, phone: '9123456789' });
  assert.equal(r.json.reservation.attendance, 'cancelled');
  assert.equal(r.json.reservation.qr_token, undefined);
  r = await c.post('/api/rsvp/update', { token: manage, name: 'Anna Joseph', attendance: 'attending', guests: 2, events: 'both' });
  assert.equal(r.json.reservation.attendance, 'attending');
});

test('lookup brute-force is rate limited', async () => {
  const c = client(srv.base, '10.9.9.9');
  let last;
  for (let i = 0; i < 17; i++) last = await c.post('/api/rsvp/lookup', { reference: 'JB-AAAAAA', phone: '9000000001' });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('wishes: moderation, privacy, sanitising, duplicates, honeypot', async () => {
  const c = client(srv.base, '10.3.0.1');
  const w = (o) => c.post('/api/wishes', { name: 'Maria', message: 'Wishing you a lifetime of love!', ft: formToken, ...o });
  let r = await w({});
  assert.equal(r.status, 201); assert.equal(r.json.status, 'pending');
  assert.equal((await w({})).json.duplicate, true);                          // repeated click is idempotent
  r = await w({ name: 'Eve', message: '<script>alert(1)</script>Be happy <img src=x onerror=alert(2)>' });
  assert.equal(r.status, 201);
  r = await w({ name: 'Priv', message: 'Only for the couple', private: true });
  assert.equal(r.json.private, true);
  r = await w({ name: 'Bot', message: 'buy stuff', website: 'http://spam' });
  assert.equal(r.status, 200);                                               // looks fine to the bot…
  r = await w({ name: '', message: '' });
  assert.equal(r.status, 422);
  r = await w({ name: 'Spam', message: 'cheap pills at http://x.example and www.y.example' });
  assert.equal(r.status, 422);
  // nothing is public until approved
  assert.equal((await c.get('/api/wishes')).json.wishes.length, 0);
  // admin moderation
  const a = client(srv.base, '10.3.0.2');
  assert.equal((await a.post('/api/admin/login', { code: ENV.ADMIN_PASSWORD }, ADMIN_HDR)).status, 200);
  const list = (await a.get('/api/admin/wishes')).json.wishes;
  assert.equal(list.length, 3);                                              // honeypot wish was never stored
  const eve = list.find(x => x.name === 'Eve');
  assert.ok(!/[<>]/.test(eve.message), 'HTML tags are stripped');
  for (const x of list) assert.equal((await a.patch('/api/admin/wishes/' + x.id, { approved: true }, ADMIN_HDR)).status, 200);
  const pub = (await c.get('/api/wishes')).json.wishes;
  assert.equal(pub.length, 2);                                               // approved but private stays hidden
  assert.ok(!pub.some(x => x.name === 'Priv'));
  assert.equal((await a.patch('/api/admin/wishes/' + eve.id, { approved: false }, ADMIN_HDR)).status, 200);
  assert.equal((await c.get('/api/wishes')).json.wishes.length, 1);
  assert.equal((await a.del('/api/admin/wishes/' + eve.id, ADMIN_HDR)).status, 200);
});

test('admin endpoints require authentication and the right role', async () => {
  const anon = client(srv.base, '10.4.0.1');
  for (const p of ['/api/admin/stats', '/api/admin/rsvps', '/api/admin/wishes', '/api/admin/export.csv', '/api/admin/me']) {
    assert.equal((await anon.get(p)).status, 401, p);
  }
  assert.equal((await anon.post('/api/admin/checkin', { token: 'x', event: 'engagement' }, ADMIN_HDR)).status, 401);
  assert.equal((await anon.post('/api/admin/login', { code: 'wrong-wrong-wrong' }, ADMIN_HDR)).status, 401);

  // forged cookie
  const forged = client(srv.base, '10.4.0.2'); forged.jar.jb_session = encodeURIComponent('eyJyb2xlIjoiYWRtaW4iLCJleHAiOjk5OTk5OTk5OTk5OTl9.AAAA');
  assert.equal((await forged.get('/api/admin/stats')).status, 401);

  const staff = client(srv.base, '10.4.0.3');
  let r = await staff.post('/api/admin/login', { code: ENV.STAFF_PASSWORD, name: 'Raju' }, ADMIN_HDR);
  assert.equal(r.json.role, 'staff');
  assert.equal((await staff.get('/api/admin/stats')).status, 200);
  assert.equal((await staff.get('/api/admin/rsvps')).status, 200);
  assert.equal((await staff.get('/api/admin/wishes')).status, 403);
  assert.equal((await staff.get('/api/admin/export.csv')).status, 403);
  assert.equal((await staff.del('/api/admin/rsvps/00000000-0000-0000-0000-000000000000', ADMIN_HDR)).status, 403);

  const admin = client(srv.base, '10.4.0.4');
  assert.equal((await admin.post('/api/admin/login', { code: ENV.ADMIN_PASSWORD }, ADMIN_HDR)).status, 200);
  // state-changing admin call without the custom header is refused even with a valid cookie
  assert.equal((await admin.patch('/api/admin/rsvps/00000000-0000-0000-0000-000000000000', {})).status, 403);
  const logout = await admin.post('/api/admin/logout', {}, ADMIN_HDR);
  assert.equal(logout.status, 200);
  assert.equal((await admin.get('/api/admin/stats')).status, 401);
  const setCookie = (await client(srv.base, '10.4.0.5').post('/api/admin/login', { code: ENV.ADMIN_PASSWORD }, ADMIN_HDR)).headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
});

test('admin login is rate limited', async () => {
  const c = client(srv.base, '10.5.5.5');
  let last;
  for (let i = 0; i < 10; i++) last = await c.post('/api/admin/login', { code: 'nope-nope-nope' }, ADMIN_HDR);
  assert.equal(last.status, 429);
  assert.equal((await c.post('/api/admin/login', { code: ENV.ADMIN_PASSWORD }, ADMIN_HDR)).status, 429); // even the right code is blocked while locked
});

test('QR check-in: scan, repeat scan, wrong event, cancelled guest, undo, permissions', async () => {
  const guest = client(srv.base, '10.6.0.1');
  const mk = async (name, phone, o) => (await guest.post('/api/rsvp', rsvpBody({ name, phone, ...o }))).json.reservation;
  const both = await mk('Check Both', '9000011111', { guests: 4, events: 'both' });
  const eng = await mk('Check Eng', '9000022222', { guests: 1, events: 'engagement' });
  const cxl = await mk('Check Cancelled', '9000033333', {});
  await guest.post('/api/rsvp/cancel', { reference: cxl.reference, phone: '9000033333' });
  const decl = await mk('Check Declined', '9000044444', { attendance: 'declined' });

  const staff = client(srv.base, '10.6.0.2');
  await staff.post('/api/admin/login', { code: ENV.STAFF_PASSWORD, name: 'Gate One' }, ADMIN_HDR);
  const ci = (b) => staff.post('/api/admin/checkin', b, ADMIN_HDR);

  let r = await ci({ token: both.qr_token, event: 'engagement' });
  assert.equal(r.json.result, 'checked_in');
  assert.equal(r.json.guest.name, 'Check Both');
  assert.equal(r.json.guest.guests, 4);
  assert.match(r.json.checkin.by, /Gate One \(staff\)/);
  assert.ok(r.json.checkin.at);
  r = await ci({ token: both.qr_token, event: 'engagement' });
  assert.equal(r.json.result, 'already_checked_in');
  r = await ci({ token: both.qr_token, event: 'reception' });
  assert.equal(r.json.result, 'checked_in');                                 // separate status per event
  r = await ci({ token: eng.qr_token, event: 'reception' });
  assert.equal(r.json.result, 'not_registered_for_event');
  r = await ci({ token: eng.qr_token, event: 'reception', force: true, guests_arrived: 1 });
  assert.equal(r.json.result, 'checked_in');
  r = await ci({ reference: cxl.reference, event: 'engagement' });
  assert.equal(r.json.result, 'not_attending');
  r = await ci({ reference: decl.reference, event: 'engagement' });
  assert.equal(r.json.result, 'not_attending');
  r = await ci({ token: 'JB1:' + 'A'.repeat(43), event: 'engagement' });
  assert.equal(r.json.result, 'invalid');
  r = await ci({ token: 'garbage', event: 'engagement' });
  assert.equal(r.json.result, 'invalid');
  assert.equal((await ci({ token: both.qr_token, event: 'dinner' })).status, 422);

  // once checked in, the guest can no longer change/cancel online
  const g2 = await guest.post('/api/rsvp/cancel', { reference: both.reference, phone: '9000011111' });
  assert.equal(g2.status, 409);

  // manual check-in by id from search
  const found = (await staff.get('/api/admin/rsvps?q=Check%20Eng')).json.rsvps[0];
  assert.equal(found.name, 'Check Eng');
  assert.ok(found.checkins.reception);
  const byPhone = (await staff.get('/api/admin/rsvps?q=90000 22222'.replace(' ', '%20'))).json.rsvps;
  assert.equal(byPhone.length, 1);
  const byRef = (await staff.get('/api/admin/rsvps?q=' + both.reference.slice(3, 7))).json.rsvps;
  assert.ok(byRef.some(x => x.reference === both.reference));

  // undo is admin-only
  assert.equal((await staff.post('/api/admin/checkin/undo', { rsvp_id: found.id, event: 'reception' }, ADMIN_HDR)).status, 403);
  const admin = client(srv.base, '10.6.0.3');
  await admin.post('/api/admin/login', { code: ENV.ADMIN_PASSWORD }, ADMIN_HDR);
  assert.equal((await admin.post('/api/admin/checkin/undo', { rsvp_id: found.id, event: 'reception' }, ADMIN_HDR)).json.removed, 1);
  r = await ci({ rsvp_id: found.id, event: 'engagement' });
  assert.equal(r.json.result, 'checked_in');

  // filters
  const pend = (await admin.get('/api/admin/rsvps?checkin=reception_pending')).json.rsvps;
  assert.ok(pend.every(x => x.reception_selected && !x.checkins.reception));
  const inn = (await admin.get('/api/admin/rsvps?checkin=engagement_in')).json.rsvps;
  assert.ok(inn.length >= 2 && inn.every(x => x.checkins.engagement));
});

test('stats track attendees per event separately', async () => {
  const admin = client(srv.base, '10.7.0.1');
  await admin.post('/api/admin/login', { code: ENV.ADMIN_PASSWORD }, ADMIN_HDR);
  const s = (await admin.get('/api/admin/stats')).json;
  // Anna(2,both) Check Both(4,both) Check Eng(1,eng) ; Bob declined ; Cancelled ; Declined
  assert.equal(s.rsvps.confirmed, 3);
  assert.equal(s.rsvps.declined, 2);
  assert.equal(s.rsvps.cancelled, 1);
  assert.equal(s.rsvps.total, 6);
  assert.equal(s.expected_guests, 7);
  assert.equal(s.events.engagement.expected_guests, 7);
  assert.equal(s.events.reception.expected_guests, 6);
  assert.equal(s.events.engagement.checked_in_parties, 2);
  assert.equal(s.events.engagement.pending_parties, 1);
  assert.equal(s.events.reception.checked_in_parties, 1);
  assert.equal(s.events.reception.checked_in_guests, 4);
});

test('admin can correct a reservation; CSV export is safe', async () => {
  const admin = client(srv.base, '10.8.0.1');
  await admin.post('/api/admin/login', { code: ENV.ADMIN_PASSWORD }, ADMIN_HDR);
  const list = (await admin.get('/api/admin/rsvps?q=Anna')).json.rsvps;
  const anna = list[0];
  let r = await admin.patch('/api/admin/rsvps/' + anna.id, { guests: 5, message: '=1+1+cmd' }, ADMIN_HDR);
  assert.equal(r.status, 200); assert.equal(r.json.rsvp.guests, 5);
  r = await admin.patch('/api/admin/rsvps/' + anna.id, { guests: 99 }, ADMIN_HDR);
  assert.equal(r.status, 422);
  r = await admin.patch('/api/admin/rsvps/' + anna.id, { phone: '9000011111' }, ADMIN_HDR);
  assert.equal(r.status, 409);
  const csv = await admin.get('/api/admin/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.ok(csv.text.startsWith('﻿Booking reference,Guest name,Phone'));
  assert.ok(csv.text.includes("'=1+1+cmd"), 'formula injection neutralised');
  assert.equal(csv.text.trim().split('\r\n').length, 7);
  // delete
  const d = (await admin.get('/api/admin/rsvps?q=Declined')).json.rsvps[0];
  assert.equal((await admin.del('/api/admin/rsvps/' + d.id, ADMIN_HDR)).status, 200);
});

test('RSVP creation is rate limited per client', async () => {
  const c = client(srv.base, '10.10.10.10');
  let last;
  for (let i = 0; i < 14; i++) last = await c.post('/api/rsvp', rsvpBody({ phone: '98000' + String(10000 + i) }));
  assert.equal(last.status, 429);
});
