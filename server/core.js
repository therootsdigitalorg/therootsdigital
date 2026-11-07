'use strict';
/* Domain services for Digital Hub Wallet + Cash App Pay.
   Money only moves through the double-entry ledger, and only after Cash App confirms the
   payment, refund or dispute (API response or verified webhook). The wallet records verified
   payment and settlement activity; Digital Hub does not hold customer funds itself. */
const dns = require('node:dns').promises;
const net = require('node:net');
const config = require('./config');
const store = require('./db');
const L = require('./ledger');
const { ACCT } = L;
const U = require('./util');
const { DAY, id, rid, HttpError, bad, toUSD, pct, fmt, FIAT } = U;
const CA = require('./cashapp');

const PAID = ['authorized', 'captured', 'settled', 'partially_refunded', 'refunded', 'disputed', 'chargeback_lost'];
const IN_FLIGHT = ['awaiting_customer', 'processing'];
const now = () => Date.now();
const dayMs = mode => mode === 'test' ? config.sandboxDayMs : DAY;
const CHECKOUT_CURRENCY = 'USD'; // Cash App Pay settles in USD only (Currency enum in the Network API)

/* ---------------- platform settings ---------------- */
const PLATFORM_DEFAULT = {
  approvalThresholdUSD: 1000000, // minor units ($10,000)
  risk: { declineCount: 3, highValueUSD: 500000 },
  defaults: { platPct: 0, platFixedUSD: 0, reservePct: 0, reserveDays: 0 },
};
function platform() {
  const s = store.getMeta('platform', {});
  const d = { ...PLATFORM_DEFAULT.defaults, ...(s.defaults || {}) };
  if (s.defaults && s.defaults.platPct == null && s.defaults.cardPlatPct != null) d.platPct = s.defaults.cardPlatPct;
  return { ...PLATFORM_DEFAULT, ...s, defaults: d };
}
const setPlatform = v => store.setMeta('platform', { ...platform(), ...v });

/* ---------------- audit, alerts, events ---------------- */
function audit(actor, action, target = '', detail = '', mid = null) {
  store.put('audit', { id: id('aud'), merchant_id: mid, actor: actor || 'system', action, target: String(target || ''), detail: String(detail || '') });
}
function alert(severity, kind, mid, ref, detail, mode = 'test') {
  store.put('alerts', { id: id('alr'), merchant_id: mid, mode, status: 'open', severity, kind, ref, detail });
}
function emit(mid, mode, type, object) {
  const evt = store.put('events', { id: id('evt'), merchant_id: mid, mode, status: 'created', type, object: 'event', livemode: mode === 'live', data: { object } });
  for (const ep of store.list('webhook_endpoints', { merchant_id: mid, mode, status: 'enabled' })) {
    if (!ep.events.includes('*') && !ep.events.includes(type)) continue;
    store.put('deliveries', { id: id('whd'), merchant_id: mid, mode, status: 'pending', endpoint_id: ep.id, url: ep.url, event_id: evt.id, type, attempts: 0, next_at: now(), code: null, error: null });
  }
  return evt;
}
const publicEvent = e => ({ id: e.id, object: 'event', type: e.type, livemode: e.livemode, created: Math.floor(e.created_at / 1000), data: e.data });

/* ---------------- the store account ----------------
   Digital Hub runs for one client: a single store account (with its team) that owns every
   payment, link, key and webhook. Its id is kept in meta 'account_id' (see seed.ensureAccount). */
const SINGLE_DEFAULTS = {
  status: 'approved', live_enabled: true, risk: 'low',
  limits: { perTxnUSD: 100000000, dailyUSD: 10000000000, monthlyUSD: 100000000000, refundDailyUSD: 10000000000 },
  controls: { velocityPerHour: 30, blockedCountries: [] },
  fees: { platPct: 0, platFixedUSD: 0, disputeFeeUSD: 0 }, reserve: { pct: 0, days: 0 }, settlementHold: null,
};
function newMerchant({ name, legal_name, country = 'US', website = '', support_email = '' }) {
  return normalizeMerchant({ id: id('acct'), name, legal_name: legal_name || name, country, website, support_email, mcc: '5999', captureMode: 'auto', ...structuredClone(SINGLE_DEFAULTS) });
}
const accountId = () => store.getMeta('account_id', null);
const isAccount = m => !!m && m.id === accountId();
function account() {
  const m = accountId() && store.get('merchants', accountId());
  if (!m) throw new HttpError(503, 'setup_incomplete', 'The store account is not set up yet. Restart the server with ADMIN_EMAIL and ADMIN_PASSWORD set.');
  return normalizeMerchant(m);
}
/** Fills fields added with Cash App Pay so older merchant records keep working. */
function normalizeMerchant(m) {
  if (!m) return m;
  const p = m.perms || {};
  m.perms = { cashapp: p.cashapp ?? true, refunds: p.refunds ?? true, links: p.links ?? true, api: p.api ?? true };
  const f = m.fees || {};
  m.fees = { platPct: f.platPct ?? f.card?.platPct ?? 1.0, platFixedUSD: f.platFixedUSD ?? 0, disputeFeeUSD: f.disputeFeeUSD ?? 0 };
  m.cashapp ||= {};
  m.cashapp.details ||= null;
  m.cashapp.test ||= {}; m.cashapp.live ||= {};
  m.captureMode = m.captureMode === 'manual' ? 'manual' : 'auto';
  m.controls ||= { velocityPerHour: 10, blockedCountries: [] };
  return m;
}
const merchant = mid => { const m = store.get('merchants', mid); if (!m) throw new HttpError(404, 'not_found', 'Merchant not found'); return normalizeMerchant(m); };
const cashappReady = (m, mode) => !!(m.cashapp[mode]?.merchant_id && m.cashapp[mode]?.status === 'ACTIVE');
function liveReady(m) {
  if (!config.livePayments) return 'Live payments are switched off (set LIVE_PAYMENTS=1 on the server).';
  if (!CA.configured('live')) return 'Cash App Pay production credentials are not set on the server (CASHAPP_CLIENT_ID, CASHAPP_API_KEY_ID, CASHAPP_API_KEY_SECRET).';
  if (!cashappReady(m, 'live')) return 'Register your business with Cash App Pay production (Settings → Cash App Pay).';
  return null;
}
function assertMode(m, mode) {
  if (!isAccount(m)) throw new HttpError(403, 'account_inactive', 'This account is not active.');
  if (mode === 'live') { const why = liveReady(m); if (why) throw new HttpError(403, 'live_mode_unavailable', why); }
}
function methodAvailable(m, mode) {
  if (!m.perms.cashapp) return false;
  if (mode === 'live') return !liveReady(m);
  return cashappReady(m, 'test') || CA.simulated('test');
}

