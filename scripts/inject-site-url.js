#!/usr/bin/env node
/* Build step (runs on Vercel via `npm run build`):
   replaces %%SITE_URL%% in public/index.html with the real production origin so that
   og:url, og:image and the canonical link are absolute URLs (required by WhatsApp). */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'index.html');

let site = (process.env.SITE_URL || '').trim();
if (!site && process.env.VERCEL_PROJECT_PRODUCTION_URL) site = 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL;
site = site.replace(/\/+$/, '');

if (!/^https:\/\/[^\s/]+$/.test(site)) {
  console.warn('[inject-site-url] SITE_URL is not set (expected e.g. https://jimson-bismy.com).');
  console.warn('[inject-site-url] og:image / og:url / canonical will NOT be absolute — WhatsApp previews will not work until it is set.');
  process.exit(process.env.REQUIRE_SITE_URL === 'true' ? 1 : 0);
}
const html = fs.readFileSync(file, 'utf8');
if (!html.includes('%%SITE_URL%%')) { console.log('[inject-site-url] already injected'); process.exit(0); }
fs.writeFileSync(file, html.split('%%SITE_URL%%').join(site));
console.log('[inject-site-url] set site URL to', site);
