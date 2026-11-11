/* ============================================================
   JIMSON & BISMY — ENGAGEMENT INVITATION
   (opening, hero, reveal, countdown, music, gallery lightbox)
   RSVP / wishes live in forms.js
   ============================================================ */

/* ---------- CONFIGURATION (edit here) ---------- */
const CONFIG = {
  // Countdown target: 23 January 2027, 4:00 PM India time (Asia/Kolkata, UTC+05:30).
  // An absolute instant, so every visitor sees the same countdown regardless of their own timezone.
  eventDate: '2027-01-23T16:00:00+05:30',

  // Background music file. Replace the file or change the URL to use a different track.
  musicUrl: 'assets/song.mp3',
  musicVolume: 0.55
};

document.addEventListener('DOMContentLoaded', () => {

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- OPEN INVITATION -> HERO TRANSITION ---------- */
  const openSection  = document.getElementById('open');
  const openBtn      = document.getElementById('openBtn');
  const openingVideo = document.getElementById('openingVideo');
  const heroVideo    = document.getElementById('heroVideo');

  let opened = false;
  let heroPrimed = false;
  let heroStarted = false;

  function showHeroVideo(){
    heroStarted = true;
    heroVideo.style.opacity = '1';
  }

  function primeHeroVideo(){
    if (heroPrimed) return;
    heroPrimed = true;
    heroVideo.muted = true;
    heroVideo.preload = 'auto';
    try { heroVideo.load(); } catch (e) {}
    const p = heroVideo.play();
    if (p && typeof p.then === 'function'){
      p.then(showHeroVideo).catch(() => {
        // Autoplay blocked: the poster stays visible; retry on the first touch/scroll.
        const retry = () => {
          const q = heroVideo.play();
          if (q && q.then) q.then(showHeroVideo).catch(() => {});
        };
        window.addEventListener('scroll', retry, { once:true, passive:true });
        window.addEventListener('touchstart', retry, { once:true, passive:true });
      });
    }
  }
  heroVideo.addEventListener('error', () => { heroVideo.style.opacity = '0'; });

  // Pause the hero video while it is off-screen (saves battery on phones).
  if ('IntersectionObserver' in window){
    new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (!heroStarted) return;
        if (en.isIntersecting){ const q = heroVideo.play(); if (q && q.catch) q.catch(() => {}); }
        else heroVideo.pause();
      });
    }, { threshold: 0.05 }).observe(document.getElementById('hero'));
  }

  function finishOpening(){
    primeHeroVideo();
    openSection.classList.add('opened');           // 1.2s cross-fade into the hero (no black frame)
    setTimeout(() => {
      openSection.style.display = 'none';
      document.body.style.removeProperty('overflow');
      // Jump (not glide) to the target: guests arriving from a confirmation link / #rsvp go straight
      // to that section (set by forms.js); everyone else lands on the hero.
      const goto = window.__jbGoto && document.getElementById(window.__jbGoto);
      const root = document.documentElement;
      root.style.scrollBehavior = 'auto';
      window.scrollTo(0, 0);
      (goto || document.getElementById('hero')).scrollIntoView({ behavior: 'auto' });
      requestAnimationFrame(() => { root.style.removeProperty('scroll-behavior'); });
    }, reduceMotion ? 50 : 1200);
  }

  function openInvitation(){
    if (opened) return;
    opened = true;
    openBtn.setAttribute('aria-disabled', 'true');

    // 1. Fade out the HTML text + button (and the dark scrim) so the video plays clean.
    openSection.classList.add('revealing');

    let settled = false, startTimer = null, endTimer = null;
    const proceed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer); clearTimeout(endTimer);
      finishOpening();
    };

    // 2. Play the ribbon video from the very beginning.
    openingVideo.muted = true;
    openingVideo.defaultMuted = true;
    openingVideo.playsInline = true;
    try { openingVideo.currentTime = 0; } catch (e) {}

    // 3. Hand over to the hero ONLY on the real "ended" event (timers are just safety nets).
    openingVideo.addEventListener('ended', proceed, { once:true });
    // "error" fires on the <source> child (does not bubble), so listen in the capture phase.
    openingVideo.addEventListener('error', proceed, { capture:true, once:true });

    openingVideo.addEventListener('playing', () => {
      openingVideo.classList.add('on');            // reveal video over the identical poster frame
      clearTimeout(startTimer);
      const dur = isFinite(openingVideo.duration) && openingVideo.duration > 0 ? openingVideo.duration : 8;
      clearTimeout(endTimer);
      endTimer = setTimeout(proceed, (dur + 3) * 1000);   // stalled-network safety net
      setTimeout(primeHeroVideo, Math.max(0, (dur - 4.5)) * 1000); // warm up hero before it is needed
    }, { once:true });

    // Never started playing (unsupported/blocked/missing file or a very slow network): continue to the hero
    // instead of leaving the guest on a frozen poster.
    startTimer = setTimeout(proceed, 6000);
    const watchdog = setInterval(() => {
      if (settled) { clearInterval(watchdog); return; }
      if (openingVideo.networkState === 3 /* NETWORK_NO_SOURCE */) { clearInterval(watchdog); proceed(); }
    }, 400);

    const playPromise = openingVideo.play();
    if (playPromise && typeof playPromise.catch === 'function'){
      playPromise.catch(() => { setTimeout(proceed, 700); });
    }
  }

  // Warm the opening video once the page is idle (the poster is already on screen).
  const warmOpening = () => {
    try { openingVideo.preload = 'auto'; openingVideo.load(); } catch (e) {}
  };
  window.addEventListener('load', () => {
    if ('requestIdleCallback' in window) requestIdleCallback(warmOpening, { timeout: 2500 });
    else setTimeout(warmOpening, 1200);
  }, { once:true });

  // Lock scroll until opened (mobile-first single-gesture invitation)
  document.body.style.overflow = 'hidden';
  openBtn.addEventListener('click', openInvitation);

  /* ---------- BACKGROUND MUSIC ---------- */
  const bgMusic     = document.getElementById('bgMusic');
  const musicToggle = document.getElementById('musicToggle');
  let musicStarted = false;
  let resumeAfterHidden = false;

  function setPlayingUi(on){
    musicToggle.classList.toggle('playing', on);
    musicToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function startMusic(){
    if (musicStarted) return;
    musicStarted = true;
    if (CONFIG.musicUrl && bgMusic.getAttribute('src') !== CONFIG.musicUrl) bgMusic.src = CONFIG.musicUrl;
    bgMusic.volume = CONFIG.musicVolume;
    const p = bgMusic.play();
    if (p && p.then) p.then(() => setPlayingUi(true)).catch(() => { /* blocked: user can press the toggle */ });
    musicToggle.classList.add('show');
  }

  musicToggle.addEventListener('click', () => {
    if (bgMusic.paused){
      const p = bgMusic.play();
      if (p && p.then) p.then(() => setPlayingUi(true)).catch(() => {});
    } else {
      bgMusic.pause();
      setPlayingUi(false);
    }
  });
  bgMusic.addEventListener('error', () => { musicToggle.classList.remove('show'); });

  // Respect the guest: pause when the tab/app goes to the background, resume on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden){
      resumeAfterHidden = !bgMusic.paused;
      if (resumeAfterHidden) bgMusic.pause();
    } else if (resumeAfterHidden){
      resumeAfterHidden = false;
      const p = bgMusic.play(); if (p && p.catch) p.catch(() => {});
    }
  });

  // Starts the moment the guest opens the invitation (a user gesture, so browsers allow it).
  openBtn.addEventListener('click', startMusic);

  /* ---------- SCROLL REVEAL ---------- */
  const revealEls = document.querySelectorAll('.reveal, .moment');
  if ('IntersectionObserver' in window){
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting){
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -30px 0px' });
    revealEls.forEach(el => io.observe(el));
  } else {
    revealEls.forEach(el => el.classList.add('in'));
  }

  /* ---------- LIVE COUNTDOWN (timezone-aware) ---------- */
  const eventTime = new Date(CONFIG.eventDate).getTime();
  const cdDays  = document.getElementById('cd-days');
  const cdHours = document.getElementById('cd-hours');
  const cdMins  = document.getElementById('cd-mins');
  const cdSecs  = document.getElementById('cd-secs');
  const cdHead  = document.getElementById('cdHeading');
  const cdDate  = document.getElementById('cdDate');
  const cdDone  = document.getElementById('cdDone');
  const pad = n => String(n).padStart(2, '0');
  let cdTimer = null;

  function updateCountdown(){
    let diff = eventTime - Date.now();
    if (!isFinite(diff)) return;
    if (diff <= 0){
      // Stop at zero and switch to a celebration message.
      diff = 0;
      if (cdTimer){ clearInterval(cdTimer); cdTimer = null; }
      const sinceMs = Date.now() - eventTime;
      cdHead.textContent = sinceMs < 24 * 3600 * 1000 ? 'Today We Celebrate' : 'Thank You For Celebrating With Us';
      cdDone.textContent = sinceMs < 24 * 3600 * 1000
        ? 'The celebration has begun! Thank you for being a part of our special day.'
        : 'Thank you for sharing our special day. Your love and blessings meant the world to us.';
      cdDone.hidden = false;
      cdDate.hidden = true;
    }
    const days  = Math.floor(diff / 86400000);
    const hours = Math.floor((diff / 3600000) % 24);
    const mins  = Math.floor((diff / 60000) % 60);
    const secs  = Math.floor((diff / 1000) % 60);
    cdDays.textContent  = pad(days);
    cdHours.textContent = pad(hours);
    cdMins.textContent  = pad(mins);
    cdSecs.textContent  = pad(secs);
  }
  updateCountdown();
  if (eventTime > Date.now()) cdTimer = setInterval(updateCountdown, 1000);

  /* ---------- GALLERY LIGHTBOX ---------- */
  const figs   = Array.from(document.querySelectorAll('#moments .moment'));
  const lb     = document.getElementById('lightbox');
  const lbImg  = document.getElementById('lbImg');
  const lbCnt  = document.getElementById('lbCount');
  const lbClose= document.getElementById('lbClose');
  const lbPrev = document.getElementById('lbPrev');
  const lbNext = document.getElementById('lbNext');
  let lbIndex = 0, lbOpener = null;

  function lbShow(i){
    lbIndex = (i + figs.length) % figs.length;
    const fig = figs[lbIndex];
    const thumb = fig.querySelector('img');
    lbImg.src = fig.dataset.full;
    lbImg.alt = thumb ? thumb.alt : '';
    lbCnt.textContent = (lbIndex + 1) + ' / ' + figs.length;
    // warm the neighbour
    const n = new Image(); n.src = figs[(lbIndex + 1) % figs.length].dataset.full;
  }
  function lbOpen(i){
    lbOpener = document.activeElement;
    lbShow(i);
    lb.hidden = false;
    document.documentElement.classList.add('lb-open');
    requestAnimationFrame(() => lb.classList.add('show'));
    lbClose.focus();
  }
  function lbHide(){
    lb.classList.remove('show');
    document.documentElement.classList.remove('lb-open');
    setTimeout(() => { lb.hidden = true; lbImg.removeAttribute('src'); }, reduceMotion ? 0 : 320);
    if (lbOpener && lbOpener.focus) lbOpener.focus();
  }
  figs.forEach((fig, i) => {
    fig.addEventListener('click', () => lbOpen(i));
    fig.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); lbOpen(i); } });
  });
  lbClose.addEventListener('click', lbHide);
  lbPrev.addEventListener('click', (e) => { e.stopPropagation(); lbShow(lbIndex - 1); });
  lbNext.addEventListener('click', (e) => { e.stopPropagation(); lbShow(lbIndex + 1); });
  lb.addEventListener('click', (e) => { if (e.target === lb) lbHide(); });
  document.addEventListener('keydown', (e) => {
    if (lb.hidden) return;
    if (e.key === 'Escape') lbHide();
    else if (e.key === 'ArrowLeft') lbShow(lbIndex - 1);
    else if (e.key === 'ArrowRight') lbShow(lbIndex + 1);
    else if (e.key === 'Tab'){
      const f = [lbClose, lbPrev, lbNext];
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  });
  let tx = 0;
  lb.addEventListener('touchstart', (e) => { tx = e.changedTouches[0].clientX; }, { passive:true });
  lb.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 50) lbShow(lbIndex + (dx < 0 ? 1 : -1));
  }, { passive:true });
});
