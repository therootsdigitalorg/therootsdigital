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

/** Staff 2FA for privileged actions: REQUIRE_STAFF_MFA=1/0 in the environment wins; otherwise the Super Admin setting
    (Platform rules → "Require 2FA for staff", default off). Base mainnet production checks still require it. */
const staffMfaEnv = process.env.REQUIRE_STAFF_MFA;
module.exports = {
  ROOT, production, serverless, setupProblems,
  databaseUrl, databaseSsl: env('DATABASE_SSL'), databaseCa: env('DATABASE_CA_CERT').replace(/\\n/g, '\n'),
  supabaseUrl: env('SUPABASE_URL').replace(/\/$/, ''), supabaseAnonKey: env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY'), // publishable key replaces the legacy anon key
  cronSecret: env('CRON_SECRET'),
  port: +env('PORT', '3000'),
  publicUrl,
  dbPath: path.resolve(ROOT, env('DB_PATH', './data/digitalhub.db')),
  appKey: Buffer.from(appKey || '', 'hex'),
  adminEmail: env('ADMIN_EMAIL', 'admin@digitalhub.local'),
  adminPassword: env('ADMIN_PASSWORD'),
  seedDemo: flag('SEED_DEMO', !production),
  sandboxDayMs: Math.max(5000, +env('SANDBOX_DAY_MS', '60000')),
  allowPrivateWebhooks: !production && flag('ALLOW_PRIVATE_WEBHOOKS', true),
  livePayments: flag('LIVE_PAYMENTS', false),
  secureCookies: publicUrl.startsWith('https://'),
  binance: { base: env('BINANCE_PAY_BASE', 'https://bpay.binanceapi.com'), apiKey: env('BINANCE_PAY_API_KEY'), secretKey: env('BINANCE_PAY_SECRET_KEY'), publicKey: env('BINANCE_PAY_PUBLIC_KEY').replace(/\\n/g, '\n') },
  coinbase: { base: env('COINBASE_API_BASE', 'https://api.commerce.coinbase.com'), apiKey: env('COINBASE_API_KEY'), webhookSecret: env('COINBASE_WEBHOOK_SECRET') },
};

Object.defineProperty(module.exports, 'requireStaffMfa', { enumerable: true, get() {
  if (staffMfaEnv !== undefined && staffMfaEnv !== '') return flag('REQUIRE_STAFF_MFA', false);
  try { return !!require('./core').platform().staffMfa; } catch { return false; }
} });
Object.defineProperty(module.exports, 'staffMfaSource', { get: () => staffMfaEnv !== undefined && staffMfaEnv !== '' ? 'environment (REQUIRE_STAFF_MFA)' : 'Super Admin setting' });
