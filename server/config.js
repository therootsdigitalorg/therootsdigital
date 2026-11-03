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
const dataDir = path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Encryption key for secrets at rest (webhook signing secrets, 2FA seeds). Generated once.
const keyFile = path.join(dataDir, '.app-key');
let appKey = env('APP_ENCRYPTION_KEY');
if (!appKey) {
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  appKey = fs.readFileSync(keyFile, 'utf8').trim();
}

module.exports = {
  ROOT, production,
  port: +env('PORT', '3000'),
  publicUrl: env('PUBLIC_URL', 'http://localhost:' + env('PORT', '3000')).replace(/\/$/, ''),
  dbPath: path.resolve(ROOT, env('DB_PATH', './data/digitalhub.db')),
  appKey: Buffer.from(appKey, 'hex'),
  adminEmail: env('ADMIN_EMAIL', 'admin@digitalhub.local'),
  adminPassword: env('ADMIN_PASSWORD'),
  seedDemo: flag('SEED_DEMO', true),
  sandboxDayMs: Math.max(5000, +env('SANDBOX_DAY_MS', '60000')),
  requireStaffMfa: production || flag('REQUIRE_STAFF_MFA', false),
  allowPrivateWebhooks: !production && flag('ALLOW_PRIVATE_WEBHOOKS', true),
  livePayments: flag('LIVE_PAYMENTS', false),
  secureCookies: env('PUBLIC_URL', '').startsWith('https://'),
  binance: { base: env('BINANCE_PAY_BASE', 'https://bpay.binanceapi.com'), apiKey: env('BINANCE_PAY_API_KEY'), secretKey: env('BINANCE_PAY_SECRET_KEY'), publicKey: env('BINANCE_PAY_PUBLIC_KEY').replace(/\\n/g, '\n') },
  coinbase: { base: env('COINBASE_API_BASE', 'https://api.commerce.coinbase.com'), apiKey: env('COINBASE_API_KEY'), webhookSecret: env('COINBASE_WEBHOOK_SECRET') },
};
