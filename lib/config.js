'use strict';
/* All configuration comes from environment variables (see .env.example). Nothing secret is ever sent to the browser. */

class ConfigError extends Error {}

function get(name, { required = false, min = 0 } = {}) {
  const v = process.env[name];
  if ((v === undefined || v === '') && required) throw new ConfigError(`Missing environment variable ${name}`);
  if (v && min && v.length < min) throw new ConfigError(`${name} must be at least ${min} characters`);
  return v || '';
}

module.exports = {
  ConfigError,
  databaseUrl: () => get('DATABASE_URL', { required: true }),
  // Master secret used to derive QR tokens, confirmation links, form tokens and admin session signatures.
  appSecret: () => get('APP_SECRET', { required: true, min: 32 }),
  adminCode: () => get('ADMIN_PASSWORD', { min: 10 }),
  staffCode: () => get('STAFF_PASSWORD', { min: 10 }),
  // Wishes are hidden until approved in the dashboard. Set WISHES_AUTO_APPROVE=true to publish immediately.
  wishesAutoApprove: () => process.env.WISHES_AUTO_APPROVE === 'true',
  maxGuestsPerRsvp: 10,
  sessionHours: 12
};
