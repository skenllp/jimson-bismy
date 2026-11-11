/* Browser end-to-end test (Playwright + real Postgres + the real server).
   Run:  NODE_PATH=<dir containing playwright> node tests/e2e.js
   Playwright's bundled Chromium has no H.264, so the two MP4s are served as VP9 copies ONLY inside this test (see e2e-lib). */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { Pool } = require('pg');
const assert = require('node:assert/strict');
const { ENV, resetDb, startServer } = require('./helpers');

const PORT = 4400;
const TMP = process.env.E2E_TMP || '/tmp/jb-e2e';
fs.mkdirSync(TMP, { recursive: true });
const SHOTS = process.env.E2E_SHOTS || TMP;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0;
const openInvite = async (pg) => {
  await pg.tap('#openBtn');
  await pg.waitForFunction(() => getComputedStyle(document.getElementById('open')).display === 'none', null, { timeout: 20000 });
};
const ok = (name) => { passed++; console.log('  ✓', name); };

function prepMedia() {
  const root = path.join(__dirname, '..', 'public', 'assets');
  for (const n of ['opening', 'hero']) {
    const out = path.join(TMP, n + '.webm');
    if (!fs.existsSync(out)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(root, n + '.mp4'), '-c:v', 'libvpx-vp9', '-b:v', '1M', '-an', out]);
  }
}
async function routes(ctx, { video = true } = {}) {
  // fonts: not reachable from the sandbox; layout checks do not depend on them
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('https://share.google/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>maps stub</title>' }));
  if (video) {
    await ctx.route('**/assets/opening.mp4', r => r.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(path.join(TMP, 'opening.webm')) }));
    await ctx.route('**/assets/hero.mp4', r => r.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(path.join(TMP, 'hero.webm')) }));
  }
}

