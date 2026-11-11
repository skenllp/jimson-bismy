'use strict';
const { query } = require('./db');
const { HttpError, sha256 } = require('./http');

/* Fixed-window limiter stored in Postgres, so it works across serverless instances.
   hit('wish', ip, 5, 3600) allows 5 submissions per hour per client. */
async function hit(bucket, subject, limit, windowSeconds) {
  const key = sha256(`${bucket}:${subject}`);
  const { rows } = await query(
    `insert into public.rate_limits as r (key, window_start, hits) values ($1, now(), 1)
     on conflict (key) do update set
       hits = case when r.window_start <= now() - ($2::int * interval '1 second') then 1 else r.hits + 1 end,
       window_start = case when r.window_start <= now() - ($2::int * interval '1 second') then now() else r.window_start end
     returning hits,
       greatest(1, ceil(extract(epoch from (r.window_start + ($2::int * interval '1 second') - now())))::int) as retry_after`,
    [key, windowSeconds]
  );
  if (Math.random() < 0.02) query(`delete from public.rate_limits where window_start < now() - interval '2 days'`).catch(() => {});
  const { hits, retry_after } = rows[0];
  return { allowed: hits <= limit, retryAfter: retry_after, hits };
}

async function enforce(bucket, subject, limit, windowSeconds, message) {
  const r = await hit(bucket, subject, limit, windowSeconds);
  if (!r.allowed) {
    throw new HttpError(429, 'rate_limited',
      message || 'Too many attempts. Please wait a little while and try again.',
      { retryAfter: r.retryAfter });
  }
}

module.exports = { hit, enforce };
