/* ============================================================
   JIMSON & BISMY — RSVP, check-in ticket and guest wishes
   Talks to the server API (/api/*). All guest-supplied text is rendered with
   textContent only (never innerHTML), so submitted content cannot inject markup.
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const STORE_KEY = 'jb_rsvp_token';       // convenience only: remembers the confirmation link on this device

  const store = {
    get(){ try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } },
    set(v){ try { localStorage.setItem(STORE_KEY, v); } catch (e) {} },
    del(){ try { localStorage.removeItem(STORE_KEY); } catch (e) {} }
  };

  /* ---------------- API helper ---------------- */
  async function api(method, path, body) {
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin'
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      return { ok: res.ok, status: res.status, data: data || {} };
    } catch (e) {
      return { ok: false, status: 0, data: { error: 'network', message: 'We couldn’t reach the server. Please check your connection and try again.' } };
    }
  }

  /* anti-bot form token (fetched when a form scrolls into view, so it is a few seconds old on submit) */
  let formToken = null;
  async function ensureToken(force) {
    if (formToken && !force) return formToken;
    const r = await api('GET', '/api/token');
    formToken = r.ok ? r.data.token : null;
    return formToken;
  }
  /* POST that transparently waits out the "too fast" check and refreshes a stale token once. */
  async function postWithToken(path, payload) {
    await ensureToken();
    let r = await api('POST', path, { ...payload, ft: formToken });
    if (r.status === 400 && r.data.error === 'too_fast') { await sleep(2700); r = await api('POST', path, { ...payload, ft: formToken }); }
    else if (r.status === 400 && r.data.error === 'bad_token') {
      await ensureToken(true); await sleep(2700);
      r = await api('POST', path, { ...payload, ft: formToken });
    }
    return r;
  }

  /* ---------------- small UI helpers ---------------- */
  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.classList.toggle('error', kind === 'error');
    el.classList.toggle('ok', kind === 'ok');
  }
  function fieldEl(form, name) { return form.querySelector(`[data-field="${name}"]`); }
  function setFieldError(form, name, msg) {
    const f = fieldEl(form, name); if (!f) return;
    f.classList.toggle('invalid', !!msg);
    const e = $('.field-error', f); if (e) e.textContent = msg || '';
    const input = $('input:not([type=radio]):not([type=checkbox]), select, textarea', f);
    if (input) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  }
  function clearErrors(form) { $$('[data-field]', form).forEach(f => setFieldError(form, f.dataset.field, '')); }
  function focusFirstInvalid(form) {
    const f = $('[data-field].invalid', form);
    if (!f) return;
    const el = $('input:not([type=radio]):not([type=checkbox]), select, textarea', f) || $('input', f);
    if (el) el.focus({ preventScroll: false });
  }
  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Please wait…'; btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
  function counter(textarea) {
    const out = textarea.closest('.field').querySelector('[data-count]');
    if (!out) return;
    const upd = () => { out.textContent = textarea.value.length; };
    textarea.addEventListener('input', upd); upd();
  }
  function whenNear(el, fn) {
    if (!('IntersectionObserver' in window)) { fn(); return; }
    const io = new IntersectionObserver((es) => { if (es.some(e => e.isIntersecting)) { io.disconnect(); fn(); } }, { rootMargin: '500px 0px' });
    io.observe(el);
  }

  /* ---------------- client-side validation (mirrors the server) ---------------- */
  function validPhone(raw) {
    const s = (raw || '').trim();
    if (!s) return 'Please enter your phone number.';
    if (!/^[+\d][\d\s().\-]*$/.test(s)) return 'Phone numbers can contain digits, spaces and + only.';
    let d = s.replace(/\D/g, '');
    const plus = s.startsWith('+');
    if (!plus && d.startsWith('00')) d = d.slice(2);
    else if (!plus && d.length === 11 && d[0] === '0') d = d.slice(1);
    if (!plus && d.length === 10) { if (!/^[6-9]/.test(d)) return 'Indian mobile numbers start with 6, 7, 8 or 9.'; return ''; }
    if (d.length < 8 || d.length > 15) return 'Please enter a valid phone number (with country code if outside India).';
    return '';
  }
  const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'’\-]*$/u;
  function validName(raw, min, what) {
    const s = (raw || '').replace(/\s+/g, ' ').trim();
    if (s.length < min) return what === 'wish' ? 'Please enter your name.' : 'Please enter your full name.';
    if (s.length > 80) return 'That name is too long.';
    if (!NAME_RE.test(s)) return 'Names can include letters, spaces, apostrophes, dots and hyphens only.';
    return '';
  }

  /* ============================================================
     RSVP
     ============================================================ */
  const rsvpForm   = $('#rsvpForm');
  if (!rsvpForm) return;
  const formPanel  = $('#rsvpFormPanel');
  const lookupPanel= $('#rsvpLookupPanel');
  const ticketPanel= $('#rsvpTicket');
  const rsvpMsg    = $('#rsvpMsg');
  const rsvpSubmit = $('#rsvpSubmit');
  const guestsSel  = $('#rsvpGuests');
  const guestsField= $('#guestsField');
  const eventsField= $('#eventsField');
  const eventRadios= $$('input[name=events]', rsvpForm);
  let mode = 'create';            // 'create' | 'edit'
  let current = null;             // the reservation being displayed
  let submitting = false;

  counter($('#rsvpMessage'));
  $('#rsvpMessage').addEventListener('input', () => {});

  function showPanel(which) {
    formPanel.hidden = which !== 'form';
    lookupPanel.hidden = which !== 'lookup';
    ticketPanel.hidden = which !== 'ticket';
    formPanel.classList.add('in');
    const sec = $('#rsvp'); const top = sec.getBoundingClientRect().top + window.scrollY;
    if (Math.abs(window.scrollY - top) > 40 && which !== 'form') window.scrollTo({ top: top + 40, behavior: 'smooth' });
  }

  /* Non-attending guests do not need a guest count or events: disable & clear them. */
  function syncAttendance() {
    const val = (rsvpForm.querySelector('input[name=attendance]:checked') || {}).value;
    const off = val === 'declined';
    guestsSel.disabled = off; guestsField.classList.toggle('is-disabled', off);
    eventRadios.forEach(r => { r.disabled = off; });
    eventsField.classList.toggle('is-disabled', off);
    eventsField.setAttribute('aria-disabled', off ? 'true' : 'false');
    if (off) {
      guestsSel.value = ''; eventRadios.forEach(r => { r.checked = false; });
      setFieldError(rsvpForm, 'guests', ''); setFieldError(rsvpForm, 'events', '');
    }
  }
  $$('input[name=attendance]', rsvpForm).forEach(r => r.addEventListener('change', () => { syncAttendance(); setFieldError(rsvpForm, 'attendance', ''); }));
  eventRadios.forEach(r => r.addEventListener('change', () => setFieldError(rsvpForm, 'events', '')));
  guestsSel.addEventListener('change', () => setFieldError(rsvpForm, 'guests', ''));
  $('#rsvpName').addEventListener('input', () => setFieldError(rsvpForm, 'name', ''));
  $('#rsvpPhone').addEventListener('input', () => setFieldError(rsvpForm, 'phone', ''));

  function readRsvp() {
    const fd = new FormData(rsvpForm);
    const attendance = fd.get('attendance') || '';
    return {
      name: (fd.get('name') || '').trim(),
      phone: (fd.get('phone') || '').trim(),
      attendance,
      guests: attendance === 'attending' ? fd.get('guests') : '',
      events: attendance === 'attending' ? (fd.get('events') || '') : '',
      message: (fd.get('message') || '').trim(),
      website: fd.get('website') || ''
    };
  }

  function validateRsvpClient(d) {
    const errs = {};
    const n = validName(d.name, 2); if (n) errs.name = n;
    if (mode === 'create') { const p = validPhone(d.phone); if (p) errs.phone = p; }
    if (d.attendance !== 'attending' && d.attendance !== 'declined') errs.attendance = 'Please tell us whether you will attend.';
    if (d.attendance === 'attending') {
      const g = parseInt(d.guests, 10);
      if (!(g >= 1 && g <= 10)) errs.guests = 'Please choose the number of guests.';
      if (!['engagement', 'reception', 'both'].includes(d.events)) errs.events = 'Please choose which event(s) you will attend.';
    }
    if (/(https?:\/\/|www\.)/i.test(d.message)) errs.message = 'Please leave links out of your message.';
    return errs;
  }

  rsvpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;                       // blocks duplicate submissions from repeated taps
    clearErrors(rsvpForm); setMsg(rsvpMsg, '');
    const d = readRsvp();
    const errs = validateRsvpClient(d);
    if (Object.keys(errs).length) {
      Object.entries(errs).forEach(([k, v]) => setFieldError(rsvpForm, k, v));
      setMsg(rsvpMsg, 'Please check the highlighted fields.', 'error');
      focusFirstInvalid(rsvpForm);
      return;
    }
    submitting = true; busy(rsvpSubmit, true, mode === 'edit' ? 'Saving…' : 'Confirming…');
    let r;
    if (mode === 'edit') {
      r = await api('POST', '/api/rsvp/update', { token: current.manage_token, ...d });
    } else {
      r = await postWithToken('/api/rsvp', d);
    }
    submitting = false; busy(rsvpSubmit, false);

    if (r.ok && r.data.reservation) {
      store.set(r.data.reservation.manage_token);
      current = r.data.reservation;
      renderTicket(current, mode === 'edit' ? 'updated' : 'created');
      showPanel('ticket');
      leaveEditMode();
      return;
    }
    if (r.status === 422 && r.data.errors) {
      Object.entries(r.data.errors).forEach(([k, v]) => setFieldError(rsvpForm, k, v));
      setMsg(rsvpMsg, r.data.message, 'error'); focusFirstInvalid(rsvpForm);
    } else if (r.status === 409 && r.data.error === 'duplicate') {
      setMsg(rsvpMsg, r.data.message, 'error');
      $('#showLookup').scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      setMsg(rsvpMsg, r.data.message || 'Something went wrong. Please try again.', 'error');
    }
  });

  /* ---------- edit mode ---------- */
  function enterEditMode(res) {
    mode = 'edit';
    rsvpForm.reset();
    $('#rsvpName').value = res.name;
    const ph = $('#rsvpPhone'); ph.value = res.phone_masked; ph.disabled = true;
    $('#rsvpPhoneHint').textContent = 'Your phone number identifies this reservation and can’t be changed here.';
    const att = res.attendance === 'cancelled' ? 'attending' : res.attendance;
    const a = rsvpForm.querySelector(`input[name=attendance][value=${att}]`); if (a) a.checked = true;
    syncAttendance();
    if (att === 'attending') {
      guestsSel.value = String(res.guests || '');
      const ev = res.events.engagement && res.events.reception ? 'both' : res.events.engagement ? 'engagement' : res.events.reception ? 'reception' : '';
      const er = ev && rsvpForm.querySelector(`input[name=events][value=${ev}]`); if (er) er.checked = true;
    }
    $('#rsvpMessage').value = res.message || '';
    $('#rsvpMessage').dispatchEvent(new Event('input'));
    rsvpSubmit.textContent = 'Save Changes';
    $('#rsvpEditFoot').hidden = false;
    $('#showLookup').parentElement.hidden = true;
    clearErrors(rsvpForm); setMsg(rsvpMsg, '');
  }
  function leaveEditMode() {
    mode = 'create';
    const ph = $('#rsvpPhone'); ph.disabled = false;
    $('#rsvpPhoneHint').textContent = 'Used only to find your reservation — never shown publicly.';
    rsvpSubmit.textContent = 'Confirm RSVP';
    $('#rsvpEditFoot').hidden = true;
    $('#showLookup').parentElement.hidden = false;
  }
  $('#rsvpEditCancel').addEventListener('click', () => { leaveEditMode(); rsvpForm.reset(); syncAttendance(); renderTicket(current); showPanel('ticket'); });

  /* ---------- lookup ---------- */
  $('#showLookup').addEventListener('click', () => { showPanel('lookup'); $('#lookupRef').focus(); });
  $('#lookupBack').addEventListener('click', () => showPanel('form'));
  const lookupForm = $('#lookupForm');
  let looking = false;
  lookupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (looking) return;
    clearErrors(lookupForm); setMsg($('#lookupMsg'), '');
    const reference = $('#lookupRef').value.trim(); const phone = $('#lookupPhone').value.trim();
    let bad = false;
    if (!/^JB-?[A-Z0-9]{6}$/i.test(reference.replace(/\s+/g, ""))) { setFieldError(lookupForm, 'reference', 'Enter the reference from your confirmation, e.g. JB-AB12CD.'); bad = true; }
    const pe = validPhone(phone); if (pe) { setFieldError(lookupForm, 'phone', pe); bad = true; }
    if (bad) { focusFirstInvalid(lookupForm); return; }
    looking = true; busy($('#lookupSubmit'), true, 'Searching…');
    const r = await api('POST', '/api/rsvp/lookup', { reference, phone, website: $('input[name=website]', lookupForm).value });
    looking = false; busy($('#lookupSubmit'), false);
    if (r.ok) {
      current = r.data.reservation; store.set(current.manage_token);
      renderTicket(current, 'found'); showPanel('ticket');
    } else setMsg($('#lookupMsg'), r.data.message || 'Something went wrong. Please try again.', 'error');
  });

  /* ---------- ticket / confirmation ---------- */
  const EVENT_LABEL = { engagement: 'Engagement Ceremony · 4:00 PM', reception: 'Reception · 5:00 PM' };
  function addRow(dl, label, value, cls) {
    const row = document.createElement('div'); row.className = 'row';
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value; if (cls) dd.className = cls;
    row.append(dt, dd); dl.appendChild(row);
  }
  function fmtIst(ts) {
    try { return new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }); }
    catch (e) { return ''; }
  }

  function renderTicket(res, how) {
    current = res;
    const first = res.name.split(' ')[0];
    const attending = res.attendance === 'attending';
    const cancelled = res.attendance === 'cancelled';
    const checkedIn = !!(res.checked_in.engagement || res.checked_in.reception);

    $('#tkTitle').textContent = cancelled ? 'Reservation Cancelled' : attending ? (how === 'updated' ? 'Reservation Updated' : 'Reservation Confirmed') : 'Thank You For Letting Us Know';
    $('#tkNote').textContent = cancelled
      ? 'Your reservation has been cancelled. You are always welcome to reserve again.'
      : attending
        ? `We’re delighted you’ll be joining us, ${first}. Please keep this page or your QR code handy.`
        : `We’ll miss you, ${first}, but are grateful you let us know. Changed your mind? You can update your RSVP any time.`;

    const dl = $('#tkRows'); dl.textContent = '';
    addRow(dl, 'Guest', res.name);
    if (attending) {
      addRow(dl, 'Attendees', res.guests + (res.guests === 1 ? ' guest' : ' guests'));
      const evs = [res.events.engagement && EVENT_LABEL.engagement, res.events.reception && EVENT_LABEL.reception].filter(Boolean);
      addRow(dl, 'Event' + (evs.length > 1 ? 's' : ''), evs.join('\n'));
      dl.lastChild.lastChild.style.whiteSpace = 'pre-line';
    } else {
      addRow(dl, 'Status', cancelled ? 'Cancelled' : 'Unable to attend');
    }
    addRow(dl, 'Reference', res.reference, 'ref');

    const showQr = attending && !!res.qr_token && typeof qrcode === 'function';
    $('#tkQrBlock').hidden = !showQr;
    if (showQr) drawQr($('#tkQr'), res.qr_token);

    const badges = $('#tkBadges'); badges.textContent = '';
    ['engagement', 'reception'].forEach(ev => {
      if (res.checked_in[ev]) {
        const b = document.createElement('span'); b.className = 'badge';
        b.textContent = '✓ Checked in · ' + (ev === 'engagement' ? 'Engagement' : 'Reception') + ' · ' + fmtIst(res.checked_in[ev]);
        badges.appendChild(b);
      }
    });

    $('#tkSaveQr').hidden = !showQr;
    $('#tkCopyLink').hidden = false;
    $('#tkEdit').hidden = checkedIn;
    $('#tkEdit').textContent = cancelled ? 'Reserve Again' : (attending ? 'Update My RSVP' : 'Change My Reply');
    $('#tkCancel').hidden = checkedIn || cancelled || !attending;
    $('#tkCancelConfirm').hidden = true;
    $('#tkClose').hidden = false;
    setMsg($('#tkMsg'), checkedIn ? 'You’re checked in — enjoy the celebration!' : '', checkedIn ? 'ok' : '');
  }

  /* QR code drawn on a canvas: dark modules on white with a quiet zone, for reliable scanning. */
  function drawQr(canvas, text, px) {
    const size = px || 392;
    const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    const n = qr.getModuleCount();
    const cell = Math.floor(size / (n + 2));
    const off = Math.floor((size - cell * n) / 2);
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#2E2A22';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
  }

  $('#tkSaveQr').addEventListener('click', () => {
    if (!current || !current.qr_token) return;
    const W = 720, H = 920;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#FAF5E9'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#C6A15B'; g.lineWidth = 3; g.strokeRect(24, 24, W - 48, H - 48);
    g.lineWidth = 1; g.strokeRect(36, 36, W - 72, H - 72);
    g.textAlign = 'center'; g.fillStyle = '#2E2A22';
    g.font = '600 56px "Playfair Display", Georgia, serif'; g.fillText('Jimson & Bismy', W / 2, 120);
    g.fillStyle = '#8F6E34'; g.font = '500 20px Jost, Arial, sans-serif';
    g.fillText('ENGAGEMENT & RECEPTION · 23 JANUARY 2027', W / 2, 165);
    const q = document.createElement('canvas'); drawQr(q, current.qr_token, 460);
    g.fillStyle = '#fff'; g.fillRect(W / 2 - 250, 205, 500, 500);
    g.strokeStyle = '#C6A15B'; g.strokeRect(W / 2 - 250, 205, 500, 500);
    g.drawImage(q, W / 2 - 230, 225, 460, 460);
    g.fillStyle = '#2E2A22'; g.font = '600 34px "Playfair Display", Georgia, serif';
    g.fillText(current.name, W / 2, 770, W - 120);
    g.font = '500 24px Jost, Arial, sans-serif'; g.fillStyle = '#8F6E34';
    g.fillText(current.reference + '  ·  ' + current.guests + (current.guests === 1 ? ' guest' : ' guests'), W / 2, 815);
    g.font = 'italic 24px "Cormorant Garamond", Georgia, serif'; g.fillStyle = '#4A4436';
    const evs = [current.events.engagement && 'Engagement 4:00 PM', current.events.reception && 'Reception 5:00 PM'].filter(Boolean).join('  ·  ');
    g.fillText(evs, W / 2, 860);
    c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'jimson-bismy-' + current.reference + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  });

  $('#tkCopyLink').addEventListener('click', async () => {
    if (!current) return;
    const link = location.origin + '/?rsvp=' + encodeURIComponent(current.manage_token) + '#rsvp';
    let ok = false;
    try { await navigator.clipboard.writeText(link); ok = true; } catch (e) {
      try { const t = document.createElement('textarea'); t.value = link; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); ok = document.execCommand('copy'); t.remove(); } catch (e2) {}
    }
    setMsg($('#tkMsg'), ok ? 'Link copied. Anyone with it can view or change this reservation, so keep it private.' : 'Couldn’t copy automatically. Your reference is ' + current.reference + '.', ok ? 'ok' : 'error');
  });

  $('#tkEdit').addEventListener('click', () => { enterEditMode(current); showPanel('form'); $('#rsvpName').focus(); });
  $('#tkCancel').addEventListener('click', () => { $('#tkCancelConfirm').hidden = false; $('#tkCancel').hidden = true; });
  $('#tkCancelNo').addEventListener('click', () => { $('#tkCancelConfirm').hidden = true; $('#tkCancel').hidden = false; });
  let cancelling = false;
  $('#tkCancelYes').addEventListener('click', async () => {
    if (cancelling) return; cancelling = true;
    $('#tkCancelYes').disabled = true;
    const r = await api('POST', '/api/rsvp/cancel', { token: current.manage_token });
    cancelling = false; $('#tkCancelYes').disabled = false;
    if (r.ok) { current = r.data.reservation; renderTicket(current, 'cancelled'); setMsg($('#tkMsg'), 'Your reservation has been cancelled.', 'ok'); }
    else { $('#tkCancelConfirm').hidden = true; $('#tkCancel').hidden = false; setMsg($('#tkMsg'), r.data.message || 'Couldn’t cancel. Please try again.', 'error'); }
  });
  $('#tkClose').addEventListener('click', () => {
    store.del(); current = null; leaveEditMode(); rsvpForm.reset(); syncAttendance(); clearErrors(rsvpForm); setMsg(rsvpMsg, '');
    showPanel('form'); $('#rsvpName').focus();
  });

  /* ---------- restore a booking from a confirmation link or this device ---------- */
  (async function restore() {
    const params = new URLSearchParams(location.search);
    const linkToken = params.get('rsvp');
    const token = linkToken || store.get();
    if (linkToken) {
      window.__jbGoto = 'rsvp';
      history.replaceState(null, '', location.pathname + '#rsvp');    // keep the secret out of the address bar
    } else if (/^#(rsvp|wishes)$/.test(location.hash)) {
      window.__jbGoto = location.hash.slice(1);
    }
    if (!token) return;
    const r = await api('POST', '/api/rsvp/lookup', { token });
    if (r.ok) { current = r.data.reservation; store.set(current.manage_token); renderTicket(current, 'found'); showPanel('ticket'); }
    else if (r.status === 404) store.del();
  })();

  whenNear($('#rsvp'), () => ensureToken());
  syncAttendance();

  /* ============================================================
     WISHES
     ============================================================ */
  const wishForm = $('#wishForm');
  const wishMsg  = $('#wishMsg');
  const wishBtn  = $('#wishSubmit');
  const wishList = $('#wishList');
  const moreWrap = $('#wishMoreWrap');
  let wishes = [], shown = 0, sendingWish = false;
  const PAGE = 6;

  counter($('#wishText'));
  $('#wishName').addEventListener('input', () => setFieldError(wishForm, 'name', ''));
  $('#wishText').addEventListener('input', () => setFieldError(wishForm, 'message', ''));

  function renderWishes(from) {
    if (from === 0) wishList.textContent = '';
    if (!wishes.length) {
      const p = document.createElement('p'); p.className = 'wish-empty'; p.textContent = 'Be the first to leave a blessing for us.';
      wishList.appendChild(p); moreWrap.hidden = true; return;
    }
    wishes.slice(from, shown).forEach((w, i) => {
      const card = document.createElement('article'); card.className = 'wish-card'; card.style.setProperty('--i', i);
      const msg = document.createElement('p'); msg.className = 'w-msg'; msg.textContent = w.message;
      const foot = document.createElement('div'); foot.className = 'w-foot';
      const name = document.createElement('span'); name.className = 'w-name'; name.textContent = w.name;
      const date = document.createElement('time'); date.className = 'w-date'; date.dateTime = w.created_at;
      try { date.textContent = new Date(w.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) {}
      foot.append(name, date); card.append(msg, foot); wishList.appendChild(card);
    });
    moreWrap.hidden = shown >= wishes.length;
  }
  async function loadWishes() {
    const r = await api('GET', '/api/wishes');
    if (!r.ok) {
      wishList.textContent = '';
      const p = document.createElement('p'); p.className = 'wish-empty'; p.textContent = 'Wishes will appear here soon.'; wishList.appendChild(p);
      return;
    }
    wishes = r.data.wishes || []; shown = Math.min(PAGE, wishes.length); renderWishes(0);
  }
  $('#wishMore').addEventListener('click', () => { const from = shown; shown = Math.min(shown + PAGE, wishes.length); renderWishes(from); });
  whenNear($('#wishes'), () => { ensureToken(); loadWishes(); });

  wishForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sendingWish) return;
    clearErrors(wishForm); setMsg(wishMsg, '');
    const fd = new FormData(wishForm);
    const name = (fd.get('name') || '').trim(), message = (fd.get('message') || '').trim();
    let bad = false;
    const ne = validName(name, 1, 'wish'); if (ne) { setFieldError(wishForm, 'name', ne); bad = true; }
    if (!message) { setFieldError(wishForm, 'message', 'Please write your wishes.'); bad = true; }
    else if (/(https?:\/\/|www\.)/i.test(message)) { setFieldError(wishForm, 'message', 'Please leave links out of your wishes.'); bad = true; }
    if (bad) { focusFirstInvalid(wishForm); return; }

    sendingWish = true; busy(wishBtn, true, 'Sending…');
    const r = await postWithToken('/api/wishes', { name, message, private: !!fd.get('private'), website: fd.get('website') || '' });
    if (r.ok) {
      const priv = r.data.private;
      setMsg(wishMsg, r.data.status === 'published'
        ? `Thank you, ${name}! Your wishes are now part of our guest book.`
        : priv ? `Thank you, ${name}. Your private wishes have been sent to Jimson & Bismy.`
               : `Thank you, ${name}! Your wishes have been received and will appear once they’ve been approved.`, 'ok');
      wishForm.reset(); $('#wishText').dispatchEvent(new Event('input'));
      if (r.data.status === 'published') loadWishes();
      busy(wishBtn, false); wishBtn.disabled = true;
      setTimeout(() => { wishBtn.disabled = false; sendingWish = false; }, 4000);   // brief cool-down against repeat clicks
    } else {
      if (r.status === 422 && r.data.errors) Object.entries(r.data.errors).forEach(([k, v]) => setFieldError(wishForm, k, v));
      setMsg(wishMsg, r.data.message || 'Something went wrong. Please try again.', 'error');
      if (r.status === 422) focusFirstInvalid(wishForm);
      busy(wishBtn, false); sendingWish = false;
    }
  });
})();