(async () => {
  prepMedia();
  await resetDb();
  const srv = await startServer(PORT);
  const base = srv.base;
  const pool = new Pool({ connectionString: ENV.DATABASE_URL });
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, label) => {
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|fonts/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  };

  try {
    /* ---------- 1. opening experience ---------- */
    console.log('Opening experience');
    let ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await routes(ctx);
    let page = await ctx.newPage(); watch(page, 'guest');
    await page.goto(base + '/');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), 'hidden');
    const bodyTxt = await page.locator('#open').innerText();
    assert.match(bodyTxt, /THE ENGAGEMENT OF/i); assert.match(bodyTxt, /Jimson & Bismy/); assert.match(bodyTxt, /23 January 2027/i); assert.match(bodyTxt, /OPEN INVITATION/i);
    ok('cover shows engagement text + Open Invitation');
    assert.equal(await page.evaluate(() => document.getElementById('bgMusic').paused), true);
    await page.tap('#openBtn');
    await page.waitForFunction(() => document.getElementById('open').classList.contains('revealing'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#open .open-content')).opacity === '0', null, { timeout: 3000 });
    await page.waitForFunction(() => !document.getElementById('openingVideo').paused && document.getElementById('openingVideo').currentTime > 0.5, null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => document.getElementById('openingVideo').muted), true);
    ok('text fades out and video plays from the start (muted, playsinline)');
    await page.waitForFunction(() => document.getElementById('open').classList.contains('opened'), null, { timeout: 15000 });
    const vt = await page.evaluate(() => ({ t: document.getElementById('openingVideo').currentTime, ended: document.getElementById('openingVideo').ended }));
    assert.ok(vt.ended && vt.t > 7.5, 'hero transition must wait for the real ended event: ' + JSON.stringify(vt));
    ok('hero transition fires on the video "ended" event (t=' + vt.t.toFixed(2) + 's)');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('open')).display === 'none', null, { timeout: 4000 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflowY), 'auto');
    assert.equal(await page.evaluate(() => !document.getElementById('bgMusic').paused), true);
    assert.equal(await page.evaluate(() => document.getElementById('heroVideo').muted && !document.getElementById('heroVideo').paused), true);
    ok('music starts after the click; hero video autoplays muted; scrolling unlocked');
    await page.screenshot({ path: SHOTS + '/hero-mobile.png' });
    await page.click('#musicToggle'); assert.equal(await page.evaluate(() => document.getElementById('bgMusic').paused), true);
    await page.click('#musicToggle'); assert.equal(await page.evaluate(() => document.getElementById('bgMusic').paused), false);
    ok('music toggle pauses / resumes');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    ok('no horizontal overflow at 390px');

    /* content + map links */
    const html = await page.content();
    for (const bad of ['Emil', 'Jitha', 'emil-jitha', 'Ponmudi', 'Matthew 19']) assert.ok(!html.includes(bad), 'leftover: ' + bad);
    const eng = await page.getAttribute('#engagementMapLink', 'href'), rec = await page.getAttribute('#receptionMapLink', 'href');
    assert.equal(eng, 'https://share.google/rpDI715UbBvhcBiN8'); assert.equal(rec, 'https://share.google/k788WKtIAYAI6QPbH');
    for (const id of ['#engagementMapLink', '#receptionMapLink']) {
      assert.equal(await page.getAttribute(id, 'target'), '_blank'); assert.equal(await page.getAttribute(id, 'rel'), 'noopener noreferrer');
    }
    const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null), page.click('#engagementMapLink')]);
    if (popup) { assert.match(popup.url(), /share\.google\/rpDI715UbBvhcBiN8/); await popup.close(); }
    ok('two separate View Location buttons open the supplied Google Maps URLs in new tabs');
    assert.match(await page.innerText('#savedate'), /23[\s\S]*JANUARY[\s\S]*2027[\s\S]*SATURDAY[\s\S]*4:00 PM[\s\S]*Engagement[\s\S]*5:00 PM[\s\S]*Reception/i);
    assert.match(await page.innerText('#couple'), /Jimson[\s\S]*Francis C\.A\.[\s\S]*Mercy Francis[\s\S]*Cheruvathur House[\s\S]*Thrissur, Kerala[\s\S]*Bismy[\s\S]*Bennichan P\.U\.[\s\S]*Lissy Benny[\s\S]*Puthenpurackal House[\s\S]*Kallara, Kottayam, Kerala/i);
    ok('couple + save-the-date content matches the brief');

    /* countdown */
    await page.evaluate(() => document.getElementById('countdown').scrollIntoView());
    const days = Number(await page.innerText('#cd-days'));
    const expected = Math.floor((Date.parse('2027-01-23T16:00:00+05:30') - Date.now()) / 86400000);
    assert.ok(Math.abs(days - expected) <= 1, `days ${days} vs ${expected}`);
    ok('countdown targets 23 Jan 2027 4:00 PM IST (' + days + ' days)');
    await ctx.close();

    /* countdown after the event: stops at zero with a celebration message (clock mocked) */
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); await routes(ctx);
    page = await ctx.newPage();
    await page.clock.install({ time: new Date('2027-01-23T16:00:03+05:30') });
    await page.goto(base + '/');
    assert.deepEqual(await page.evaluate(() => ['cd-days', 'cd-hours', 'cd-mins', 'cd-secs'].map(i => document.getElementById(i).textContent)), ['00', '00', '00', '00']);
    assert.equal(await page.evaluate(() => document.getElementById('cdDone').hidden), false);
    assert.match(await page.innerText('#cdHeading'), /Celebrate/i);
    await page.clock.install({ time: new Date('2027-01-23T15:59:58+05:30') }).catch(() => {});
    ok('countdown stops at zero and shows a celebration message');
    await ctx.close();

    /* fallback: video cannot play (e.g. blocked / unsupported) -> still reaches hero, no black screen hang */
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); await routes(ctx, { video: false });
    await ctx.route('**/assets/opening.mp4', r => r.abort());
    page = await ctx.newPage();
    await page.goto(base + '/'); await page.click('#openBtn');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('open')).display === 'none', null, { timeout: 6000 });
    ok('playback failure falls back to the hero page');
    await ctx.close();

    /* ---------- 2. RSVP + wishes in the browser ---------- */
    console.log('RSVP, ticket, QR');
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
    await routes(ctx);
    page = await ctx.newPage(); watch(page, 'rsvp');
    await page.goto(base + '/'); await page.tap('#openBtn');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('open')).display === 'none', null, { timeout: 20000 });
    await page.evaluate(() => document.getElementById('rsvp').scrollIntoView());
    await page.click('#rsvpSubmit');
    assert.ok(await page.locator('[data-field=name].invalid').count());
    assert.ok(await page.locator('[data-field=attendance].invalid').count());
    ok('empty RSVP is blocked with inline errors');
    await page.fill('#rsvpName', 'Test Guest'); await page.fill('#rsvpPhone', '12345');
    await page.check('input[name=attendance][value=declined]', { force: true });
    assert.equal(await page.isDisabled('#rsvpGuests'), true);
    assert.equal(await page.locator('input[name=events]').first().isDisabled(), true);
    await page.check('input[name=attendance][value=attending]', { force: true });
    assert.equal(await page.isDisabled('#rsvpGuests'), false);
    ok('guest count + event choice are disabled for “cannot attend”');
    await page.click('#rsvpSubmit');
    assert.match(await page.innerText('[data-field=phone] .field-error'), /valid phone/i);
    await page.fill('#rsvpPhone', '98765 43210'); await page.selectOption('#rsvpGuests', '3'); await page.check('input[name=events][value=both]', { force: true });
    await page.fill('#rsvpMessage', 'Cannot wait!');
    await sleep(3000);
    await page.dblclick('#rsvpSubmit');                               // double-tap must create ONE booking
    await page.waitForSelector('#rsvpTicket:not([hidden])', { timeout: 8000 });
    const rows = await pool.query('select * from public.rsvps');
    assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].guest_count, 3);
    assert.equal(rows.rows[0].checkin_token_hash.length, 64);
    ok('RSVP saved to Postgres exactly once despite a double tap');
    const ticketText = await page.innerText('#rsvpTicket');
    assert.match(ticketText, /Reservation Confirmed/); assert.match(ticketText, /Test Guest/); assert.match(ticketText, /3 guests/); assert.match(ticketText, /Engagement Ceremony[\s\S]*Reception/); assert.match(ticketText, /JB-[A-Z0-9]{6}/);
    assert.ok(!ticketText.includes('9876543210'), 'full phone must not be displayed');
    ok('ticket shows name, attendees, events, reference (phone not exposed)');
    await page.addScriptTag({ path: path.join(__dirname, '..', 'public', 'vendor', 'jsQR.js') });
    const decoded = await page.evaluate(() => { const c = document.getElementById('tkQr'); const x = c.getContext('2d'); const d = x.getImageData(0, 0, c.width, c.height); const q = window.jsQR(d.data, c.width, c.height); return q && q.data; });
    assert.match(decoded, /^JB1:[A-Za-z0-9_-]{43}$/);
    assert.ok(!/test|guest|9876/i.test(decoded));
    ok('the on-page QR decodes to an opaque token with no personal data');
    const qrDataUrl = await page.evaluate(() => document.getElementById('tkQr').toDataURL('image/png'));
    fs.writeFileSync(TMP + '/qr.png', Buffer.from(qrDataUrl.split(',')[1], 'base64'));
    const ref = (await page.innerText('#tkRows .ref')).trim();

    // Save QR downloads a PNG
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#tkSaveQr')]);
    assert.match(dl.suggestedFilename(), /^jimson-bismy-JB-.*\.png$/); ok('Save QR downloads a PNG');
    await page.screenshot({ path: SHOTS + '/ticket-mobile.png' });

    // reload: restored from this device, secret link not left in URL
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('rsvpTicket').hidden, null, { timeout: 8000 });
    await openInvite(page); await page.evaluate(() => document.getElementById('rsvp').scrollIntoView());
    ok('confirmation reappears after reload (this device)');
    const linkBtn = await page.evaluate(async () => { document.getElementById('tkCopyLink').click(); await new Promise(r => setTimeout(r, 300)); return navigator.clipboard.readText(); });
    assert.match(linkBtn, /\?rsvp=JB-/);
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await routes(ctx2);
    const p2 = await ctx2.newPage(); await p2.goto(linkBtn);
    await p2.waitForFunction(() => !document.getElementById('rsvpTicket').hidden, null, { timeout: 8000 });
    assert.ok(!p2.url().includes('rsvp='));
    await openInvite(p2);
    await p2.waitForTimeout(300);
    const top = await p2.evaluate(() => Math.abs(document.getElementById('rsvp').getBoundingClientRect().top));
    assert.ok(top < 60, 'link should land on the RSVP section, top=' + top);
    ok('confirmation link reopens the booking on another device, lands on the RSVP section and strips the secret from the URL');
    await ctx2.close();

    // duplicate booking blocked in UI; lookup by ref+phone; update; cancel
    await page.click('#tkClose'); await page.fill('#rsvpName', 'Someone Else'); await page.fill('#rsvpPhone', '09876543210');
    await page.check('input[name=attendance][value=attending]', { force: true }); await page.selectOption('#rsvpGuests', '1'); await page.check('input[name=events][value=reception]', { force: true });
    await page.click('#rsvpSubmit');
    await page.waitForFunction(() => /already exists/i.test(document.getElementById('rsvpMsg').textContent), null, { timeout: 8000 });
    ok('duplicate phone number is rejected in the UI');
    await page.click('#showLookup'); await page.fill('#lookupRef', ref.toLowerCase()); await page.fill('#lookupPhone', '+91 98765 43210');
    await page.click('#lookupSubmit');
    await page.waitForFunction(() => !document.getElementById('rsvpTicket').hidden, null, { timeout: 8000 }).catch(async (e) => {
      throw new Error('lookup did not show ticket; lookupMsg=' + JSON.stringify(await page.innerText('#lookupMsg')) + ' errs=' + JSON.stringify(await page.locator('#lookupForm .field-error').allInnerTexts()));
    });
    ok('find-my-reservation (reference + phone) works');
    await page.click('#tkEdit'); await page.selectOption('#rsvpGuests', '2'); await page.check('input[name=events][value=engagement]', { force: true });
    assert.equal(await page.isDisabled('#rsvpPhone'), true);
    await page.click('#rsvpSubmit'); await page.waitForSelector('#rsvpTicket:not([hidden])');
    assert.match(await page.innerText('#rsvpTicket'), /Reservation Updated[\s\S]*2 guests/);
    const upd = await pool.query('select guest_count, engagement_selected, reception_selected from public.rsvps');
    assert.deepEqual(upd.rows[0], { guest_count: 2, engagement_selected: true, reception_selected: false });
    ok('guest can update their RSVP');

    /* ---------- 3. wishes ---------- */
    console.log('Wishes');
    await page.evaluate(() => document.getElementById('wishes').scrollIntoView());
    await page.fill('#wishName', 'Mary Thomas'); await page.fill('#wishText', 'May God bless you both <b>always</b>!');
    await sleep(3000);
    await page.dblclick('#wishSubmit');
    await page.waitForFunction(() => /Thank you, Mary Thomas/.test(document.getElementById('wishMsg').textContent), null, { timeout: 8000 });
    const w = await pool.query('select * from public.wishes');
    assert.equal(w.rowCount, 1); assert.equal(w.rows[0].approved, false); assert.ok(!/[<>]/.test(w.rows[0].message));
    ok('wish saved once, awaiting approval, markup stripped');
    assert.equal(await page.locator('.wish-card').count(), 0);
    ok('unapproved wish is not shown publicly');

    /* ---------- 4. staff scans the QR with a camera ---------- */
    console.log('Admin / QR check-in');
    // fake camera: a video of the guest's real QR code
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', TMP + '/qr.png', '-vf', 'scale=640:640:flags=neighbor,pad=1280:720:320:40:white,format=yuvj420p', '-t', '2', '-r', '10', '-c:v', 'mjpeg', TMP + '/qr.mjpeg']);
    const camBrowser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + TMP + '/qr.mjpeg'] });
    const sctx = await camBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
    const staff = await sctx.newPage(); watch(staff, 'staff');
    await staff.goto(base + '/admin/');
    await staff.waitForSelector('#loginView:not([hidden])');
    await staff.fill('#loginName', 'Gate Staff'); await staff.fill('#loginCode', 'wrong-code-wrong');
    await staff.click('#loginBtn'); await staff.waitForFunction(() => /not correct/i.test(document.getElementById('loginMsg').textContent));
    ok('wrong access code rejected');
    await staff.fill('#loginCode', ENV.STAFF_PASSWORD); await staff.click('#loginBtn');
    await staff.waitForSelector('#appView:not([hidden])');
    assert.equal(await staff.isVisible('.tab[data-tab=wishes]'), false);
    assert.equal(await staff.isVisible('#exportBtn'), false);
    ok('staff sign in; admin-only tabs/buttons are hidden');
    const cookies = await sctx.cookies(); const sess = cookies.find(c => c.name === 'jb_session');
    assert.ok(sess.httpOnly && sess.sameSite === 'Strict'); ok('session cookie is HttpOnly + SameSite=Strict');
    assert.equal(await staff.evaluate(() => typeof document.cookie === 'string' && !document.cookie.includes('jb_session')), true);
    await staff.click('.seg-btn[data-event=engagement]');
    await staff.click('#scanToggle');
    await staff.waitForSelector('#scanResult:not([hidden])', { timeout: 15000 });
    assert.match(await staff.innerText('#scanResult'), /Checked in[\s\S]*Test Guest/);
    const ci = await pool.query('select event_type, checked_in_by, guests_arrived from public.checkins');
    assert.equal(ci.rowCount, 1); assert.equal(ci.rows[0].event_type, 'engagement'); assert.match(ci.rows[0].checked_in_by, /Gate Staff \(staff\)/); assert.equal(ci.rows[0].guests_arrived, 2);
    ok('camera scan of the guest QR checked them in (persisted in Postgres, attributed to staff)');
    await staff.screenshot({ path: SHOTS + '/staff-checkin.png' });
    await staff.waitForFunction(() => /Already checked in/i.test(document.getElementById('scanResult').textContent), null, { timeout: 15000 });
    assert.equal((await pool.query('select 1 from public.checkins')).rowCount, 1);
    ok('scanning again shows “already checked in” and does not double-count');
    await staff.click('#scanToggle');
    // reception: guest only registered for engagement
    await staff.click('.seg-btn[data-event=reception]');
    await staff.fill('#quickQ', ref); await staff.click('#quickForm button');
    await staff.waitForSelector('#quickResults .g-card');
    await staff.click('#quickResults .g-card .btn.primary');
    await staff.waitForFunction(() => /Not registered for Reception/i.test(document.getElementById('scanResult').textContent));
    ok('manual search + check-in warns when the guest did not RSVP for that event');
    await camBrowser.close();

    /* ---------- 5. admin dashboard ---------- */
    const actx = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
    const admin = await actx.newPage(); watch(admin, 'admin');
    await admin.goto(base + '/admin/'); await admin.fill('#loginCode', ENV.ADMIN_PASSWORD); await admin.click('#loginBtn');
    await admin.waitForSelector('#appView:not([hidden])');
    await admin.click('.tab[data-tab=overview]');
    await admin.waitForSelector('#overview .stat');
    const ov = await admin.innerText('#overview');
    assert.match(ov, /Expected guests/i); assert.match(ov, /Engagement/i); assert.match(ov, /Reception/i);
    await admin.screenshot({ path: SHOTS + '/admin-overview.png' });
    ok('overview shows per-event attendee counts');
    await admin.click('.tab[data-tab=wishes]'); await admin.waitForSelector('#wishAdminList .g-card');
    assert.match(await admin.innerText('#wishAdminList'), /Mary Thomas/);
    await admin.click('#wishAdminList .btn.primary');
    await admin.waitForFunction(() => /Nothing here/.test(document.getElementById('wishAdminList').textContent));
    assert.equal((await pool.query('select approved from public.wishes')).rows[0].approved, true);
    ok('admin approves the wish');
    await page.reload(); await openInvite(page); await page.evaluate(() => document.getElementById('wishes').scrollIntoView());
    await page.waitForSelector('.wish-card', { timeout: 8000 });
    const card = await page.innerText('.wish-card'); assert.match(card, /Mary Thomas/); assert.match(card, /always/);
    assert.equal(await page.locator('.wish-card b').count(), 0);
    ok('approved wish now appears on the invitation as a card (name, message, date)');
    await page.screenshot({ path: SHOTS + '/wishes-mobile.png' });
    await admin.click('.tab[data-tab=guests]'); await admin.waitForSelector('#guestList .g-card');
    await admin.screenshot({ path: SHOTS + '/admin-guests.png' });
    const [csv] = await Promise.all([admin.waitForEvent('download'), admin.click('#exportBtn')]);
    const csvText = fs.readFileSync(await csv.path(), 'utf8'); assert.match(csvText, /Test Guest/); assert.match(csvText, /Engagement check-in/);
    ok('admin exports CSV');
    assert.ok(!errors.length, 'console/page errors:\n' + errors.join('\n'));
    ok('no JavaScript errors on guest, staff or admin pages');
    console.log(`\nE2E: ${passed} checks passed`);
  } catch (e) {
    console.error('\nE2E FAILED:', e.message); console.error(srv.log().slice(-800));
    process.exitCode = 1;
  } finally {
    await browser.close(); await pool.end(); srv.stop();
  }
})();
