'use strict';
/* First-run setup: super admin + optional demo data generated through the real services. */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./db');
const U = require('./util');
const core = require('./core');
const P = require('./providers');

const genPassword = () => U.rid(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ') + '-' + U.rid(6, 'abcdefghjkmnpqrstuvwxyz') + '-' + U.rid(4, '23456789');
const CUSTOMERS = [['Maya Chen', 'maya.chen@example.com', 'US'], ['Liam Walker', 'liam.w@example.com', 'US'], ['Sofia Rossi', 'sofia.r@example.it', 'DE'], ['Oliver Grant', 'o.grant@example.co.uk', 'GB'],
  ['Ayesha Khan', 'ayesha.k@example.com', 'AE'], ['Hamza Siddiqui', 'hamza.s@example.com', 'PK'], ['Emma Davis', 'emma.davis@example.com', 'US'], ['Ethan Brooks', 'ethan.b@example.com', 'CA']];
const ITEMS = ['Merino crew sweater', 'Trail running jacket', 'Annual plan renewal', 'Team license (5 seats)', 'Gift card', 'Canvas weekender bag', 'Consulting retainer'];
const pick = a => a[Math.floor(Math.random() * a.length)];

/** Create sandbox payments for a merchant through the real checkout services. */
async function samplePayments(m, n = 6) {
  const made = [];
  for (let i = 0; i < n; i++) {
    const [name, email, country] = pick(CUSTOMERS);
    const amount = Math.round((15 + Math.random() * Math.random() * 400) * 100);
    try {
      const s = core.createSession(m, 'test', { amount, currency: 'USD', description: pick(ITEMS) }, 'sandbox');
      if (Math.random() < 0.6) {
        const card = pick(['4242424242424242', '5555555555554444', '4242424242424242', '4000000000000002']);
        made.push(core.cardPay(s, { number: card, exp: '12/34', cvc: '123', name, email, country: 'US' }).id);
      } else {
        const [asset, network] = pick(core.cryptoOptions(m));
        const p = await core.cryptoStart(s, { asset, network, name, email, country });
        if (Math.random() < 0.85) { core.cryptoDetected(p, p.crypto.quoteAmount); core.cryptoTick(store.get('payments', p.id), 999); }
        made.push(p.id);
      }
    } catch (e) { /* limits / velocity during sampling are fine */ }
  }
  return made;
}

async function ensureSeed() {
  if (store.list('users', {}, { limit: 1 }).length) return;
  const auth = require('./auth');
  const notes = [];
  if (config.production && !config.adminPassword) throw new U.HttpError(503, 'setup_incomplete', 'Server setup incomplete. Add ADMIN_PASSWORD in Vercel to create the first super admin.');
  const adminPassword = config.adminPassword || genPassword();
  auth.createUser({ email: config.adminEmail, name: 'Platform Owner', password: adminPassword, kind: 'staff', role: 'super_admin' });
  notes.push(`Super admin   ${config.adminEmail}   password: ${config.adminPassword ? '(from ADMIN_PASSWORD)' : adminPassword}`);

  if (config.seedDemo) {
    const { issueKey, ensurePublishable } = require('./routes/merchant');
    const m = core.newMerchant({ name: 'Northwind Apparel Co.', legal_name: 'Northwind Apparel Co. LLC', country: 'US', website: 'northwind-apparel.example', support_email: 'help@northwind-apparel.example' });
    Object.assign(m, { status: 'approved', risk: 'low', cryptoProvider: 'binance', providers: { card_acquirer: 'approved', binance: 'approved', coinbase: 'requested', soneri: 'not_requested' } });
    m.kyb = { submitted: true, submitted_at: Date.now(), business: { legal_name: m.legal_name, registration_number: 'DE-7781234', incorporation_country: 'US', address: '100 Harbor St, Austin TX', website: m.website, description: 'Outdoor apparel online store', monthly_volume_usd: 80000 },
      owners: [{ name: 'Abdul Rahman Ansari', pct: 70, idStatus: 'verified' }, { name: 'Dana Holt', pct: 30, idStatus: 'verified' }], checks: { registration: true, owners: true, website: true, sanctions: true, bank: true }, aml: { status: 'clear', at: Date.now() } };
    store.put('merchants', m);
    const pw = genPassword();
    auth.createUser({ email: 'owner@northwind.test', name: 'Abdul Rahman Ansari', password: pw, kind: 'merchant', role: 'owner', merchant_id: m.id });
    notes.push(`Demo merchant owner@northwind.test   password: ${pw}`);
    ensurePublishable(m, 'test', 'seed');
    const { secret } = issueKey(m, 'test', { name: 'Demo server key', scopes: ['*'] }, 'seed');
    notes.push(`Demo test secret key: ${secret}`);
    store.put('wallets', { id: U.id('wal'), merchant_id: m.id, status: 'verified', asset: 'USDT', network: 'BINANCE_PAY', address: '384920117', label: 'Northwind Binance Pay', ownership_attested: true });
    store.put('wallets', { id: U.id('wal'), merchant_id: m.id, status: 'pending_review', asset: 'USDC', network: 'POLYGON', address: P.genAddress('POLYGON'), label: 'Treasury Polygon', ownership_attested: true });
    store.put('banks', { id: U.id('bnk'), merchant_id: m.id, status: 'verified', currency: 'USD', bank_name: 'First Harbor Bank', holder: m.legal_name, last4: '4411', account: U.seal('000123454411'), rail: '' });
    core.createLink(m, 'test', { amount: 12900, currency: 'USD', description: 'Trail running jacket — size M', reusable: true }, 'seed');
    store.put('provider_requests', { id: U.id('preq'), merchant_id: m.id, status: 'requested', provider: 'coinbase', type: 'connection', use_case: 'USDC checkout for EU wholesale buyers', monthly_volume_usd: 20000, events: [{ at: Date.now(), status: 'requested', by: 'owner@northwind.test' }] });
    await samplePayments(m, 14);

    const k = core.newMerchant({ name: 'Indus Crafts', legal_name: 'Indus Crafts (Pvt) Ltd', country: 'PK', website: 'induscrafts.example', support_email: 'accounts@induscrafts.example' });
    k.kyb = { ...k.kyb, submitted: true, submitted_at: Date.now(), business: { legal_name: k.legal_name, registration_number: 'SECP-0098812', incorporation_country: 'PK', address: 'Gulberg III, Lahore', website: k.website, description: 'Handmade textiles, export', monthly_volume_usd: 15000 },
      owners: [{ name: 'Hira Baloch', pct: 60, idStatus: 'pending' }, { name: 'Kamran Malik', pct: 40, idStatus: 'pending' }] };
    k.providers.soneri = 'requested'; store.put('merchants', k);
    auth.createUser({ email: 'owner@induscrafts.test', name: 'Hira Baloch', password: genPassword(), kind: 'merchant', role: 'owner', merchant_id: k.id });
    store.put('provider_requests', { id: U.id('preq'), merchant_id: k.id, status: 'requested', provider: 'soneri', type: 'connection', use_case: 'PKR settlement of USD card sales to our Soneri account', monthly_volume_usd: 15000, events: [{ at: Date.now(), status: 'requested', by: 'owner@induscrafts.test' }] });
  }
  core.audit('system', 'platform.initialized', 'platform', 'First-run setup');
  const text = `Digital Hub — first-run credentials (${new Date().toISOString()})\n\n${notes.join('\n')}\n\nChange these passwords after signing in. Delete this file when done.\n`;
  if (!config.production) fs.writeFileSync(path.join(path.dirname(config.dbPath), 'first-run-credentials.txt'), text, { mode: 0o600 });
  if (!config.production) console.log('\n' + text);
}

module.exports = { ensureSeed, samplePayments };
