'use strict';
/* First-run setup: super admin + optional demo merchants.
   No payments, balances or wallets are fabricated: test mode is the real Base Sepolia testnet, so demo
   merchants must verify a receiving wallet with MetaMask and receive real test USDC before anything shows up. */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./db');
const U = require('./util');
const core = require('./core');

const genPassword = () => U.rid(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ') + '-' + U.rid(6, 'abcdefghjkmnpqrstuvwxyz') + '-' + U.rid(4, '23456789');

async function ensureSeed() {
  if (store.list('users', {}, { limit: 1 }).length) { require('./business').ensure(); return; }
  const auth = require('./auth');
  const notes = [];
  if (config.production && !config.adminPassword) throw new U.HttpError(503, 'setup_incomplete', 'Server setup incomplete. Add ADMIN_PASSWORD in Vercel to create the first super admin.');
  const adminPassword = config.adminPassword || genPassword();
  auth.createUser({ email: config.adminEmail, name: 'Platform Owner', password: adminPassword, kind: 'staff', role: 'super_admin' });
  notes.push(`Super admin   ${config.adminEmail}   password: ${config.adminPassword ? '(from ADMIN_PASSWORD)' : adminPassword}`);

  if (config.seedDemo && config.multiMerchant) {
    const { issueKey, ensurePublishable } = require('./routes/merchant');
    const m = core.newMerchant({ name: 'Northwind Apparel Co.', legal_name: 'Northwind Apparel Co. LLC', country: 'US', website: 'northwind-apparel.example', support_email: 'help@northwind-apparel.example' });
    Object.assign(m, { status: 'approved', risk: 'low' });
    m.kyb = { submitted: true, submitted_at: Date.now(), business: { legal_name: m.legal_name, registration_number: 'DE-7781234', incorporation_country: 'US', address: '100 Harbor St, Austin TX', website: m.website, description: 'Outdoor apparel online store', monthly_volume_usd: 80000 },
      owners: [{ name: 'Abdul Rahman Ansari', pct: 70, idStatus: 'verified' }, { name: 'Dana Holt', pct: 30, idStatus: 'verified' }], checks: { registration: true, owners: true, website: true, sanctions: true, bank: true }, aml: { status: 'clear', at: Date.now() } };
    store.put('merchants', m);
    const pw = genPassword();
    auth.createUser({ email: 'owner@northwind.test', name: 'Abdul Rahman Ansari', password: pw, kind: 'merchant', role: 'owner', merchant_id: m.id });
    notes.push(`Demo merchant owner@northwind.test   password: ${pw}`);
    ensurePublishable(m, 'test', 'seed');
    const { secret } = issueKey(m, 'test', { name: 'Demo server key', scopes: ['*'] }, 'seed');
    notes.push(`Demo test secret key: ${secret}`);
    core.createLink(m, 'test', { amount: 1500, currency: 'USD', description: 'Trail running socks (Base Sepolia test)', reusable: true, payment_methods: ['usdc'] }, 'seed');
    notes.push('Next: sign in as the merchant → Receiving wallet → verify your MetaMask address → open the payment link.');

    const k = core.newMerchant({ name: 'Indus Crafts', legal_name: 'Indus Crafts (Pvt) Ltd', country: 'PK', website: 'induscrafts.example', support_email: 'accounts@induscrafts.example' });
    k.kyb = { ...k.kyb, submitted: true, submitted_at: Date.now(), business: { legal_name: k.legal_name, registration_number: 'SECP-0098812', incorporation_country: 'PK', address: 'Gulberg III, Lahore', website: k.website, description: 'Handmade textiles, export', monthly_volume_usd: 15000 },
      owners: [{ name: 'Hira Baloch', pct: 60, idStatus: 'pending' }, { name: 'Kamran Malik', pct: 40, idStatus: 'pending' }] };
    store.put('merchants', k);
    auth.createUser({ email: 'owner@induscrafts.test', name: 'Hira Baloch', password: genPassword(), kind: 'merchant', role: 'owner', merchant_id: k.id });
  }
  core.audit('system', 'platform.initialized', 'platform', 'First-run setup');
  require('./business').ensure();
  const text = `Digital Hub — first-run credentials (${new Date().toISOString()})\n\n${notes.join('\n')}\n\nChange these passwords after signing in. Delete this file when done.\n`;
  if (!config.production) fs.writeFileSync(path.join(path.dirname(config.dbPath), 'first-run-credentials.txt'), text, { mode: 0o600 });
  if (!config.production) console.log('\n' + text);
}

module.exports = { ensureSeed };
