/* Guest Desk — admin & check-in dashboard.
   Authentication is a server-signed HttpOnly cookie; this file contains no credentials.
   Every action is re-authorised on the server, so hiding a button here is only cosmetic. */
(function () {
  'use strict';

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* DOM builder — text is always set via textContent (no innerHTML anywhere in this file) */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(c => { if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  }

  let me = null;
  let currentEvent = 'engagement';
  try { currentEvent = sessionStorage.getItem('jb_event') || 'engagement'; } catch (e) {}
  const EVENT_NAME = { engagement: 'Engagement', reception: 'Reception' };

  /* ---------------- API ---------------- */
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-JB-Admin': '1' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) { return { ok: false, status: 0, data: { message: 'Network error. Check your connection.' } }; }
    let data = {}; try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && me) { me = null; showLogin('Your session has ended. Please sign in again.'); }
    return { ok: res.ok, status: res.status, data };
  }

  function toast(text) {
    const t = $('#toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600);
  }
  const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }); } catch (e) { return ''; } };
  const fmtDate = (ts) => { try { return new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }); } catch (e) { return ''; } };
  function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

  /* ---------------- login / session ---------------- */
  function showLogin(msg) {
    stopScanner();
    $('#appView').hidden = true; $('#loginView').hidden = false;
    $('#loginMsg').textContent = msg || '';
    $('#loginCode').value = '';
  }
  async function showApp() {
    $('#loginView').hidden = true; $('#appView').hidden = false;
    document.body.classList.toggle('admin-hidden', me.role !== 'admin');
    $('#whoChip').textContent = me.name + ' · ' + me.role;
    switchTab('checkin');
  }
  async function init() {
    const r = await api('GET', '/api/admin/me');
    if (r.ok) { me = r.data; showApp(); } else showLogin('');
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn'); btn.disabled = true; $('#loginMsg').textContent = '';
    const r = await api('POST', '/api/admin/login', { code: $('#loginCode').value, name: $('#loginName').value });
    btn.disabled = false;
    if (r.ok) { me = r.data; $('#loginCode').value = ''; showApp(); }
    else $('#loginMsg').textContent = r.data.message || 'Could not sign in.';
  });
  $('#logoutBtn').addEventListener('click', async () => { await api('POST', '/api/admin/logout', {}); me = null; showLogin(''); });

  /* ---------------- tabs ---------------- */
  function switchTab(name) {
    if (name === 'wishes' && me.role !== 'admin') name = 'checkin';
    $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.panel').forEach(p => { p.hidden = p.id !== 'tab-' + name; });
    if (name !== 'checkin') stopScanner();
    if (name === 'checkin') loadProgress();
    if (name === 'guests') loadGuests(true);
    if (name === 'overview') loadOverview();
    if (name === 'wishes') loadWishes();
  }
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  /* ---------------- guest cards (shared) ---------------- */
  function statusBadge(r) {
    if (r.status === 'attending') return h('span', { class: 'badge ok' }, 'Attending');
    if (r.status === 'declined') return h('span', { class: 'badge mute' }, 'Declined');
    return h('span', { class: 'badge bad' }, 'Cancelled');
  }
  function evText(r) {
    return [r.engagement_selected && 'Engagement', r.reception_selected && 'Reception'].filter(Boolean).join(' + ') || '—';
  }

  function guestCard(r, opts) {
    const o = opts || {};
    const attending = r.status === 'attending';
    const badges = h('div', { class: 'badges' }, statusBadge(r));
    ['engagement', 'reception'].forEach(ev => {
      const c = r.checkins && r.checkins[ev];
      const selected = ev === 'engagement' ? r.engagement_selected : r.reception_selected;
      if (c) badges.append(h('span', { class: 'badge ok' }, '✓ ' + EVENT_NAME[ev] + ' ' + fmtTime(c.at)));
      else if (attending && selected) badges.append(h('span', { class: 'badge warn' }, EVENT_NAME[ev] + ' pending'));
    });

    const actions = h('div', { class: 'g-actions' });
    if (attending) {
      (o.events || ['engagement', 'reception']).forEach(ev => {
        const c = r.checkins && r.checkins[ev];
        if (c) {
          if (me.role === 'admin') actions.append(h('button', { class: 'btn small ghost', type: 'button', onclick: () => undo(r, ev, o.refresh) }, 'Undo ' + EVENT_NAME[ev]));
        } else {
          actions.append(h('button', { class: 'btn small primary', type: 'button', onclick: () => doCheckin({ rsvp_id: r.id, event: ev }, o.refresh) }, 'Check in · ' + EVENT_NAME[ev]));
        }
      });
    }
    if (me.role === 'admin' && !o.compact) {
      actions.append(h('button', { class: 'btn small ghost', type: 'button', onclick: () => openEdit(r) }, 'Edit'));
      actions.append(h('button', { class: 'btn small danger', type: 'button', onclick: () => removeRsvp(r, o.refresh) }, 'Delete'));
    }

    return h('article', { class: 'g-card' },
      h('div', { class: 'g-top' }, h('div', { class: 'g-name' }, r.name), h('div', { class: 'g-ref' }, r.reference)),
      h('div', { class: 'g-meta' },
        attending ? `${r.guests} ${r.guests === 1 ? 'guest' : 'guests'} · ${evText(r)}` : 'Not attending',
        h('br'), r.phone),
      r.message ? h('p', { class: 'g-msg' }, '“' + r.message + '”') : null,
      badges, actions);
  }

  async function undo(r, ev, refresh) {
    if (!confirm(`Remove the ${EVENT_NAME[ev]} check-in for ${r.name}?`)) return;
    const res = await api('POST', '/api/admin/checkin/undo', { rsvp_id: r.id, event: ev });
    toast(res.ok ? 'Check-in removed' : (res.data.message || 'Could not undo'));
    if (refresh) refresh(); loadProgress();
  }
  async function removeRsvp(r, refresh) {
    if (!confirm(`Delete ${r.name}'s reservation permanently?`)) return;
    const res = await api('DELETE', '/api/admin/rsvps/' + r.id);
    toast(res.ok ? 'Reservation deleted' : (res.data.message || 'Could not delete'));
    if (refresh) refresh();
  }

  /* ---------------- check-in ---------------- */
  function setEvent(ev) {
    currentEvent = ev;
    try { sessionStorage.setItem('jb_event', ev); } catch (e) {}
    $$('.seg-btn[data-event]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.event === ev)));
    loadProgress();
    if ($('#quickQ').value.trim()) runQuick();
  }
  $$('.seg-btn[data-event]').forEach(b => b.addEventListener('click', () => setEvent(b.dataset.event)));
  setEvent(currentEvent);

  async function loadProgress() {
    if (!me) return;
    const r = await api('GET', '/api/admin/stats');
    const box = $('#eventProgress');
    if (!r.ok) { box.textContent = ''; return; }
    const e = r.data.events[currentEvent];
    box.textContent = '';
    box.append(h('b', {}, `${e.checked_in_parties} / ${e.rsvps}`), ' parties in · ',
               h('b', {}, `${e.checked_in_guests} / ${e.expected_guests}`), ' guests');
  }

  const resultBox = $('#scanResult');
  function showResult(kind, title, sub, meta, extra) {
    resultBox.className = 'result ' + kind; resultBox.hidden = false; resultBox.textContent = '';
    [h('p', { class: 'r-title' }, title), sub ? h('p', { class: 'r-sub' }, sub) : null, meta ? h('div', { class: 'r-meta' }, meta) : null, extra || null].filter(Boolean).forEach(n => resultBox.append(n));
    resultBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  let checking = false;
  async function doCheckin(payload, refresh) {
    if (checking) return;
    checking = true;
    const body = { event: currentEvent, ...payload };
    const r = await api('POST', '/api/admin/checkin', body);
    checking = false;
    if (!r.ok) { showResult('bad', 'Could not check in', r.data.message || 'Please try again.'); buzz([200]); return; }
    const d = r.data; const g = d.guest;
    const meta = g ? `${g.guests} ${g.guests === 1 ? 'guest' : 'guests'} · ${g.reference}` : '';
    if (d.result === 'checked_in') {
      showResult('ok', '✓ Checked in', g.name, `${EVENT_NAME[d.event]} · ${meta}`); buzz([70]);
      loadProgress(); if (refresh) refresh();
    } else if (d.result === 'already_checked_in') {
      showResult('warn', 'Already checked in', g.name, `${fmtTime(d.checkin.at)} by ${d.checkin.by} · ${meta}`); buzz([60, 60, 60]);
      if (refresh) refresh();
    } else if (d.result === 'not_registered_for_event') {
      showResult('warn', `Not registered for ${EVENT_NAME[currentEvent]}`, g.name, meta,
        h('button', { class: 'btn small', type: 'button', onclick: () => doCheckin({ ...payload, force: true }, refresh) }, 'Check in anyway'));
      buzz([60, 60, 60]);
    } else if (d.result === 'not_attending') {
      showResult('bad', 'Not attending', g ? g.name : '', d.message); buzz([200]);
    } else {
      showResult('bad', 'Invalid code', d.message || 'No reservation matches.'); buzz([200]);
    }
  }

  /* ---- camera QR scanner (BarcodeDetector where available, jsQR fallback for iOS Safari etc.) ---- */
  const video = $('#scanVideo'), canvas = $('#scanCanvas'), scanStatus = $('#scanStatus'), scanBtn = $('#scanToggle');
  let stream = null, scanning = false, detector = null, jsqrReady = null, lastCode = '', lastAt = 0;

  function loadJsQr() {
    if (window.jsQR) return Promise.resolve();
    if (!jsqrReady) jsqrReady = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = '../vendor/jsQR.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
    return jsqrReady;
  }
  async function startScanner() {
    if (scanning) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      scanStatus.textContent = 'Camera is not available here. Camera access needs a secure (https) connection — or use the search below.'; return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch (e) {
      scanStatus.textContent = e && e.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access in your browser settings, or use the search below.'
        : 'Could not start the camera. You can still search for guests below.';
      return;
    }
    video.srcObject = stream; await video.play().catch(() => {});
    $('#scanView').hidden = false; scanning = true; scanBtn.textContent = 'Stop Camera';
    scanStatus.textContent = 'Scanning… hold the QR code inside the frame.';
    if ('BarcodeDetector' in window) {
      try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
    }
    if (!detector) { try { await loadJsQr(); } catch (e) { scanStatus.textContent = 'Scanner library failed to load. Use the search below.'; stopScanner(); return; } }
    scanLoop();
  }
  function stopScanner() {
    scanning = false;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    video.srcObject = null; $('#scanView').hidden = true; scanBtn.textContent = 'Start Camera';
    if (scanStatus) scanStatus.textContent = 'Point the camera at a guest’s QR code.';
  }
  async function scanLoop() {
    while (scanning) {
      let code = '';
      try {
        if (video.readyState >= 2 && video.videoWidth) {
          if (detector) {
            const found = await detector.detect(video);
            if (found && found.length) code = found[0].rawValue || '';
          } else {
            const w = Math.min(640, video.videoWidth), hgt = Math.round(w * video.videoHeight / video.videoWidth);
            canvas.width = w; canvas.height = hgt;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, w, hgt);
            const img = ctx.getImageData(0, 0, w, hgt);
            const q = window.jsQR(img.data, w, hgt, { inversionAttempts: 'dontInvert' });
            if (q) code = q.data;
          }
        }
      } catch (e) { /* frame not ready */ }
      if (code && !(code === lastCode && Date.now() - lastAt < 4000) && !checking) {
        lastCode = code; lastAt = Date.now();
        if (/^JB1:[A-Za-z0-9_-]{43}$/.test(code.trim())) await doCheckin({ token: code.trim() });
        else { showResult('bad', 'Not a guest QR code', 'This QR code is not from this invitation.'); buzz([200]); }
      }
      await sleep(detector ? 120 : 160);
    }
  }
  scanBtn.addEventListener('click', () => scanning ? stopScanner() : startScanner());
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopScanner(); });

  /* ---- manual search ---- */
  let quickBusy = false;
  async function runQuick() {
    const q = $('#quickQ').value.trim(); const box = $('#quickResults');
    if (q.length < 2) { box.textContent = ''; return; }
    if (quickBusy) return; quickBusy = true;
    const r = await api('GET', '/api/admin/rsvps?limit=20&q=' + encodeURIComponent(q));
    quickBusy = false;
    box.textContent = '';
    if (!r.ok) { box.append(h('div', { class: 'empty' }, r.data.message || 'Search failed.')); return; }
    if (!r.data.rsvps.length) { box.append(h('div', { class: 'empty' }, 'No guests found.')); return; }
    r.data.rsvps.forEach(g => box.append(guestCard(g, { events: [currentEvent], compact: true, refresh: runQuick })));
  }
  $('#quickForm').addEventListener('submit', (e) => { e.preventDefault(); runQuick(); });

  /* ---------------- guests tab ---------------- */
  let gOffset = 0;
  const PAGE = 40;
  async function loadGuests(reset) {
    if (reset) { gOffset = 0; $('#guestList').textContent = ''; }
    const p = new URLSearchParams({ limit: PAGE, offset: gOffset });
    [['q', '#gQ'], ['status', '#gStatus'], ['event', '#gEvent'], ['checkin', '#gCheckin']].forEach(([k, sel]) => { const v = $(sel).value.trim(); if (v) p.set(k, v); });
    const r = await api('GET', '/api/admin/rsvps?' + p);
    if (!r.ok) { $('#gCount').textContent = r.data.message || 'Could not load guests.'; return; }
    const list = $('#guestList');
    r.data.rsvps.forEach(g => list.append(guestCard(g, { refresh: () => loadGuests(true) })));
    gOffset += r.data.rsvps.length;
    $('#gCount').textContent = `${r.data.total} reservation${r.data.total === 1 ? '' : 's'}`;
    $('#gMore').hidden = gOffset >= r.data.total;
    if (!r.data.total) list.append(h('div', { class: 'empty' }, 'No reservations match.'));
  }
  let gTimer;
  $('#gQ').addEventListener('input', () => { clearTimeout(gTimer); gTimer = setTimeout(() => loadGuests(true), 300); });
  ['#gStatus', '#gEvent', '#gCheckin'].forEach(s => $(s).addEventListener('change', () => loadGuests(true)));
  $('#guestFilters').addEventListener('submit', (e) => { e.preventDefault(); loadGuests(true); });
  $('#gMore').addEventListener('click', () => loadGuests(false));

  $('#exportBtn').addEventListener('click', async () => {
    const res = await fetch('/api/admin/export.csv', { credentials: 'same-origin' });
    if (!res.ok) { toast('Export failed'); return; }
    const blob = await res.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'jimson-bismy-guests.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  /* ---------------- overview ---------------- */
  const stat = (n, l, s) => h('div', { class: 'stat' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l), s ? h('div', { class: 's' }, s) : null);
  async function loadOverview() {
    const r = await api('GET', '/api/admin/stats'); const box = $('#overview'); box.textContent = '';
    if (!r.ok) { box.append(h('div', { class: 'empty' }, r.data.message || 'Could not load.')); return; }
    const d = r.data;
    box.append(h('div', { class: 'sec-title' }, 'Replies'),
      h('div', { class: 'stat-grid' },
        stat(d.rsvps.total, 'Total RSVPs'), stat(d.expected_guests, 'Expected guests', 'confirmed attendees'),
        stat(d.rsvps.confirmed, 'Confirmed'), stat(d.rsvps.declined, 'Declined'), stat(d.rsvps.cancelled, 'Cancelled')));
    ['engagement', 'reception'].forEach(ev => {
      const e = d.events[ev];
      box.append(h('div', { class: 'sec-title' }, `${EVENT_NAME[ev]} · ${ev === 'engagement' ? '4:00 PM' : '5:00 PM'}`),
        h('div', { class: 'stat-grid' },
          stat(e.expected_guests, 'Expected guests', `${e.rsvps} reservation${e.rsvps === 1 ? '' : 's'}`),
          stat(`${e.checked_in_guests}`, 'Guests checked in', `${e.checked_in_parties} ${e.checked_in_parties === 1 ? 'party' : 'parties'}`),
          stat(e.pending_parties, 'Parties pending')));
    });
    box.append(h('div', { class: 'sec-title' }, 'Wishes'),
      h('div', { class: 'stat-grid' }, stat(d.wishes.pending, 'Awaiting approval'), stat(d.wishes.approved, 'Approved'), stat(d.wishes.private, 'Private')));
  }
  $('#refreshStats').addEventListener('click', loadOverview);

  /* ---------------- wishes moderation ---------------- */
  let wStatus = 'pending';
  $$('.seg-btn[data-wstatus]').forEach(b => b.addEventListener('click', () => {
    wStatus = b.dataset.wstatus;
    $$('.seg-btn[data-wstatus]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
    loadWishes();
  }));
  async function loadWishes() {
    const r = await api('GET', '/api/admin/wishes?status=' + wStatus); const box = $('#wishAdminList'); box.textContent = '';
    if (!r.ok) { box.append(h('div', { class: 'empty' }, r.data.message || 'Could not load wishes.')); return; }
    if (!r.data.wishes.length) { box.append(h('div', { class: 'empty' }, 'Nothing here.')); return; }
    r.data.wishes.forEach(w => {
      const badges = h('div', { class: 'badges' }, h('span', { class: 'badge ' + (w.approved ? 'ok' : 'warn') }, w.approved ? 'Approved' : 'Pending'));
      if (w.is_private) badges.append(h('span', { class: 'badge mute' }, 'Private — never shown'));
      box.append(h('article', { class: 'g-card' },
        h('div', { class: 'g-top' }, h('div', { class: 'g-name' }, w.name), h('div', { class: 'g-ref' }, fmtDate(w.created_at))),
        h('p', { class: 'g-msg', style: 'margin-top:8px' }, w.message), badges,
        h('div', { class: 'g-actions' },
          h('button', { class: 'btn small ' + (w.approved ? 'ghost' : 'primary'), type: 'button', onclick: () => moderate(w, !w.approved) }, w.approved ? 'Hide' : 'Approve'),
          h('button', { class: 'btn small danger', type: 'button', onclick: () => deleteWish(w) }, 'Delete'))));
    });
  }
  async function moderate(w, approved) {
    const r = await api('PATCH', '/api/admin/wishes/' + w.id, { approved });
    toast(r.ok ? (approved ? 'Approved' : 'Hidden') : (r.data.message || 'Failed')); loadWishes();
  }
  async function deleteWish(w) {
    if (!confirm('Delete this wish permanently?')) return;
    const r = await api('DELETE', '/api/admin/wishes/' + w.id);
    toast(r.ok ? 'Deleted' : (r.data.message || 'Failed')); loadWishes();
  }

  /* ---------------- edit dialog ---------------- */
  const eGuests = $('#eGuests');
  for (let i = 1; i <= 10; i++) eGuests.append(h('option', { value: i }, String(i)));
  let editing = null;
  function syncEdit() {
    const off = $('#eStatus').value !== 'attending';
    eGuests.disabled = off; $('#eEvents').disabled = off;
  }
  $('#eStatus').addEventListener('change', syncEdit);
  function openEdit(r) {
    editing = r; $('#editMsg').textContent = '';
    $('#eName').value = r.name; $('#ePhone').value = r.phone; $('#eStatus').value = r.status;
    eGuests.value = String(r.guests || 1);
    $('#eEvents').value = r.engagement_selected && r.reception_selected ? 'both' : r.engagement_selected ? 'engagement' : r.reception_selected ? 'reception' : 'both';
    $('#eMsg').value = r.message || ''; syncEdit(); $('#editModal').hidden = false; $('#eName').focus();
  }
  $('#editCancel').addEventListener('click', () => { $('#editModal').hidden = true; });
  $('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: $('#eName').value, phone: $('#ePhone').value, status: $('#eStatus').value, message: $('#eMsg').value };
    if (body.status === 'attending') { body.guests = Number(eGuests.value); body.events = $('#eEvents').value; }
    $('#editSave').disabled = true;
    const r = await api('PATCH', '/api/admin/rsvps/' + editing.id, body);
    $('#editSave').disabled = false;
    if (r.ok) { $('#editModal').hidden = true; toast('Saved'); loadGuests(true); }
    else $('#editMsg').textContent = (r.data.errors ? Object.values(r.data.errors).join(' ') : '') || r.data.message || 'Could not save.';
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#editModal').hidden) $('#editModal').hidden = true; });

  init();
})();
