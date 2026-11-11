'use strict';
/* Starts the real server (server.js) against a real Postgres database for end-to-end tests. */
const { spawn } = require('child_process');
const { Pool } = require('pg');

const ENV = {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:5433/jb_test',
  PGSSL: 'disable',
  APP_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  ADMIN_PASSWORD: 'admin-test-code-1234',
  STAFF_PASSWORD: 'staff-test-code-1234',
  WISHES_AUTO_APPROVE: 'false'
};

async function resetDb() {
  const pool = new Pool({ connectionString: ENV.DATABASE_URL });
  await pool.query('truncate public.checkins, public.rsvps, public.wishes, public.rate_limits cascade');
  await pool.end();
}

async function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, ...ENV, ...extraEnv, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  return { base: `http://localhost:${port}`, stop: () => child.kill(), log: () => log };
}

function client(base, ip = '10.0.0.1') {
  const jar = {};
  async function call(method, path, body, headers = {}) {
    const h = { 'x-forwarded-for': ip, ...headers };
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    if (Object.keys(jar).length) h.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach(c => {
      const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/max-age=0/i.test(c)) delete jar[k]; else jar[k] = v;
    });
    const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text, headers: r.headers };
  }
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    patch: (p, b, h) => call('PATCH', p, b, h),
    del: (p, h) => call('DELETE', p, undefined, h),
    jar
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
module.exports = { ENV, resetDb, startServer, client, sleep };
