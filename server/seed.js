'use strict';
/* Startup: the single store account, its owner from ADMIN_EMAIL / ADMIN_PASSWORD, plus optional
   demo data generated through the real services (Cash App Pay simulator in test mode). */
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
    } catch { /* velocity limits while sampling are fine */ }
  }
  await core.flushSimEvents();
  return made;
}

/**
 * Makes sure there is exactly one active store account and that ADMIN_EMAIL owns it. Runs on every
 * start and is idempotent. An older multi-merchant database is carried over without deleting anything:
 * the account is the ADMIN_EMAIL user's merchant, else the merchant signed up with that email, else the
 * merchant with the most payments, else a new one. Other merchants and staff logins simply stop working.
 */
function ensureAccount() {
  const email = String(config.adminEmail || '').trim().toLowerCase();
  let m = core.accountId() && store.get('merchants', core.accountId());
  if (!m) {
    const all = store.list('merchants', {}, { limit: 10000 }), u = email && store.byKey('users', email);
    m = (u?.kind === 'merchant' && all.find(x => x.id === u.merchant_id))
      || all.find(x => String(x.support_email || '').toLowerCase() === email)
      || all.map(x => [x, store.count('payments', { merchant_id: x.id })]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0]?.[0]
      || core.newMerchant({ name: config.businessName });
    store.setMeta('account_id', m.id);
    core.audit('system', 'account.selected', m.id, m.name, m.id);
  }
  m = core.normalizeMerchant(m);
  // Single client: no platform fee, reserve, verification gate or payout hold.
  Object.assign(m, structuredClone(core.SINGLE_DEFAULTS));
  delete m.closed_reason;
  store.put('merchants', m);
  return m;
}
function ensureOwner(m) {
  const email = String(config.adminEmail || '').trim().toLowerCase(), pw = config.adminPassword;
  if (!email || !pw) return null;
  const auth = require('./auth');
  let u = store.byKey('users', email);
  if (!u) { u = auth.createUser({ email, name: 'Store Owner', password: pw, kind: 'merchant', role: 'owner', merchant_id: m.id }); core.audit('system', 'owner.bootstrap', email, 'Created from ADMIN_EMAIL', m.id); return u; }
  if (u.kind === 'merchant' && u.merchant_id === m.id && u.role === 'owner' && u.status === 'active') return u;
  // An earlier platform admin or another workspace's login: move it onto this account as owner.
  const wasStaff = u.kind !== 'merchant';
  Object.assign(u, { kind: 'merchant', role: 'owner', merchant_id: m.id, status: 'active' });
  if (wasStaff) u.password_hash = U.hashPassword(pw);
  store.put('users', u);
  for (const s of store.list('sessions', { status: 'active' }, { limit: 10000 })) if (s.user_id === u.id) { s.status = 'ended'; store.put('sessions', s); }
  core.audit('system', 'owner.bootstrap', email, 'Linked ADMIN_EMAIL to the store account as owner', m.id);
  return u;
}

async function ensureSeed() {
  const fresh = !store.list('users', {}, { limit: 1 }).length;
  if (fresh && config.production && !config.adminPassword) throw new U.HttpError(503, 'setup_incomplete', 'Server setup incomplete. Add ADMIN_EMAIL and ADMIN_PASSWORD in Vercel to create the store owner.');
  const m = ensureAccount();
  if (!fresh) { ensureOwner(m); return; }

  const notes = [], pw = config.adminPassword || genPassword();
  if (!config.adminPassword) config.adminPassword = pw;
  ensureOwner(m);
  notes.push(`Store owner   ${config.adminEmail}   password: ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : pw}`);

  if (config.seedDemo) {
    const { issueKey, ensurePublishable } = require('./routes/merchant');
    Object.assign(m, { name: 'Northwind Apparel Co.', legal_name: 'Northwind Apparel Co. LLC', website: 'northwind-apparel.example', support_email: 'help@northwind-apparel.example', mcc: '5651' });
    m.cashapp.details = { address: { address_line_1: '100 Harbor St', locality: 'Austin', administrative_district_level_1: 'TX', postal_code: '78701', country: 'US' }, category: '5651', site_url: 'https://northwind-apparel.example' };
    store.put('merchants', m);
    ensurePublishable(m, 'test', 'seed');
    const { secret } = issueKey(m, 'test', { name: 'Demo server key', scopes: ['*'] }, 'seed');
    notes.push(`Demo test secret key: ${secret}`);
    core.createLink(m, 'test', { amount: 12900, currency: 'USD', description: 'Trail running jacket — size M', reusable: true }, 'seed');
    if (CA.simulated('test')) await samplePayments(m, 10);
  }
  core.audit('system', 'platform.initialized', 'platform', 'First-run setup', m.id);
  const text = `Digital Hub Wallet — first-run credentials (${new Date().toISOString()})\n\n${notes.join('\n')}\n\nChange the password after signing in and enable 2FA. Delete this file when done.\n`;
  if (!config.production) fs.writeFileSync(path.join(path.dirname(config.dbPath), 'first-run-credentials.txt'), text, { mode: 0o600 });
  if (!config.production) console.log('\n' + text);
}

module.exports = { ensureSeed, ensureAccount, ensureOwner, samplePayments };
