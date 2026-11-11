#!/usr/bin/env node
/* Applies supabase/migrations/*.sql to DATABASE_URL (idempotent).
   Usage:  DATABASE_URL=postgres://... node scripts/migrate.js            */
const fs = require('fs');
const path = require('path');
const { getPool } = require('../lib/db');

(async () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const pool = getPool();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('commit');
      console.log('applied', f);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      console.error('FAILED', f, '-', e.message);
      process.exitCode = 1;
      break;
    } finally { client.release(); }
  }
  await pool.end();
})();
