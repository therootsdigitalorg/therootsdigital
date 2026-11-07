'use strict';
// Configuration: .env file (optional) + process environment. No dependencies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const env = (k, d = '') => process.env[k] ?? d;
const flag = (k, d) => { const v = env(k, d ? '1' : '0').toLowerCase(); return v === '1' || v === 'true' || v === 'yes' || v === 'on'; };

const production = env('NODE_ENV') === 'production';
const serverless = !!process.env.VERCEL;
const dataDir = path.join(ROOT, 'data');
if (!serverless) fs.mkdirSync(dataDir, { recursive: true });

// Encryption key for secrets at rest (webhook signing secrets, 2FA seeds). Generated once.
const keyFile = path.join(dataDir, '.app-key');
let appKey = env('APP_ENCRYPTION_KEY');
if (!appKey && !serverless) {
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  appKey = fs.readFileSync(keyFile, 'utf8').trim();
}

// POSTGRES_URL is the pooled address added by the Vercel + Supabase integration.
const databaseUrl = env('DATABASE_URL') || env('POSTGRES_URL');
const vercelHost = env('VERCEL_PROJECT_PRODUCTION_URL') || env('VERCEL_URL');
const publicUrl = (env('PUBLIC_URL') || (vercelHost ? 'https://' + vercelHost : 'http://localhost:' + env('PORT', '3000'))).replace(/\/$/, '');

/** Settings a serverless deployment cannot generate for itself (it has no writable disk). */
function setupProblems() {
  if (!serverless) return [];
  const missing = [];
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (!/^[0-9a-f]{64}$/i.test(appKey || '')) missing.push('APP_ENCRYPTION_KEY');
  return missing;
}

module.exports = {
  ROOT, production, serverless, setupProblems,
  databaseUrl, databaseSsl: env('DATABASE_SSL'), databaseCa: env('DATABASE_CA_CERT').replace(/\\n/g, '\n'),
  cronSecret: env('CRON_SECRET'),
  port: +env('PORT', '3000'),
  publicUrl,
  dbPath: path.resolve(ROOT, env('DB_PATH', './data/digitalhub.db')),
  appKey: Buffer.from(appKey || '', 'hex'),
  // The store owner's sign-in. Created (or re-linked) on every start.
  adminEmail: env('ADMIN_EMAIL', 'owner@digitalhub.local'),
  businessName: env('BUSINESS_NAME', 'My Store'),
  adminPassword: env('ADMIN_PASSWORD'),
  seedDemo: flag('SEED_DEMO', !production),
  sandboxDayMs: Math.max(5000, +env('SANDBOX_DAY_MS', '60000')),
  allowPrivateWebhooks: !production && flag('ALLOW_PRIVATE_WEBHOOKS', true),
  livePayments: flag('LIVE_PAYMENTS', false),
  secureCookies: publicUrl.startsWith('https://'),
  // Cash App Pay Partner API credentials (server-side only). Sandbox and production are separate credential sets.
  cashapp: {
    region: env('CASHAPP_REGION', 'PDX'),
    userAgent: 'DigitalHub/1.0',
    sandbox: { clientId: env('CASHAPP_SANDBOX_CLIENT_ID'), keyId: env('CASHAPP_SANDBOX_API_KEY_ID'), keySecret: env('CASHAPP_SANDBOX_API_KEY_SECRET'), webhookSecret: env('CASHAPP_SANDBOX_WEBHOOK_SECRET'), base: env('CASHAPP_SANDBOX_BASE') },
    live: { clientId: env('CASHAPP_CLIENT_ID'), keyId: env('CASHAPP_API_KEY_ID'), keySecret: env('CASHAPP_API_KEY_SECRET'), webhookSecret: env('CASHAPP_WEBHOOK_SECRET'), base: env('CASHAPP_BASE') },
  },
};
