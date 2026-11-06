'use strict';
/* Startup: super admin from ADMIN_EMAIL / ADMIN_PASSWORD, plus optional demo data generated
   through the real services (Cash App Pay simulator in test mode). */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./db');
const U = require('./util');
const core = require('./core');
const CA = require('./cashapp');

const genPassword = () => U.rid(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ') + '-' + U.rid(6, 'abcdefghjkmnpqrstuvwxyz') + '-' + U.rid(4, '23456789');
const CUSTOMERS = [['Maya Chen', 'maya.chen@example.com'], ['Liam Walker', 'liam.w@example.com'], ['Emma Davis', 'emma.davis@example.com'], ['Ethan Brooks', 'ethan.b@example.com'], ['Ayesha Khan', 'ayesha.k@example.com']];
const ITEMS = ['Merino crew sweater', 'Trail running jacket', 'Annual plan renewal', 'Team license (5 seats)', 'Gift card', 'Canvas weekender bag'];
const pick = a => a[Math.floor(Math.random() * a.length)];

/** Creates sandbox payments through the real checkout flow (local Cash App simulator only). */
async function samplePayments(m, n = 6) {
  if (!CA.simulated('test')) throw new U.HttpError(400, 'sandbox_only', 'Sample payments use the local simulator. With Cash App sandbox credentials, pay from a real checkout instead.');
  const made = [];
  for (let i = 0; i < n; i++) {
    const [name, email] = pick(CUSTOMERS), roll = Math.random();
    const amount = roll < 0.12 ? 7771 : Math.round((15 + Math.random() * Math.random() * 400) * 100); // 7771 = documented sandbox decline (insufficient funds)
    try {
      const s = core.createSession(core.merchant(m.id), 'test', { amount, currency: 'USD', description: pick(ITEMS) }, 'sandbox');
      const p = await core.startCashApp(s, { name, email });
      if (roll < 0.9) { CA.sim.decide(p.cashapp.request_id, roll > 0.04); await core.flushSimEvents(); await core.syncPayment(store.get('payments', p.id), { force: true }); }
      made.push(p.id);
    } catch { /* limits / velocity while sampling are fine */ }
  }
  await core.flushSimEvents();
  return made;
}

/** Makes sure ADMIN_EMAIL is a platform super admin. Runs on every start, so changing ADMIN_EMAIL works on an existing database. */
function ensureAdmin() {
  const email = String(config.adminEmail || '').trim().toLowerCase(), pw = config.adminPassword;
  if (!email || !pw) return;
  const auth = require('./auth');
  const u = store.byKey('users', email);
  if (u?.kind === 'staff') return;
  if (!u) { auth.createUser({ email, name: 'Platform Owner', password: pw, kind: 'staff', role: 'super_admin' }); core.audit('system', 'staff.bootstrap', email, 'Created from ADMIN_EMAIL'); return; }
  // The email belongs to a merchant sign-up. Convert it only if that merchant account is empty and has no other users.
  const others = store.list('users', { merchant_id: u.merchant_id }, { limit: 50 }).filter(x => x.id !== u.id && x.status === 'active');
  const hasMoney = store.count('payments', { merchant_id: u.merchant_id }) > 0 || store.count('payouts', { merchant_id: u.merchant_id }) > 0;
  if (others.length || hasMoney) { console.error(`[startup] ADMIN_EMAIL ${email} belongs to an active merchant account with data; not converted. Use another email for the platform admin.`); return; }
  const m = store.get('merchants', u.merchant_id);
  if (m) { m.status = 'suspended'; m.closed_reason = 'Email converted to the platform super admin account'; store.put('merchants', m); }
  Object.assign(u, { kind: 'staff', role: 'super_admin', merchant_id: null, password_hash: U.hashPassword(pw), mfa_enabled: false, mfa_secret: null });
  store.put('users', u);
  for (const s of store.list('sessions', { status: 'active' }, { limit: 10000 })) if (s.user_id === u.id) { s.status = 'ended'; store.put('sessions', s); }
  core.audit('system', 'staff.bootstrap', email, 'Converted empty merchant sign-up to platform super admin (ADMIN_EMAIL)', m?.id || null);
}

async function ensureSeed() {
  if (store.list('users', {}, { limit: 1 }).length) { ensureAdmin(); return; }
  const auth = require('./auth');
  const notes = [];
  if (config.production && !config.adminPassword) throw new U.HttpError(503, 'setup_incomplete', 'Server setup incomplete. Add ADMIN_PASSWORD in Vercel to create the first super admin.');
  const adminPassword = config.adminPassword || genPassword();
  auth.createUser({ email: config.adminEmail, name: 'Platform Owner', password: adminPassword, kind: 'staff', role: 'super_admin' });
  notes.push(`Super admin   ${config.adminEmail}   password: ${config.adminPassword ? '(from ADMIN_PASSWORD)' : adminPassword}`);

  if (config.seedDemo) {
    const { issueKey, ensurePublishable } = require('./routes/merchant');
    const m = core.newMerchant({ name: 'Northwind Apparel Co.', legal_name: 'Northwind Apparel Co. LLC', country: 'US', website: 'northwind-apparel.example', support_email: 'help@northwind-apparel.example' });
    Object.assign(m, { status: 'approved', risk: 'low' });
    m.kyb = { submitted: true, submitted_at: Date.now(), business: { legal_name: m.legal_name, registration_number: 'TX-7781234', incorporation_country: 'US', address: '100 Harbor St, Austin TX 78701', website: m.website, description: 'Outdoor apparel online store', monthly_volume_usd: 80000 },
      owners: [{ name: 'Abdul Rahman Ansari', pct: 70, idStatus: 'verified' }, { name: 'Dana Holt', pct: 30, idStatus: 'verified' }], checks: { registration: true, owners: true, website: true, sanctions: true, bank: true }, aml: { status: 'clear', at: Date.now() } };
    m.cashapp.details = { address: { address_line_1: '100 Harbor St', locality: 'Austin', administrative_district_level_1: 'TX', postal_code: '78701', country: 'US' }, category: '5651', site_url: 'https://northwind-apparel.example' };
    store.put('merchants', m);
    const pw = genPassword();
    auth.createUser({ email: 'owner@northwind.test', name: 'Abdul Rahman Ansari', password: pw, kind: 'merchant', role: 'owner', merchant_id: m.id });
    notes.push(`Demo merchant owner@northwind.test   password: ${pw}`);
    ensurePublishable(m, 'test', 'seed');
    const { secret } = issueKey(m, 'test', { name: 'Demo server key', scopes: ['*'] }, 'seed');
    notes.push(`Demo test secret key: ${secret}`);
    store.put('banks', { id: U.id('bnk'), merchant_id: m.id, status: 'verified', currency: 'USD', bank_name: 'First Harbor Bank', holder: m.legal_name, last4: '4411', account: U.seal('000123454411'), rail: '' });
    core.createLink(m, 'test', { amount: 12900, currency: 'USD', description: 'Trail running jacket — size M', reusable: true }, 'seed');
    if (CA.simulated('test')) await samplePayments(m, 10);

    const k = core.newMerchant({ name: 'Bluebird Bakery', legal_name: 'Bluebird Bakery LLC', country: 'US', website: 'bluebird-bakery.example', support_email: 'hello@bluebird-bakery.example' });
    k.kyb = { ...k.kyb, submitted: true, submitted_at: Date.now(), business: { legal_name: k.legal_name, registration_number: 'CA-0098812', incorporation_country: 'US', address: '42 Market St, Oakland CA 94607', website: k.website, description: 'Bakery with online pre-orders', monthly_volume_usd: 15000 },
      owners: [{ name: 'Rosa Alvarez', pct: 100, idStatus: 'pending' }] };
    store.put('merchants', k);
    auth.createUser({ email: 'owner@bluebird.test', name: 'Rosa Alvarez', password: genPassword(), kind: 'merchant', role: 'owner', merchant_id: k.id });
  }
  core.audit('system', 'platform.initialized', 'platform', 'First-run setup');
  const text = `Digital Hub — first-run credentials (${new Date().toISOString()})\n\n${notes.join('\n')}\n\nChange these passwords after signing in. Delete this file when done.\n`;
  if (!config.production) fs.writeFileSync(path.join(path.dirname(config.dbPath), 'first-run-credentials.txt'), text, { mode: 0o600 });
  if (!config.production) console.log('\n' + text);
}

module.exports = { ensureSeed, ensureAdmin, samplePayments };