/* ---------------- Cash App merchant registration (Network API brands + merchants) ---------------- */
function validateDetails(d) {
  const a = d?.address || {};
  const clean = {
    address: { address_line_1: U.str(a.address_line_1, 200), address_line_2: U.str(a.address_line_2, 200) || undefined, locality: U.str(a.locality, 100), administrative_district_level_1: U.str(a.administrative_district_level_1, 2).toUpperCase(), postal_code: U.str(a.postal_code, 10), country: 'US' },
    category: U.str(d?.category, 4), site_url: U.str(d?.site_url, 500),
  };
  if (!clean.address.address_line_1 || !clean.address.locality || !/^[A-Z]{2}$/.test(clean.address.administrative_district_level_1) || !/^\d{5}(-\d{4})?$/.test(clean.address.postal_code)) throw bad('Enter a complete US business address (street, city, 2-letter state, ZIP).');
  if (!/^\d{4}$/.test(clean.category)) throw bad('Enter the 4-digit merchant category code (MCC).');
  if (clean.site_url && !U.isUrl(clean.site_url)) throw bad('Website must be a full URL (https://…).');
  if (!clean.address.address_line_2) delete clean.address.address_line_2;
  return clean;
}
async function registerCashApp(m, mode, actor) {
  if (mode === 'live' && !CA.configured('live')) throw bad('Cash App Pay production credentials are not configured on the server.');
  const details = m.cashapp.details || (CA.simulated(mode) ? { address: { address_line_1: '1 Simulator Way', locality: 'San Francisco', administrative_district_level_1: 'CA', postal_code: '94105', country: 'US' }, category: m.mcc || '5999', site_url: '' } : null);
  if (!details) throw bad('Submit the business address and MCC under Settings → Cash App Pay first.');
  const api = CA.client(mode), reg = m.cashapp[mode] || {}, opt = { mid: m.id, op: 'register_merchant' };
  try {
    if (!reg.brand_id) {
      const brand = await api.createBrand({ idempotency_key: `${m.id}:${mode}:brand`, brand: { name: m.name.slice(0, 255), reference_id: m.id } }, opt);
      reg.brand_id = brand.id;
    }
    if (!reg.merchant_id) {
      const cm = await api.createMerchant({ idempotency_key: `${m.id}:${mode}:merchant`, merchant: { name: m.name, brand_id: reg.brand_id, country: 'US', currency: 'USD', category: details.category, reference_id: m.id, address: details.address, ...(details.site_url ? { site_url: details.site_url } : {}) } }, opt);
      Object.assign(reg, { merchant_id: cm.id, status: cm.status });
    } else {
      reg.status = (await api.retrieveMerchant(reg.merchant_id, opt)).status;
    }
    Object.assign(reg, { environment: CA.environmentLabel(mode), registered_at: reg.registered_at || now(), error: null });
  } catch (e) {
    reg.error = e.message; m.cashapp[mode] = reg; store.put('merchants', m);
    throw e instanceof CA.CashAppError ? bad(`Cash App: ${e.message}`, e.code) : e;
  }
  m.cashapp[mode] = reg; store.put('merchants', m);
  audit(actor, 'cashapp.merchant_registered', m.id, `${mode} ${reg.merchant_id} ${reg.status}`, m.id);
  return reg;
}

/* ---------------- controls ---------------- */
function volumeUSD(mid, mode, ms) {
  return store.list('payments', { merchant_id: mid, mode, status: PAID, since: now() - ms }, { limit: 5000 }).reduce((s, p) => s + toUSD(p.amount, p.currency), 0);
}
function controlCheck(m, mode, amount, currency, customer) {
  const usd = toUSD(amount, currency), Lm = m.limits;
  if (usd > Lm.perTxnUSD) return `Amount exceeds this merchant's per-transaction limit of ${fmt(Lm.perTxnUSD, 'USD')}.`;
  if (volumeUSD(m.id, mode, DAY) + usd > Lm.dailyUSD) return `Daily volume limit (${fmt(Lm.dailyUSD, 'USD')}) would be exceeded.`;
  if (volumeUSD(m.id, mode, 30 * DAY) + usd > Lm.monthlyUSD) return `30-day volume limit (${fmt(Lm.monthlyUSD, 'USD')}) would be exceeded.`;
  if (customer?.country && m.controls.blockedCountries.includes(customer.country)) return 'Payments from this country are not accepted for this merchant.';
  if (customer?.email) {
    const n = store.list('payments', { merchant_id: m.id, mode, since: now() - 3600000 }, { limit: 1000 }).filter(p => p.customer?.email === customer.email).length;
    if (n >= m.controls.velocityPerHour) return 'Too many payment attempts. Try again later.';
  }
  return null;
}
function platformFee(m, amount) { return pct(amount, m.fees.platPct) + m.fees.platFixedUSD; }

/* ---------------- public representations ---------------- */
const ts = t => t ? Math.floor(t / 1000) : null;
function publicSession(s) {
  return { id: s.id, object: 'checkout.session', livemode: s.mode === 'live', url: `${config.publicUrl}/pay/${s.id}`, status: s.status, amount: s.amount, currency: s.currency, description: s.description,
    payment_methods: ['cashapp'], payment: s.payment_id || null, payment_status: s.payment_status || 'unpaid', customer_email: s.customer_email || null, metadata: s.metadata || {},
    success_url: s.success_url, cancel_url: s.cancel_url, payment_link: s.link_id || null, expires_at: ts(s.expires_at), created: ts(s.created_at) };
}
function publicPayment(p) {
  const c = p.cashapp || {};
  return { id: p.id, object: 'payment', livemode: p.mode === 'live', status: p.status, amount: p.amount, currency: p.currency, method: p.method, description: p.description,
    amount_refunded: p.refunded, net: p.net, fees: p.fees, customer: { name: p.customer?.name || null, email: p.customer?.email || null }, metadata: p.metadata || {},
    checkout_session: p.session_id, payment_link: p.link_id || null, decline_code: p.declineCode || null,
    cash_app: p.method === 'cashapp' ? { environment: c.env, customer_request_id: c.request_id || null, request_status: c.request_status || null, payment_id: c.payment_id || null, payment_status: c.payment_status || null, capture_before: c.capture_before || null } : null,
    created: ts(p.created_at) };
}
const publicRefund = r => ({ id: r.id, object: 'refund', livemode: r.mode === 'live', status: r.status, payment: r.payment_id, amount: r.amount, currency: r.currency, reason: r.reason || null, cash_app_refund_id: r.cashapp_refund_id || null, created: ts(r.created_at) });
const publicLink = l => ({ id: l.id, object: 'payment_link', livemode: l.mode === 'live', active: l.status === 'active', url: `${config.publicUrl}/l/${l.k}`, amount: l.amount, currency: l.currency, description: l.description, payment_methods: ['cashapp'], reusable: l.reusable, expires_at: ts(l.expires_at), created: ts(l.created_at) });
const publicDispute = d => ({ id: d.id, object: 'dispute', livemode: d.mode === 'live', status: d.status, state: d.state, payment: d.payment_id, amount: d.amount, currency: d.currency, reason: d.reason, response_due_at: d.response_due_at || null, created: ts(d.created_at) });

