# Jimson & Bismy — Engagement Invitation

Cinematic portrait-first invitation (cloned from the reference invitation) plus a working backend:
RSVP / guest booking, guest wishes with moderation, QR check-in, and a secure admin dashboard.

```
public/            static site (served as-is)      api/[...path].js   single serverless API entry
  index.html         invitation (CSS inline)       lib/               validation, security, rate limiting, handlers
  script.js          opening, hero, countdown,     supabase/migrations/0001_init.sql   database schema + RLS
                     music, lightbox               scripts/           migrate.js, inject-site-url.js
  forms.js           RSVP, ticket + QR, wishes     server.js          local dev server (same API as production)
  admin/             /admin/ staff + admin UI      tests/             api.test.js (Postgres), e2e.js (browser)
  assets/            videos, posters, photos, music, OG image
```

## 1. Set up Supabase (5 min)
1. Create a project at supabase.com. Open **SQL Editor**, paste `supabase/migrations/0001_init.sql`, run it
   (or `DATABASE_URL=... npm run migrate`). It is safe to re-run.
2. **Project Settings → Database → Connection string → Transaction pooler** → copy the URI → this is `DATABASE_URL`.
3. Row-Level Security is on for every table with a deny-all policy for `anon`/`authenticated`, so the public Supabase API
   can never read guest data. Only this site's server (using `DATABASE_URL`) touches the database. **Do not put the
   service-role key or `DATABASE_URL` in any frontend file.**

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)
| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Supabase pooler connection string |
| `APP_SECRET` | yes | 32+ random chars (`openssl rand -base64 48`). Signs QR tokens, confirmation links, sessions. **Changing it invalidates all issued QR codes.** |
| `ADMIN_PASSWORD` | yes | Admin access code (10+ chars): everything |
| `STAFF_PASSWORD` | yes | Gate-staff code (10+ chars): check-in + guest search only |
| `WISHES_AUTO_APPROVE` | no | `true` publishes wishes immediately (default `false` = moderated) |
| `SITE_URL` | no* | e.g. `https://yourdomain.com`; *Vercel's production URL is used if unset |

## 3. Deploy
Push the folder to GitHub → import in Vercel (no framework preset needed; `vercel.json` sets everything). The build step
(`scripts/inject-site-url.js`) writes your absolute URL into `og:url`, `og:image` and the canonical link — **WhatsApp
previews need this**, so set `SITE_URL` once you have the final domain and redeploy. After deploying, open `/api/health`
(should return `{"ok":true}`), then test an RSVP.

Local run: `cp .env.example .env`, fill it, `npm install && npm run migrate && npm run dev` → http://localhost:3000
(local Postgres: add `PGSSL=disable`).

## 4. Using it
* **Guests**: RSVP section → ticket with booking reference + QR (Save QR / copy private link). "Already reserved?" finds a booking
  by reference + phone; guests can update or cancel until they check in.
* **Admin**: `/admin/` (not linked anywhere; `noindex`). Sign in with the admin or staff code.
  * *Staff*: Check-in tab (camera QR scanner, or search by name / reference / phone), guest list, overview.
  * *Admin* also: edit/delete reservations, undo check-ins, moderate wishes, export CSV.
* Scanner needs HTTPS (Vercel provides it) and camera permission. Uses the browser's native QR detector, with a bundled
  jsQR fallback for iPhone Safari.
* Give the check-in desk the **staff** code; keep the admin code to yourselves.

## 5. Security notes
No credentials in frontend JS · admin session = HttpOnly, SameSite=Strict signed cookie · role checks on every endpoint ·
CSRF (JSON-only + origin check + custom header) · QR token is opaque (HMAC) and only its SHA-256 is stored; the QR can't edit a
booking (separate confirmation-link token) · phone numbers never returned publicly (masked) · all guest text rendered with
`textContent`, tags stripped server-side · honeypot + signed time-gate + link filter + Postgres-backed rate limits ·
CSV export neutralises spreadsheet formulas · CSP headers in `vercel.json`.
Known trade-off: a duplicate-phone error reveals that a number has RSVP'd.

## 6. Customising
* Dates, music file: top of `public/script.js` (`CONFIG`). Countdown target is `2027-01-23T16:00:00+05:30` (IST).
* Map links: `public/index.html` (`#engagementMapLink`, `#receptionMapLink`).
* Media: replace files in `public/assets/` (same names). Videos must be 9:16; they are always shown uncropped.
* **Music**: `assets/song.mp3` is carried over from the original site. Confirm it is licensed for your use, or replace it.
* Gallery photos carry the photographer's "Kalhara Weddings" watermark, left untouched.

## 7. Tests
`npm test` runs `tests/api.test.js` against a real Postgres (`TEST_DATABASE_URL`, default `postgresql://postgres@localhost:5433/jb_test`; run the migration first).
`tests/e2e.js` is a Playwright browser test (opening video, RSVP, QR decode, camera scan check-in, admin). It serves VP9
copies of the videos only because Playwright's Chromium lacks H.264; real browsers play the MP4s.
