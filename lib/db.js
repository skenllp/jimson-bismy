'use strict';
const { Pool } = require('pg');
const config = require('./config');

let pool;

function buildPoolConfig() {
  const raw = config.databaseUrl();
  const url = new URL(raw);
  url.searchParams.delete('sslmode');           // we set SSL explicitly below
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(url.hostname) || url.hostname.startsWith('/');
  let ssl = false;
  if (!local && process.env.PGSSL !== 'disable') ssl = { rejectUnauthorized: false }; // Supabase pooler/direct hosts
  return {
    connectionString: url.toString(),
    ssl,
    max: Number(process.env.PG_POOL_MAX || 3),   // small pool: serverless friendly
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 10_000
  };
}

function getPool() {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
    pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  }
  return pool;
}

const query = (text, params) => getPool().query(text, params);

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, tx };