/* ---------------- checkout sessions & links ---------------- */
function checkAmount(amount, currency) {
  if (!Number.isInteger(amount) || amount < 100) throw bad('amount must be an integer in cents, at least 100 ($1.00).', 'amount_invalid');
  if (amount > 100000000) throw bad('amount is too large.', 'amount_invalid');
  if (currency !== CHECKOUT_CURRENCY) throw bad('Cash App Pay accepts USD only. Set currency to USD.', 'currency_invalid');
}
function createSession(m, mode, input, actor = 'api') {
  assertMode(m, mode);
  const amount = Number(input.amount), currency = String(input.currency || 'USD').toUpperCase();
  checkAmount(amount, currency);
  for (const k of ['success_url', 'cancel_url']) if (input[k] && !U.isUrl(input[k])) throw bad(`${k} must be an http(s) URL.`, 'url_invalid');
  if (!methodAvailable(m, mode)) throw bad(mode === 'live' ? (liveReady(m) || 'Cash App Pay is not available for this account.') : 'Register this business with the Cash App Pay sandbox first (Settings → Cash App Pay).', 'no_payment_method');
  const block = controlCheck(m, mode, amount, currency, null); if (block) throw bad(block, 'limit_exceeded');
  const metadata = {}; for (const [k, v] of Object.entries(input.metadata || {}).slice(0, 20)) metadata[U.str(k, 40)] = U.str(v, 500);
  const s = store.put('checkout_sessions', { id: 'cs_' + rid(28), merchant_id: m.id, mode, status: 'open', amount, currency, description: U.str(input.description || 'Payment', 200), methods: ['cashapp'],
    success_url: input.success_url || null, cancel_url: input.cancel_url || null, metadata, customer_email: U.isEmail(input.customer_email) ? input.customer_email : null,
    link_id: input.link_id || null, payment_id: null, attempts: 0, expires_at: now() + 24 * 3600000 });
  audit(actor, 'checkout_session.create', s.id, fmt(amount, currency), m.id);
  return s;
}
function createLink(m, mode, input, actor) {
  assertMode(m, mode);
  if (!m.perms.links) throw new HttpError(403, 'links_disabled', 'Payment links are disabled for this account.');
  const amount = Number(input.amount), currency = String(input.currency || 'USD').toUpperCase();
  checkAmount(amount, currency);
  const description = U.str(input.description, 200); if (!description) throw bad('description is required.');
  const days = Number(input.expires_in_days || 0);
  const l = store.put('links', { id: id('plink'), merchant_id: m.id, mode, status: 'active', k: rid(24, 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'), amount, currency, description, methods: ['cashapp'],
    reusable: !!input.reusable, expires_at: days > 0 ? now() + days * DAY : null, payments: [] });
  audit(actor, 'payment_link.create', l.id, fmt(amount, currency), m.id);
  return l;
}
const linkActive = l => l.status === 'active' && (!l.expires_at || now() < l.expires_at);
const addEvent = (p, status, note = '') => p.events.push({ at: now(), status, note });
function completeSession(s, p) {
  if (!s) return;
  if (s.status === 'complete' && s.payment_id === p.id && s.payment_status === 'authorized' && p.status === 'captured') {
    s.payment_status = 'paid'; store.put('checkout_sessions', s); emit(s.merchant_id, s.mode, 'checkout.session.completed', publicSession(s)); return;
  }
  if (s.status !== 'open') return;
  s.status = 'complete'; s.payment_status = p.status === 'authorized' ? 'authorized' : 'paid'; s.payment_id = p.id; store.put('checkout_sessions', s);
  if (s.link_id) { const l = store.get('links', s.link_id); if (l) { l.payments.push(p.id); if (!l.reusable) l.status = 'completed'; store.put('links', l); } }
  emit(s.merchant_id, s.mode, 'checkout.session.completed', publicSession(s));
}
function sessionPayable(s) {
  if (s.status !== 'open') throw new HttpError(409, 'session_closed', s.status === 'complete' ? 'This checkout is already paid.' : 'This checkout has expired.');
  if (now() > s.expires_at) throw new HttpError(409, 'session_expired', 'This checkout has expired.');
  if (s.payment_id) { const p = store.get('payments', s.payment_id); if (p && [...IN_FLIGHT, 'authorized', 'captured'].includes(p.status)) throw new HttpError(409, 'payment_in_progress', 'A payment for this checkout is already in progress.'); }
}

/* ---------------- Cash App Pay payments ----------------
   1. Customer Request API: ONE_TIME_PAYMENT request (QR / mobile_url) — status PENDING → APPROVED | DECLINED
   2. On APPROVED, the request carries a grant; Network API create payment with that grant
   3. Payment status AUTHORIZED | CAPTURED | VOIDED | DECLINED; the wallet credits only CAPTURED */
async function startCashApp(s, input) {
  const m = merchant(s.merchant_id); assertMode(m, s.mode); sessionPayable(s);
  if (!methodAvailable(m, s.mode)) throw bad('Cash App Pay is not available for this checkout.');
  if (s.mode === 'test' && !cashappReady(m, 'test')) await registerCashApp(m, 'test', 'system');
  const customer = { name: U.str(input.name, 120), email: U.isEmail(String(input.email || '').toLowerCase()) ? String(input.email).toLowerCase() : null, country: U.str(input.country, 2).toUpperCase() || null };
  const block = controlCheck(m, s.mode, s.amount, s.currency, customer);
  if (block) { alert('low', 'control_block', m.id, s.id, block, s.mode); throw bad(block, 'blocked_by_controls'); }
  const p = { id: id('pay'), merchant_id: m.id, mode: s.mode, status: 'awaiting_customer', session_id: s.id, link_id: s.link_id, method: 'cashapp', amount: s.amount, currency: s.currency, description: s.description,
    customer, metadata: s.metadata, fees: null, net: null, refunded: 0, settled: false, events: [], cashapp: { env: CA.environmentLabel(s.mode) } };
  const req = await CA.client(s.mode).createCustomerRequest({ idempotency_key: p.id, request: {
    channel: 'ONLINE', redirect_url: `${config.publicUrl}/pay/${s.id}`, reference_id: p.id,
    actions: [{ type: 'ONE_TIME_PAYMENT', amount: s.amount, currency: 'USD', scope_id: m.cashapp[s.mode].merchant_id }] } }, { mid: m.id, op: 'create_customer_request' });
  Object.assign(p.cashapp, { request_id: req.id, request_status: req.status, triggers: req.auth_flow_triggers || null, request_expires_at: req.expires_at ? Date.parse(req.expires_at) : null });
  p.k = req.id;
  addEvent(p, 'awaiting_customer', `Cash App customer request ${req.id} created (${p.cashapp.env})`);
  store.tx(() => { store.put('payments', p); s.payment_id = p.id; s.attempts = (s.attempts || 0) + 1; store.put('checkout_sessions', s); });
  emit(m.id, s.mode, 'payment.created', publicPayment(p));
  return p;
}

/** Brings a payment up to date with Cash App. Safe to call repeatedly (idempotent create calls). */
async function syncPayment(p, { force } = {}) {
  if (p.method !== 'cashapp') return p;
  if (!force && p.cashapp.last_sync && now() - p.cashapp.last_sync < 1500) return p;
  p.cashapp.last_sync = now();
  const api = CA.client(p.mode), opt = { mid: p.merchant_id, op: 'sync_payment' };
  try {
    if (p.status === 'awaiting_customer') {
      const r = await api.retrieveCustomerRequest(p.cashapp.request_id, opt);
      await applyCustomerRequest(p, r);
      p = store.get('payments', p.id);
    }
    if (p.status === 'processing') await createCashAppPayment(p);
    else if (p.status === 'authorized' && p.cashapp.payment_id) applyCashAppPayment(store.get('payments', p.id), await api.retrievePayment(p.cashapp.payment_id, opt));
    else store.put('payments', p);
  } catch (e) {
    if (!(e instanceof CA.CashAppError)) throw e;
    p.cashapp.last_error = e.message; store.put('payments', p);
  }
  return store.get('payments', p.id);
}
async function applyCustomerRequest(p, r) {
  if (p.status !== 'awaiting_customer') return;
  Object.assign(p.cashapp, { request_status: r.status, triggers: r.auth_flow_triggers || p.cashapp.triggers, request_expires_at: r.expires_at ? Date.parse(r.expires_at) : p.cashapp.request_expires_at });
  if (r.status === 'APPROVED') {
    const grant = (r.grants || []).find(g => g.action?.type === 'ONE_TIME_PAYMENT');
    if (!grant) { store.put('payments', p); return; }
    Object.assign(p.cashapp, { grant_id: grant.id, customer_id: grant.customer_id });
    p.status = 'processing'; addEvent(p, 'approved', 'Customer approved in Cash App'); store.put('payments', p);
    await createCashAppPayment(p);
  } else if (r.status === 'DECLINED') {
    const expired = p.cashapp.request_expires_at && now() >= p.cashapp.request_expires_at - 5000;
    p.status = expired ? 'expired' : 'declined'; p.declineCode = expired ? 'request_expired' : 'customer_declined';
    addEvent(p, p.status, expired ? 'Customer request expired before approval' : 'Customer declined in Cash App'); store.put('payments', p);
    emit(p.merchant_id, p.mode, 'payment.failed', publicPayment(p));
  } else store.put('payments', p);
}
async function createCashAppPayment(p) {
  const m = merchant(p.merchant_id);
  try {
    const cp = await CA.client(p.mode).createPayment({ idempotency_key: `${p.id}:payment`, payment: { amount: p.amount, currency: 'USD', merchant_id: m.cashapp[p.mode].merchant_id, grant_id: p.cashapp.grant_id, reference_id: p.id, capture: m.captureMode !== 'manual' } }, { mid: m.id, op: 'create_payment' });
    applyCashAppPayment(store.get('payments', p.id), cp);
  } catch (e) {
    if (!(e instanceof CA.CashAppError)) throw e;
    const cur = store.get('payments', p.id); cur.cashapp.last_error = e.message;
    if (e.retryable) { addEvent(cur, 'processing', `Cash App did not answer; retrying with the same idempotency key (${e.message})`); store.put('payments', cur); return; }
    cur.status = 'declined'; cur.declineCode = e.code; addEvent(cur, 'declined', `Cash App rejected the payment: ${e.message}`); store.put('payments', cur);
    emit(cur.merchant_id, cur.mode, 'payment.failed', publicPayment(cur));
  }
}
/** Applies a Cash App payment object (from an API response or a verified payment.status.updated webhook). */
function applyCashAppPayment(p, cp) {
  return store.tx(() => {
    if (cp.reference_id && cp.reference_id !== p.id) throw bad('Cash App payment does not belong to this Digital Hub payment.');
    const m = merchant(p.merchant_id);
    Object.assign(p.cashapp, { payment_id: cp.id, payment_status: cp.status, capture_before: cp.capture_before || null, fee_amount: cp.fee_amount ?? null, customer_id: cp.customer_id || p.cashapp.customer_id, decline_errors: cp.decline_errors || [] });
    const s = store.get('checkout_sessions', p.session_id);
    if (cp.status === 'CAPTURED' && !p.captured_at) {
      const captured = cp.captured_amount || cp.amount, provider = Math.round(Number(cp.fee_amount) || 0), plat = platformFee(m, captured), net = captured - provider - plat;
      L.post(p.mode, `${p.id}:capture`, [
        { acct: ACCT.ACQ_RCV, cur: p.currency, amt: captured - provider },
        { acct: ACCT.M_PENDING, mid: m.id, cur: p.currency, amt: -net },
        { acct: ACCT.P_REV, cur: p.currency, amt: -plat },
      ], { ref: p.id, memo: 'Cash App Pay capture (Cash App fee netted)' });
      Object.assign(p, { status: 'captured', captured_at: now(), fees: { provider, platform: plat }, net, pendingRemaining: net, rcvRemaining: captured - provider });
      addEvent(p, 'captured', `Cash App payment ${cp.id} captured. Fees ${fmt(provider + plat, p.currency)}${cp.fee_amount == null ? ' (Cash App fee not reported yet)' : ''}.`);
      store.put('payments', p); completeSession(s, p);
      emit(m.id, p.mode, 'payment.succeeded', publicPayment(p));
      if (toUSD(captured, p.currency) > platform().risk.highValueUSD) alert('medium', 'high_value', m.id, p.id, `High-value payment ${fmt(captured, p.currency)}`, p.mode);
    } else if (cp.status === 'AUTHORIZED' && IN_FLIGHT.includes(p.status)) {
      p.status = 'authorized'; addEvent(p, 'authorized', `Authorized by Cash App; capture before ${cp.capture_before || 'the deadline'}`);
      store.put('payments', p); completeSession(s, p); emit(m.id, p.mode, 'payment.authorized', publicPayment(p));
    } else if (cp.status === 'DECLINED' && p.status !== 'declined') {
      p.status = 'declined'; p.declineCode = cp.decline_errors?.[0]?.code || 'declined';
      addEvent(p, 'declined', cp.decline_errors?.[0]?.detail || 'Cash App declined the payment'); store.put('payments', p);
      emit(m.id, p.mode, 'payment.failed', publicPayment(p));
      const rules = platform().risk;
      if (p.customer?.email && store.list('payments', { merchant_id: m.id, mode: p.mode, status: 'declined', since: now() - DAY }, { limit: 500 }).filter(x => x.customer?.email === p.customer.email).length >= rules.declineCount)
        alert('medium', 'repeated_declines', m.id, p.id, `${rules.declineCount}+ declines in 24h for ${p.customer.email}`, p.mode);
    } else if (cp.status === 'VOIDED' && p.status !== 'canceled') {
      p.status = 'canceled'; addEvent(p, 'canceled', 'Authorization voided'); store.put('payments', p);
      emit(m.id, p.mode, 'payment.canceled', publicPayment(p));
    } else store.put('payments', p);
    return p;
  });
}
async function capture(p, actor) {
  if (p.status !== 'authorized' || !p.cashapp?.payment_id) throw bad('Only authorized Cash App payments can be captured.', 'payment_not_capturable');
  const cp = await CA.client(p.mode).capturePayment(p.cashapp.payment_id, { idempotency_key: `${p.id}:capture`, amount: p.amount }, { mid: p.merchant_id, op: 'capture_payment' }).catch(caError);
  const out = applyCashAppPayment(store.get('payments', p.id), cp); audit(actor, 'payment.capture', p.id, '', p.merchant_id); return out;
}
async function cancel(p, actor) {
  if (p.status === 'awaiting_customer') { p.status = 'canceled'; addEvent(p, 'canceled', 'Canceled before the customer approved'); store.put('payments', p); audit(actor, 'payment.cancel', p.id, '', p.merchant_id); return p; }
  if (p.status !== 'authorized' || !p.cashapp?.payment_id) throw bad('Only uncaptured authorizations can be voided.');
  const cp = await CA.client(p.mode).voidPayment(p.cashapp.payment_id, { mid: p.merchant_id, op: 'void_payment' }).catch(caError);
  const out = applyCashAppPayment(store.get('payments', p.id), cp); audit(actor, 'payment.cancel', p.id, '', p.merchant_id); return out;
}
function caError(e) { if (e instanceof CA.CashAppError) throw new HttpError(e.retryable ? 502 : 400, e.code, `Cash App: ${e.message}`); throw e; }

/* ---------------- refunds ---------------- */
function refundsFor(p) { return store.list('refunds', { merchant_id: p.merchant_id }, { limit: 1000 }).filter(r => r.payment_id === p.id); }
function maxRefundable(p) {
  if (p.method !== 'cashapp' || !['captured', 'settled', 'partially_refunded'].includes(p.status)) return 0;
  const pending = refundsFor(p).filter(r => r.status === 'pending').reduce((s, r) => s + r.amount, 0);
  return Math.max(0, p.amount - p.refunded - pending);
}
async function refund(p, amount, { actor, reason }) {
  const m = merchant(p.merchant_id), cur = p.currency;
  if (!m.perms.refunds) throw new HttpError(403, 'refunds_disabled', 'Refunds are disabled for this account.');
  if (p.method !== 'cashapp') throw bad('Only Cash App Pay payments can be refunded here.');
  amount = amount == null ? maxRefundable(p) : Number(amount);
  if (!Number.isInteger(amount) || amount <= 0) throw bad('Refund amount must be a positive integer (cents).');
  if (amount > maxRefundable(p)) throw bad(`The most you can refund is ${fmt(maxRefundable(p), cur)}.`, 'amount_too_large');
  const today = store.list('refunds', { merchant_id: m.id, mode: p.mode, since: now() - DAY }).filter(r => r.status !== 'declined').reduce((s, r) => s + toUSD(r.amount, r.currency), 0);
  if (today + toUSD(amount, cur) > m.limits.refundDailyUSD) throw bad('Daily refund limit reached. Contact Digital Hub.', 'refund_limit');
  const fromAcct = p.settled ? ACCT.M_AVAIL : ACCT.M_PENDING;
  if (L.balance(m.id, p.mode, fromAcct, cur) < amount) throw bad(`${p.settled ? 'Available' : 'Pending'} balance is too low for this refund.`, 'insufficient_balance');
  const r = { id: id('re'), merchant_id: m.id, mode: p.mode, status: 'pending', payment_id: p.id, amount, currency: cur, reason: U.str(reason, 100), actor };
  store.put('refunds', r);
  try {
    const cr = await CA.client(p.mode).createRefund({ idempotency_key: r.id, refund: { amount, currency: 'USD', merchant_id: m.cashapp[p.mode].merchant_id, payment_id: p.cashapp.payment_id, capture: true, reference_id: r.id } }, { mid: m.id, op: 'create_refund' });
    return applyCashAppRefund(r.id, cr);
  } catch (e) {
    if (!(e instanceof CA.CashAppError)) throw e;
    if (e.retryable) { r.error = e.message; store.put('refunds', r); audit(actor, 'refund.pending', p.id, e.message, m.id); return r; }
    r.status = 'failed'; r.error = e.message; store.put('refunds', r);
    throw bad(`Cash App refused the refund: ${e.message}`, e.code);
  } finally { audit(actor, 'refund.create', p.id, fmt(amount, cur), m.id); }
}
/** Applies a Cash App refund (API response or verified refund.status.updated webhook). Ledger moves only on CAPTURED. */
function applyCashAppRefund(refundId, cr) {
  return store.tx(() => {
    const r = store.get('refunds', refundId); if (!r) return null;
    r.cashapp_refund_id = cr.id; r.cashapp_status = cr.status;
    const p = store.get('payments', r.payment_id);
    if (cr.status === 'CAPTURED' && r.status !== 'succeeded') {
      const acct = p.settled ? ACCT.M_AVAIL : ACCT.M_PENDING, counter = p.settled ? ACCT.P_CASH : ACCT.ACQ_RCV;
      L.post(r.mode, `${r.id}:refund`, [{ acct, mid: r.merchant_id, cur: r.currency, amt: r.amount }, { acct: counter, cur: r.currency, amt: -r.amount }], { ref: p.id, memo: `Cash App refund ${cr.id}` });
      if (!p.settled) { p.pendingRemaining -= r.amount; p.rcvRemaining -= r.amount; }
      p.refunded += r.amount; p.status = p.refunded >= p.amount ? 'refunded' : 'partially_refunded';
      addEvent(p, p.status, `Refund ${fmt(r.amount, r.currency)} captured by Cash App`); store.put('payments', p);
      r.status = 'succeeded'; store.put('refunds', r);
      emit(r.merchant_id, r.mode, 'refund.succeeded', publicRefund(r)); emit(r.merchant_id, r.mode, 'payment.refunded', publicPayment(p));
    } else if ((cr.status === 'DECLINED' || cr.status === 'VOIDED') && r.status === 'pending') {
      r.status = 'declined'; store.put('refunds', r); emit(r.merchant_id, r.mode, 'refund.failed', publicRefund(r));
    } else store.put('refunds', r);
    return r;
  });
}
async function retryPendingRefunds() {
  for (const r of store.list('refunds', { status: 'pending' }, { limit: 50 })) {
    const p = store.get('payments', r.payment_id), m = merchant(r.merchant_id);
    try {
      const cr = r.cashapp_refund_id ? await CA.client(r.mode).retrieveRefund(r.cashapp_refund_id, { mid: m.id, op: 'retrieve_refund' })
        : await CA.client(r.mode).createRefund({ idempotency_key: r.id, refund: { amount: r.amount, currency: 'USD', merchant_id: m.cashapp[r.mode].merchant_id, payment_id: p.cashapp.payment_id, capture: true, reference_id: r.id } }, { mid: m.id, op: 'create_refund' });
      applyCashAppRefund(r.id, cr);
    } catch (e) { if (!(e instanceof CA.CashAppError)) throw e; if (!e.retryable) { r.status = 'failed'; r.error = e.message; store.put('refunds', r); } }
  }
}

/* ---------------- disputes (from Cash App) ---------------- */
const DISPUTE_STATUS = { RESPONSE_REQUIRED: 'needs_response', NO_RESPONSE_REQUIRED: 'under_review', PROCESSING: 'under_review', ACCEPTED: 'lost', WON: 'won', PARTIALLY_WON: 'partially_won', LOST: 'lost' };
function findByCashAppPayment(mode, cpid) { return store.list('payments', { mode }, { limit: 20000 }).find(p => p.cashapp?.payment_id === cpid) || null; }
function applyCashAppDispute(mode, cd) {
  return store.tx(() => {
    let d = store.list('disputes', { mode }, { limit: 5000 }).find(x => x.cashapp_dispute_id === cd.id);
    const p = d ? store.get('payments', d.payment_id) : findByCashAppPayment(mode, cd.payment_id);
    if (!p) return null;
    if (!d) {
      d = { id: id('dp'), merchant_id: p.merchant_id, mode, payment_id: p.id, cashapp_dispute_id: cd.id, amount: cd.amount, currency: p.currency, reason: cd.reason, returned: 0, evidence: [] };
      L.post(mode, `${d.id}:open`, [{ acct: ACCT.M_AVAIL, mid: p.merchant_id, cur: p.currency, amt: cd.amount }, { acct: ACCT.P_CASH, cur: p.currency, amt: -cd.amount }], { ref: p.id, memo: `Cash App dispute ${cd.reason}` });
      p.status = 'disputed'; addEvent(p, 'disputed', `Cash App dispute ${cd.id} opened (${cd.reason})`); store.put('payments', p);
      alert('medium', 'dispute', p.merchant_id, p.id, `Dispute ${cd.reason} ${fmt(cd.amount, p.currency)}`, mode);
      emit(p.merchant_id, mode, 'dispute.created', publicDispute({ ...d, status: DISPUTE_STATUS[cd.state], state: cd.state }));
    }
    const prev = d.state;
    Object.assign(d, { state: cd.state, status: DISPUTE_STATUS[cd.state] || 'under_review', response_due_at: cd.response_due_at ? Date.parse(cd.response_due_at) : d.response_due_at || null });
    if (prev !== cd.state && ['WON', 'PARTIALLY_WON'].includes(cd.state) && !d.returned) {
      const back = cd.state === 'WON' ? d.amount : Math.max(0, d.amount - (cd.customer_credited_amount || 0));
      if (back) L.post(mode, `${d.id}:returned`, [{ acct: ACCT.P_CASH, cur: d.currency, amt: back }, { acct: ACCT.M_AVAIL, mid: d.merchant_id, cur: d.currency, amt: -back }], { ref: p.id, memo: `Dispute ${cd.state.toLowerCase().replace('_', ' ')}` });
      d.returned = back; p.status = p.refunded ? 'partially_refunded' : (p.settled ? 'settled' : 'captured'); addEvent(p, 'dispute_won', `Dispute ${cd.state}; ${fmt(back, d.currency)} returned`); store.put('payments', p);
    }
    if (prev !== cd.state && ['LOST', 'ACCEPTED'].includes(cd.state)) { p.status = 'chargeback_lost'; addEvent(p, 'chargeback_lost', `Dispute ${cd.state.toLowerCase()}`); store.put('payments', p); }
    store.put('disputes', d);
    if (prev && prev !== cd.state) emit(d.merchant_id, mode, 'dispute.updated', publicDispute(d));
    return d;
  });
}
async function disputeAction(d, action, { text, category } = {}, actor) {
  if (d.status !== 'needs_response') throw bad('This dispute no longer accepts a response.');
  const api = CA.client(d.mode), opt = { mid: d.merchant_id, op: 'dispute_' + action };
  if (action === 'evidence') {
    const t = U.str(text, 500); if (t.length < 10) throw bad('Describe your evidence (10–500 characters).');
    const cat = /^[A-Z_]{3,60}$/.test(category || '') ? category : 'GENERIC_EVIDENCE';
    await api.createDisputeEvidenceText(d.cashapp_dispute_id, { idempotency_key: id('dev'), evidence: { category: cat, text: t } }, opt).catch(caError);
    d.evidence.push({ at: now(), category: cat, text: t }); store.put('disputes', d); audit(actor, 'dispute.evidence', d.id, cat, d.merchant_id); return d;
  }
  const cd = await (action === 'accept' ? api.acceptDispute(d.cashapp_dispute_id, opt) : api.challengeDispute(d.cashapp_dispute_id, opt)).catch(caError);
  audit(actor, 'dispute.' + action, d.id, '', d.merchant_id);
  return applyCashAppDispute(d.mode, cd);
}

/* ---------------- inbound Cash App events ---------------- */
async function handleCashAppEvent(evt, mode) {
  const obj = evt.data?.object || {};
  if (obj.request) {
    const p = store.byKey('payments', obj.request.id);
    if (p && p.mode === mode && p.status === 'awaiting_customer') {
      // Webhook payloads may omit grants: fetch the request to read them.
      const full = obj.request.status === 'APPROVED' && !obj.request.grants?.length ? await CA.client(mode).retrieveCustomerRequest(obj.request.id, { mid: p.merchant_id, op: 'retrieve_request' }) : obj.request;
      await applyCustomerRequest(p, full);
    }
    return { handled: 'customer_request', payment: p?.id || null };
  }
  if (obj.payment) {
    const p = store.get('payments', obj.payment.reference_id) || findByCashAppPayment(mode, obj.payment.id);
    if (p && p.mode === mode) applyCashAppPayment(p, obj.payment);
    return { handled: 'payment', payment: p?.id || null };
  }
  if (obj.refund) {
    const r = store.get('refunds', obj.refund.reference_id) || store.list('refunds', { mode }, { limit: 5000 }).find(x => x.cashapp_refund_id === obj.refund.id);
    if (r && r.mode === mode) applyCashAppRefund(r.id, obj.refund);
    return { handled: 'refund', refund: r?.id || null };
  }
  if (obj.dispute) { const d = applyCashAppDispute(mode, obj.dispute); return { handled: 'dispute', dispute: d?.id || null }; }
  if (obj.merchant) {
    const m = store.list('merchants', {}, { limit: 10000 }).map(normalizeMerchant).find(x => x.cashapp[mode]?.merchant_id === obj.merchant.id);
    if (m) { m.cashapp[mode].status = obj.merchant.status; store.put('merchants', m); audit('cashapp', 'cashapp.merchant_status', m.id, obj.merchant.status, m.id); }
    return { handled: 'merchant', merchant: m?.id || null };
  }
  return { handled: 'ignored' };
}
const simQueue = [];
CA.setSimEventSink(e => simQueue.push(e));
async function flushSimEvents() {
  while (simQueue.length) {
    const e = simQueue.shift();
    store.put('provider_events', { id: id('pev'), k: `cashapp:test:${e.event_id}`, status: 'processed', provider: 'cashapp', mode: 'test', type: e.type, sig: 'simulator', payment_id: null });
    await handleCashAppEvent(e, 'test');
  }
}

/* ---------------- settlement ----------------
   Cash App settles to the partner; the wallet moves funds pending → available when a settlement is
   recorded. Test mode settles automatically after two sandbox days so the flow can be exercised. */
function settlePayment(p, memo, reference) {
  return store.tx(() => {
    if (p.settled || !['captured', 'partially_refunded', 'refunded', 'disputed'].includes(p.status) || p.method !== 'cashapp') return false;
    const m = merchant(p.merchant_id), pend = p.pendingRemaining, reserve = pct(pend, m.reserve.pct);
    L.post(p.mode, `${p.id}:settle`, [
      { acct: ACCT.P_CASH, cur: p.currency, amt: p.rcvRemaining }, { acct: ACCT.ACQ_RCV, cur: p.currency, amt: -p.rcvRemaining },
      { acct: ACCT.M_PENDING, mid: m.id, cur: p.currency, amt: pend }, { acct: ACCT.M_AVAIL, mid: m.id, cur: p.currency, amt: -(pend - reserve) }, { acct: ACCT.M_RESERVE, mid: m.id, cur: p.currency, amt: -reserve },
    ], { ref: p.id, memo });
    Object.assign(p, { settled: true, settled_at: now(), settlement_ref: reference || null, reserve, reserve_release_at: now() + m.reserve.days * dayMs(p.mode), pendingRemaining: 0, rcvRemaining: 0 });
    if (p.status === 'captured') p.status = 'settled';
    addEvent(p, 'settled', `${fmt(pend - reserve, p.currency)} available, ${fmt(reserve, p.currency)} reserve${reference ? ` · ref ${reference}` : ''}`); store.put('payments', p);
    return true;
  });
}
/** Records a Cash App settlement (deposit to the client's bank): every captured, unsettled payment up to `before`. */
function recordSettlement({ mode, merchantId, before, reference }, actor) {
  const ref = U.str(reference, 120); if (!ref) throw bad('Enter the Cash App settlement reference.');
  const cutoff = Number(before) || now(); let n = 0, total = 0;
  for (const p of store.list('payments', { mode, ...(merchantId ? { merchant_id: merchantId } : {}), status: ['captured', 'partially_refunded', 'refunded', 'disputed'] }, { limit: 20000, asc: true })) {
    if (p.method !== 'cashapp' || p.settled || p.captured_at > cutoff) continue;
    const pend = p.pendingRemaining; if (settlePayment(p, `Cash App settlement ${ref}`, ref)) { n++; total += pend; }
  }
  audit(actor, 'settlement.record', ref, `${n} payments, ${fmt(total, 'USD')} net`, merchantId || null);
  return { settled: n, net_total: total, reference: ref };
}
function runSettlement(mode) {
  let settled = 0, released = 0;
  if (mode === 'test') for (const p of store.list('payments', { mode, status: ['captured', 'partially_refunded', 'refunded'] }, { limit: 2000, asc: true })) {
    if (p.settled || now() - p.captured_at < 2 * dayMs(mode)) continue;
    if (settlePayment(p, 'Sandbox settlement (simulated)')) settled++;
  }
  for (const p of store.list('payments', { mode, status: ['settled', 'partially_refunded', 'refunded', 'disputed', 'chargeback_lost'] }, { limit: 5000, asc: true })) {
    if (!p.reserve || p.reserve_released || now() < p.reserve_release_at) continue;
    store.tx(() => { L.post(mode, `${p.id}:reserve_release`, [{ acct: ACCT.M_RESERVE, mid: p.merchant_id, cur: p.currency, amt: p.reserve }, { acct: ACCT.M_AVAIL, mid: p.merchant_id, cur: p.currency, amt: -p.reserve }], { ref: p.id, memo: 'Rolling reserve released' }); p.reserve_released = true; store.put('payments', p); released++; });
  }
  return { settled, released };
}

/* ---------------- idempotency for API POSTs ---------------- */
async function idempotent(mid, mode, key, fingerprint, fn) {
  if (!key) return fn();
  if (key.length > 255) throw bad('Idempotency-Key is too long.');
  const row = store.db.prepare('SELECT fingerprint, status, response FROM idempotency WHERE merchant_id=? AND mode=? AND key=?').get(mid, mode, key);
  if (row) {
    if (row.fingerprint !== fingerprint) throw new HttpError(422, 'idempotency_key_reused', 'This Idempotency-Key was used with different parameters.');
    return { replay: true, status: row.status, body: JSON.parse(row.response) };
  }
  const out = await fn();
  if ((out.status || 200) < 500) store.db.prepare('INSERT INTO idempotency (merchant_id, mode, key, fingerprint, status, response, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(mid, mode, key, fingerprint, out.status || 200, JSON.stringify(out.body), now());
  return out;
}

/* ---------------- background jobs ---------------- */
async function runCashAppSync() {
  for (const p of store.list('payments', { status: [...IN_FLIGHT, 'authorized'] }, { limit: 40, asc: true })) {
    if (p.method !== 'cashapp') continue;
    if (p.status === 'authorized' && now() - (p.cashapp.last_sync || 0) < 60000) continue;
    await syncPayment(p);
  }
  await retryPendingRefunds();
  CA.sim.runDisputes();
  await flushSimEvents();
}
function runExpiry() {
  for (const s of store.list('checkout_sessions', { status: 'open' }, { limit: 1000, asc: true })) if (now() > s.expires_at) { s.status = 'expired'; store.put('checkout_sessions', s); emit(s.merchant_id, s.mode, 'checkout.session.expired', publicSession(s)); }
}

function privateIp(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:') && privateIp(ip.slice(7));
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function assertWebhookTarget(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(config.allowPrivateWebhooks && u.protocol === 'http:')) throw new Error('Webhook URLs must use HTTPS.');
  if (config.allowPrivateWebhooks) return;
  const { address } = await dns.lookup(u.hostname);
  if (privateIp(address)) throw new Error('Webhook URL resolves to a private network address.');
}
let delivering = false;
async function runDeliveries() {
  if (delivering) return; delivering = true;
  try {
    const due = store.list('deliveries', { status: ['pending', 'retrying'] }, { limit: 200, asc: true }).filter(d => d.next_at <= now()).slice(0, 25);
    for (const d of due) {
      const ep = store.get('webhook_endpoints', d.endpoint_id), evt = store.get('events', d.event_id);
      if (!ep || ep.status !== 'enabled' || !evt) { d.status = 'failed'; d.error = 'Endpoint removed or disabled'; store.put('deliveries', d); continue; }
      const body = JSON.stringify(publicEvent(evt)), t = Math.floor(now() / 1000), sig = U.hmacHex(U.unseal(ep.secret), `${t}.${body}`);
      d.attempts++; d.last_attempt = now();
      try {
        await assertWebhookTarget(ep.url);
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
        const r = await fetch(ep.url, { method: 'POST', redirect: 'manual', signal: ctrl.signal, headers: { 'content-type': 'application/json', 'user-agent': 'DigitalHub-Webhooks/1.0', 'DigitalHub-Signature': `t=${t},v1=${sig}`, 'DigitalHub-Event-Id': evt.id }, body });
        clearTimeout(timer); d.code = r.status; d.error = null;
        d.status = r.status >= 200 && r.status < 300 ? 'delivered' : null;
      } catch (e) { d.code = null; d.error = e.name === 'AbortError' ? 'Timed out after 10s' : e.message; d.status = null; }
      if (!d.status) { d.status = d.attempts >= 6 ? 'failed' : 'retrying'; d.next_at = now() + Math.pow(2, d.attempts) * 60000; }
      store.put('deliveries', d);
    }
  } finally { delivering = false; }
}

/* ---------------- reconciliation ---------------- */
function reconChecks(mode) {
  const out = [], eq = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => (a[k] || 0) === (b[k] || 0));
  const tb = L.trialBalance(mode);
  out.push({ name: 'Every journal balances', ok: tb.every(r => r.debits === r.credits), detail: 'Debits equal credits in every currency.' });
  const pays = store.list('payments', { mode }, { limit: 100000 }), rcv = {}, pend = {};
  for (const p of pays) {
    if (p.settled) continue;
    if (p.rcvRemaining) rcv[p.currency] = (rcv[p.currency] || 0) + p.rcvRemaining;
    if (p.pendingRemaining) pend[p.currency] = (pend[p.currency] || 0) - p.pendingRemaining;
  }
  out.push({ name: 'Cash App receivable = captured, unsettled payments', ok: eq(L.sumAccount(mode, ACCT.ACQ_RCV), rcv), detail: 'Money owed by Cash App matches captured payments not yet settled.' });
  out.push({ name: 'Awaiting settlement = unsettled net', ok: eq(L.sumAccount(mode, ACCT.M_PENDING), pend), detail: 'The wallet awaiting-settlement balance equals the net of captured payments Cash App has not settled yet.' });
  const stuck = pays.filter(p => p.status === 'processing' && now() - p.created_at > 15 * 60000).length;
  out.push({ name: 'No Cash App payments stuck in processing', ok: true, warn: stuck > 0, detail: stuck ? `${stuck} payment(s) approved by the customer but not confirmed by Cash App for 15+ minutes.` : 'Every approved request has a confirmed Cash App payment.' });
  const settledBal = accountId() ? (L.merchantBalances(accountId(), mode).USD?.available || 0) : 0;
  out.push({ name: 'Settled balance is not negative', ok: true, warn: settledBal < 0, detail: settledBal < 0 ? `Refunds and disputes exceed recorded settlements by ${fmt(-settledBal)}. Record the latest Cash App settlement.` : 'Refunds and disputes are covered by recorded settlements.' });
  return out;
}

module.exports = { PAID, IN_FLIGHT, now, dayMs, platform, setPlatform, audit, alert, emit, publicEvent, newMerchant, normalizeMerchant, merchant, account, accountId, isAccount, SINGLE_DEFAULTS,
  liveReady, cashappReady, assertMode, methodAvailable, validateDetails, registerCashApp, controlCheck, publicSession, publicPayment, publicRefund, publicLink, publicDispute,
  createSession, createLink, linkActive, startCashApp, syncPayment, applyCashAppPayment, applyCashAppRefund, applyCashAppDispute, handleCashAppEvent, flushSimEvents, capture, cancel,
  maxRefundable, refund, disputeAction, settlePayment, recordSettlement, idempotent, runSettlement, runExpiry, runCashAppSync, runDeliveries, assertWebhookTarget, reconChecks, FIAT };
