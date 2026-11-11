'use strict';
/* Domain services. Everything that changes money goes through the ledger inside a transaction. */
const dns = require('node:dns').promises;
const net = require('node:net');
const config = require('./config');
const store = require('./db');
const L = require('./ledger');
const { ACCT } = L;
const U = require('./util');
const { DAY, id, rid, HttpError, bad, convert, toUSD, pct, fmt, FIAT, STABLE, CURRENCIES } = U;
const P = require('./providers');

const PAID = ['authorized', 'captured', 'settled', 'confirmed', 'overpaid', 'partially_refunded', 'refunded', 'disputed', 'chargeback_lost'];
const now = () => Date.now();
const dayMs = mode => mode === 'test' ? config.sandboxDayMs : DAY;

/* ---------------- platform settings ---------------- */
const PLATFORM_DEFAULT = {
  networksEnabled: Object.fromEntries(Object.keys(P.NETWORKS).map(k => [k, true])),
  approvalThresholdUSD: 1000000,               // minor units ($10,000)
  risk: { declineCount: 3, highValueUSD: 500000 },
  defaults: { cardPlatPct: 1.0, cryptoPlatPct: 1.0, fxSpreadBps: 25, reservePct: 5, reserveDays: 90 },
};
let platformCache = null; // short cache: read on most requests, one DB round trip each
const platform = () => { if (!platformCache || Date.now() - platformCache.at > 5000) platformCache = { v: store.getMeta('platform', {}), at: Date.now() }; return structuredClone({ ...PLATFORM_DEFAULT, ...platformCache.v }); };
const setPlatform = v => { const next = { ...platform(), ...v }; store.setMeta('platform', next); platformCache = null; };

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

/* ---------------- merchants ---------------- */
function newMerchant({ name, legal_name, country, website, support_email }) {
  const d = platform().defaults;
  return {
    id: id('acct'), status: 'pending', name, legal_name, country, website, support_email, mcc: '5999', live_enabled: false, risk: 'medium',
    perms: { card: true, crypto: true, payouts: true, refunds: true, links: true, api: true },
    limits: { perTxnUSD: 1000000, dailyUSD: 5000000, monthlyUSD: 50000000, refundDailyUSD: 1000000 },
    controls: { velocityPerHour: 10, blockedCountries: [] },
    fees: { card: { acqPct: 2.2, acqFixedUSD: 20, platPct: d.cardPlatPct }, crypto: { provPct: 0.5, platPct: d.cryptoPlatPct }, fxSpreadBps: d.fxSpreadBps, disputeFeeUSD: 1500 },
    reserve: { pct: d.reservePct, days: d.reserveDays }, captureMode: 'auto', threeDS: { mode: 'always', riskThreshold: 45, lowValueExemption: true }, non3ds: null,
    cryptoProvider: 'binance', providers: { card_acquirer: 'not_requested', binance: 'not_requested', coinbase: 'not_requested', soneri: 'not_requested' },
    settlementHold: null, minPayout: 5000, dualControl: false, receiving: { test: null, live: null },
    kyb: { submitted: false, business: {}, owners: [], checks: { registration: false, owners: false, website: false, sanctions: false, bank: false }, aml: { status: 'pending', at: null } },
  };
}
const merchant = mid => { const m = store.get('merchants', mid); if (!m) throw new HttpError(404, 'not_found', 'Merchant not found'); return m; };
const kybReady = m => Object.values(m.kyb.checks).every(Boolean) && m.kyb.owners.length > 0 && m.kyb.owners.every(o => o.idStatus === 'verified') && m.kyb.aml.status === 'clear';
function liveReady(m) {
  if (!config.livePayments) return 'Live payments are switched off on this platform (LIVE_PAYMENTS=0).';
  if (require('./chain').settings().platformMode !== 'live') return 'Base Mainnet is not switched on yet (Super Admin → Settings → MetaMask).';
  if (m.status !== 'approved') return 'Business verification is not approved.';
  if (!m.live_enabled) return 'Digital Hub has not activated live mode for this account.';
  return null;
}
function assertMode(m, mode) {
  if (m.status === 'suspended' || m.status === 'rejected') throw new HttpError(403, 'account_inactive', `This account is ${m.status}.`);
  if (mode === 'live') { const why = liveReady(m); if (why) throw new HttpError(403, 'live_mode_unavailable', why); }
}

/* ---------------- controls & risk ---------------- */
/* Payment methods. This phase runs MetaMask USDC on Base only; card processing and the Binance Pay / Coinbase /
   sandbox crypto rails stay in the codebase but are switched off in chain settings (providers.*). */
const METHODS = ['usdc', 'card', 'crypto'];
function methodAvailable(m, mode, method) {
  const chain = require('./chain'), prov = chain.settings().providers;
  if (method === 'usdc') {
    if (!prov.metamask_usdc || !m.perms.crypto) return false;
    if (!chain.net(chain.networkFor(mode)).enabled) return false;
    if (mode === 'live' && chain.settings().platformMode !== 'live') return false;
    return !!require('./usdc').receivingWallet(m, mode);
  }
  if (method === 'card') return !!prov.card && m.perms.card && mode === 'test'; // sandbox test cards only; live cards need a connected acquirer (hosted fields)
  if (!(prov.binance || prov.coinbase || prov.sandbox_crypto)) return false;
  if (!m.perms.crypto) return false;
  if (mode === 'test') return cryptoOptions(m).length > 0;
  const rail = P.CRYPTO[m.cryptoProvider];
  return m.providers[m.cryptoProvider] === 'approved' && !!rail?.configured?.() && cryptoOptions(m).length > 0;
}
function cryptoOptions(m) {
  const nets = (P.CRYPTO[m.cryptoProvider] || P.CRYPTO.sandbox).networks, enabled = platform().networksEnabled, out = [];
  for (const n of nets) if (enabled[n]) for (const a of P.NETWORKS[n].assets) out.push([a, n]);
  return out;
}
function volumeUSD(mid, mode, ms) {
  return store.list('payments', { merchant_id: mid, mode, status: PAID, since: now() - ms }, { limit: 5000 }).reduce((s, p) => s + toUSD(p.amount, p.currency), 0);
}
function controlCheck(m, mode, amount, currency, customer) {
  const usd = toUSD(amount, currency), Lm = m.limits;
  if (usd > Lm.perTxnUSD) return `Amount exceeds this merchant's per-transaction limit of ${fmt(Lm.perTxnUSD, 'USD')}.`;
  if (volumeUSD(m.id, mode, DAY) + usd > Lm.dailyUSD) return `Daily volume limit (${fmt(Lm.dailyUSD, 'USD')}) would be exceeded.`;
  if (volumeUSD(m.id, mode, 30 * DAY) + usd > Lm.monthlyUSD) return `30-day volume limit (${fmt(Lm.monthlyUSD, 'USD')}) would be exceeded.`;
  if (customer) {
    if (m.controls.blockedCountries.includes(customer.country)) return 'Payments from this country are not accepted for this merchant.';
    const n = store.list('payments', { merchant_id: m.id, mode, since: now() - 3600000 }, { limit: 1000 }).filter(p => p.customer?.email === customer.email).length;
    if (n >= m.controls.velocityPerHour) return 'Too many payment attempts. Try again later.';
  }
  return null;
}
function riskScore(m, mode, amount, currency, card, customer) {
  let s = 8; const why = ['base 8'], usd = toUSD(amount, currency);
  if (usd > 50000) { s += 40; why.push('amount > $500 (+40)'); } else if (usd > 20000) { s += 18; why.push('amount > $200 (+18)'); }
  if (card && customer.country && card.country !== customer.country) { s += 22; why.push('card/billing country mismatch (+22)'); }
  const declines = store.list('payments', { merchant_id: m.id, mode, status: 'declined', since: now() - DAY }, { limit: 500 }).filter(p => p.customer?.email === customer.email).length;
  if (declines) { s += 15 * declines; why.push(`${declines} recent decline(s)`); }
  if (m.risk === 'high') { s += 15; why.push('merchant risk tier high (+15)'); }
  return { score: Math.min(s, 99), why };
}
const non3dsAuthorized = m => !!m.non3ds?.ref;
function decide3DS(m, card, amount, currency, risk) {
  const tc = P.TEST_CARDS[card.number] || { exemption: true };
  if (m.threeDS.mode === 'always') return { run: true, reason: 'Merchant policy: authenticate every card payment.' };
  if (P.SCA.has(card.country)) {
    if (m.threeDS.lowValueExemption && convert(amount, currency, 'EUR') < 3000 && tc.exemption) return { run: false, exemption: 'low_value', reason: 'Low-value exemption accepted by issuer (SCA region).' };
    return { run: true, reason: 'Issuer is in an SCA region: 3DS required.' };
  }
  if (!non3dsAuthorized(m)) return { run: true, reason: 'No acquirer authorization for non-3DS on file, so 3DS runs.' };
  if (risk.score >= m.threeDS.riskThreshold) return { run: true, reason: `Risk score ${risk.score} ≥ ${m.threeDS.riskThreshold}: step-up to 3DS.` };
  return { run: false, exemption: 'non_3ds', reason: `Non-3DS permitted under acquirer approval ${m.non3ds.ref}; fraud liability stays with merchant.` };
}
function feeQuote(m, method, amount, currency) {
  if (method === 'card') { const f = m.fees.card; const provider = pct(amount, f.acqPct) + convert(f.acqFixedUSD, 'USD', currency), platformFee = pct(amount, f.platPct); return { provider, platform: platformFee, net: amount - provider - platformFee }; }
  const f = m.fees.crypto; const provider = pct(amount, f.provPct), platformFee = pct(amount, f.platPct); return { provider, platform: platformFee, net: amount - provider - platformFee };
}

/* ---------------- public representations ---------------- */
const ts = t => t ? Math.floor(t / 1000) : null;
function publicSession(s) {
  return { id: s.id, object: 'checkout.session', livemode: s.mode === 'live', url: `${config.publicUrl}/pay/${s.id}`, status: s.status, amount: s.amount, currency: s.currency, description: s.description,
    payment_methods: s.methods, payment: s.payment_id || null, payment_status: s.payment_status || 'unpaid', customer_email: s.customer_email || null, metadata: s.metadata || {},
    success_url: s.success_url, cancel_url: s.cancel_url, payment_link: s.link_id || null, expires_at: ts(s.expires_at), created: ts(s.created_at) };
}
function publicPayment(p) {
  return { id: p.id, object: 'payment', livemode: p.mode === 'live', status: p.status, amount: p.amount, currency: p.currency, method: p.method, description: p.description,
    amount_refunded: p.refunded, net: p.net, fees: p.fees, customer: { name: p.customer?.name, email: p.customer?.email, country: p.customer?.country }, metadata: p.metadata || {},
    checkout_session: p.session_id, payment_link: p.link_id || null, decline_code: p.declineCode || null,
    card: p.card ? { brand: p.card.brand, last4: p.card.last4, country: p.card.country, exp_month: p.card.exp_month || null, exp_year: p.card.exp_year || null, cardholder: p.card.holder || null, three_d_secure: p.card.threeDS?.result || null, auth_code: p.card.authCode || null, off_session: !!p.card.off_session } : null,
    crypto: p.crypto ? { provider: p.crypto.provider, asset: p.crypto.asset, network: p.crypto.network, amount_due: p.crypto.quoteAmount, amount_received: p.crypto.received, confirmations: p.crypto.confirmations, confirmations_required: p.crypto.required,
      ...(p.method === 'usdc' ? { chain_id: p.crypto.chain_id, token: p.crypto.token, payer: p.crypto.payer, recipient: p.crypto.recipient, amount_due_units: p.crypto.amountUnits, amount_received_units: p.crypto.receivedUnits,
        excess: p.crypto.excess || 0, transactions: p.crypto.txs.map(t => ({ hash: t.hash, status: t.status, block: t.blockNumber || null, confirmations: t.confirmations || 0, amount_units: t.valueUnits || null, reason: t.reason || null })) } : {}) } : null,
    created: ts(p.created_at) };
}
const publicRefund = r => ({ id: r.id, object: 'refund', livemode: r.mode === 'live', status: r.status, payment: r.payment_id, amount: r.amount, currency: r.currency, reason: r.reason || null, created: ts(r.created_at) });
const publicLink = l => ({ id: l.id, object: 'payment_link', livemode: l.mode === 'live', active: l.status === 'active', url: `${config.publicUrl}/l/${l.k}`, amount: l.amount, currency: l.currency, description: l.description, payment_methods: l.methods, reusable: l.reusable, expires_at: ts(l.expires_at), created: ts(l.created_at) });
const publicPayout = po => ({ id: po.id, object: 'payout', livemode: po.mode === 'live', status: po.status, amount: po.amount, currency: po.currency, destination_currency: po.dest_currency, amount_received: po.receive, fee: po.fee, destination: po.dest_label, reference: po.reference || null, created: ts(po.created_at) });

/* ---------------- checkout sessions & links ---------------- */
function createSession(m, mode, input, actor = 'api') {
  assertMode(m, mode);
  const amount = Number(input.amount), currency = String(input.currency || '').toUpperCase();
  if (!Number.isInteger(amount) || amount < 50) throw bad('amount must be an integer in minor units, at least 50 (0.50).', 'amount_invalid');
  if (amount > 100000000) throw bad('amount is too large.', 'amount_invalid');
  if (!FIAT.includes(currency)) throw bad(`currency must be one of ${FIAT.join(', ')}.`, 'currency_invalid');
  for (const k of ['success_url', 'cancel_url']) if (input[k] && !U.isUrl(input[k])) throw bad(`${k} must be an http(s) URL.`, 'url_invalid');
  let methods = [].concat(input.payment_methods || input.methods || ['usdc', 'card']).map(String).filter(x => METHODS.includes(x));
  methods = methods.filter(x => methodAvailable(m, mode, x));
  if (currency !== 'USD' && methods.includes('usdc') && methods.some(x => x !== 'usdc')) methods = methods.filter(x => x !== 'usdc');
  if (!methods.length) throw bad(require('./usdc').receivingWallet(m, mode) || mode === 'live' ? 'No requested payment method is available for this account in this mode. This platform accepts USDC via MetaMask (payment_methods: ["usdc"]).' : 'USDC checkout needs a verified receiving wallet: Dashboard → Receiving wallet → verify with MetaMask.', 'no_payment_method');
  if (methods.includes('usdc') && currency !== 'USD') throw bad('USDC checkout is priced in USD (1 USDC = 1 USD, no conversion). Use currency USD.', 'currency_unsupported');
  const block = controlCheck(m, mode, amount, currency, null); if (block) throw bad(block, 'limit_exceeded');
  const metadata = {}; for (const [k, v] of Object.entries(input.metadata || {}).slice(0, 20)) metadata[U.str(k, 40)] = U.str(v, 500);
  const s = store.put('checkout_sessions', { id: 'cs_' + rid(28), merchant_id: m.id, mode, status: 'open', amount, currency, description: U.str(input.description || 'Payment', 200), methods,
    success_url: input.success_url || null, cancel_url: input.cancel_url || null, metadata, customer_email: U.isEmail(input.customer_email) ? input.customer_email : null,
    link_id: input.link_id || null, payment_id: null, card_attempts: 0, expires_at: now() + 24 * 3600000 });
  audit(actor, 'checkout_session.create', s.id, fmt(amount, currency), m.id);
  return s;
}
function createLink(m, mode, input, actor) {
  assertMode(m, mode);
  if (!m.perms.links) throw new HttpError(403, 'links_disabled', 'Payment links are disabled for this account.');
  const amount = Number(input.amount), currency = String(input.currency || '').toUpperCase();
  if (!Number.isInteger(amount) || amount < 50) throw bad('amount must be an integer in minor units, at least 50.', 'amount_invalid');
  if (!FIAT.includes(currency)) throw bad(`currency must be one of ${FIAT.join(', ')}.`, 'currency_invalid');
  const description = U.str(input.description, 200); if (!description) throw bad('description is required.');
  const methods = [].concat(input.payment_methods || ['usdc', 'card']).filter(x => METHODS.includes(x));
  if (!methods.length) throw bad('Choose at least one payment method.');
  if (methods.length === 1 && methods[0] === 'usdc' && currency !== 'USD') throw bad('USDC payment links are priced in USD.', 'currency_unsupported');
  const days = Number(input.expires_in_days || 0);
  const l = store.put('links', { id: id('plink'), merchant_id: m.id, mode, status: 'active', k: rid(24, 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'), amount, currency, description, methods,
    reusable: !!input.reusable, expires_at: days > 0 ? now() + days * DAY : null, payments: [] });
  audit(actor, 'payment_link.create', l.id, fmt(amount, currency), m.id);
  return l;
}
const linkActive = l => l.status === 'active' && (!l.expires_at || now() < l.expires_at);

/* ---------------- card payments (sandbox acquirer) ---------------- */
function newPayment(s, method, customer) {
  const p = { id: id('pay'), merchant_id: s.merchant_id, mode: s.mode, status: 'created', session_id: s.id, link_id: s.link_id, method, amount: s.amount, currency: s.currency, description: s.description,
    customer, metadata: s.metadata, fees: null, net: null, refunded: 0, settled: false, events: [] };
  addEvent(p, 'created', `Checkout session ${s.id}`);
  return p;
}
const addEvent = (p, status, note = '') => p.events.push({ at: now(), status, note });
function sessionPayable(s) {
  if (s.status !== 'open') throw new HttpError(409, 'session_closed', s.status === 'complete' ? 'This checkout is already paid.' : 'This checkout has expired.');
  if (now() > s.expires_at) throw new HttpError(409, 'session_expired', 'This checkout has expired.');
  if (s.payment_id) { const p = store.get('payments', s.payment_id); if (p && ['authorized', 'captured', 'confirming', 'awaiting_payment', 'requires_action', ...(p.method === 'usdc' ? ['underpaid'] : [])].includes(p.status)) throw new HttpError(409, 'payment_in_progress', 'A payment for this checkout is already in progress.'); }
}
function cardPay(s, input) {
  return store.tx(() => {
    const m = merchant(s.merchant_id); assertMode(m, s.mode); sessionPayable(s);
    if (!s.methods.includes('card') || !methodAvailable(m, s.mode, 'card')) throw bad('Card payments are not available for this checkout.');
    if (s.mode !== 'test') throw bad('Live card processing is pending acquirer integration.', 'card_unavailable');
    if (++s.card_attempts > 8) { store.put('checkout_sessions', s); throw new HttpError(429, 'too_many_attempts', 'Too many card attempts for this checkout.'); }
    store.put('checkout_sessions', s);
    const number = String(input.number || '').replace(/\D/g, '');
    if (!/^\d{13,19}$/.test(number) || !U.luhn(number)) throw bad('Card number is invalid.', 'card_number_invalid');
    const tc = P.TEST_CARDS[number];
    if (!tc) throw bad('Sandbox accepts test cards only. Real card numbers are never processed here.', 'test_card_required');
    const exp = String(input.exp || ''), mm = +exp.slice(0, 2), yy = +exp.slice(-2);
    if (!/^\d{2}\s?\/\s?\d{2}$/.test(exp) || mm < 1 || mm > 12 || new Date(2000 + yy, mm, 1).getTime() <= now()) throw bad('Expiry is invalid or in the past.', 'expiry_invalid');
    if (!/^\d{3,4}$/.test(String(input.cvc || ''))) throw bad('Security code is invalid.', 'cvc_invalid');
    const customer = customerFrom(input);
    const block = controlCheck(m, s.mode, s.amount, s.currency, customer);
    if (block) { alert('low', 'control_block', m.id, s.id, block, s.mode); throw bad(block, 'blocked_by_controls'); }
    const card = { number, brand: tc.brand, country: tc.country };
    const p = newPayment(s, 'card', customer);
    p.card = { brand: tc.brand, last4: number.slice(-4), bin: number.slice(0, 6), country: tc.country, exp_month: mm, exp_year: 2000 + yy, holder: customer.name, off_session: !!input.offSession };
    if (input.save_card && s.metadata?.subscription_id) p.card.save_for = s.metadata.subscription_id;
    p.risk = riskScore(m, s.mode, s.amount, s.currency, card, customer);
    const d = decide3DS(m, card, s.amount, s.currency, p.risk);
    p.card.threeDS = { required: d.run, reason: d.reason, exemption: d.exemption || null };
    s.payment_id = p.id; store.put('checkout_sessions', s);
    if (d.run && tc.threeDS === 'challenge' && input.offSession) {
      // automatic renewal: nobody is there to complete a challenge, so the issuer's request is a decline
      p.card.threeDS = { ...p.card.threeDS, result: 'required_off_session' };
      p.status = 'declined'; p.declineCode = 'authentication_required'; addEvent(p, 'declined', 'Issuer requires 3DS authentication; customer must pay from the invoice link');
      store.put('payments', p); emit(m.id, p.mode, 'payment.failed', publicPayment(p)); return p;
    }
    if (d.run && tc.threeDS === 'challenge') {
      p.status = 'requires_action'; p.card.pendingNumber = U.seal(number); addEvent(p, 'requires_action', '3DS challenge issued by issuer ACS');
      store.put('payments', p); return p;
    }
    if (d.run) Object.assign(p.card.threeDS, { result: 'authenticated', flow: 'frictionless', liability: 'issuer' });
    else Object.assign(p.card.threeDS, { result: 'not_performed', liability: 'merchant' });
    addEvent(p, d.run ? 'authenticated' : '3ds_skipped', d.reason);
    return authorize(p, m, s, number, 'ok');
  });
}
function customerFrom(input) {
  const c = { name: U.str(input.name, 120), email: U.str(input.email, 200).toLowerCase(), country: U.str(input.country, 2).toUpperCase() };
  if (c.name.length < 2) throw bad('Enter your name.', 'name_required');
  if (!U.isEmail(c.email)) throw bad('Enter a valid email address.', 'email_invalid');
  return c;
}
function complete3DS(p, code) {
  return store.tx(() => {
    if (p.status !== 'requires_action') throw bad('No authentication pending.');
    const m = merchant(p.merchant_id), s = store.get('checkout_sessions', p.session_id), number = U.unseal(p.card.pendingNumber);
    delete p.card.pendingNumber; p.card.threeDS.flow = 'challenge';
    if (String(code) === 'cancel') {
      p.status = 'canceled'; p.card.threeDS.result = 'canceled'; addEvent(p, 'canceled', 'Customer canceled 3DS authentication');
      store.put('payments', p); emit(m.id, p.mode, 'payment.canceled', publicPayment(p)); return p;
    }
    if (String(code) !== '123456') { p.card.threeDS.result = 'failed'; return authorize(p, m, s, number, 'failed'); }
    Object.assign(p.card.threeDS, { result: 'authenticated', liability: 'issuer' }); addEvent(p, 'authenticated', '3DS challenge completed');
    return authorize(p, m, s, number, 'ok');
  });
}
function authorize(p, m, s, number, threeDSResult) {
  const r = P.CardSandbox.authorize({ number, threeDSResult });
  if (!r.ok) {
    p.status = 'declined'; p.declineCode = r.code; addEvent(p, 'declined', r.message); store.put('payments', p);
    emit(m.id, p.mode, 'payment.failed', publicPayment(p));
    const rules = platform().risk;
    if (store.list('payments', { merchant_id: m.id, mode: p.mode, status: 'declined', since: now() - DAY }, { limit: 500 }).filter(x => x.customer.email === p.customer.email).length >= rules.declineCount)
      alert('medium', 'card_testing', m.id, p.id, `${rules.declineCount}+ declines in 24h for ${p.customer.email}`, p.mode);
    return p;
  }
  p.card.authCode = r.authCode; p.status = 'authorized'; p.authorized_at = now(); p.auth_expires_at = now() + 7 * dayMs(p.mode);
  addEvent(p, 'authorized', `Auth code ${r.authCode}`); store.put('payments', p);
  emit(m.id, p.mode, 'payment.authorized', publicPayment(p));
  if (toUSD(p.amount, p.currency) > platform().risk.highValueUSD) alert('medium', 'high_value', m.id, p.id, `High-value card payment ${fmt(p.amount, p.currency)}`, p.mode);
  if (p.card.save_for) { require('./subscriptions').saveCard(p.card.save_for, m.id, { number, exp: `${String(p.card.exp_month).padStart(2, '0')}/${String(p.card.exp_year % 100).padStart(2, '0')}`, brand: p.card.brand, country: p.card.country }); delete p.card.save_for; store.put('payments', p); }
  if (m.captureMode === 'auto') capture(p, 'system');
  completeSession(s, p);
  return p;
}
function capture(p, actor) {
  return store.tx(() => {
    if (p.status !== 'authorized') throw bad('Only authorized payments can be captured.', 'payment_not_capturable');
    const m = merchant(p.merchant_id), f = feeQuote(m, 'card', p.amount, p.currency);
    L.post(p.mode, `${p.id}:capture`, [
      { acct: ACCT.ACQ_RCV, cur: p.currency, amt: p.amount - f.provider },
      { acct: ACCT.M_PENDING, mid: m.id, cur: p.currency, amt: -f.net },
      { acct: ACCT.P_REV, cur: p.currency, amt: -f.platform },
    ], { ref: p.id, memo: 'Card capture (acquirer fee netted)' });
    Object.assign(p, { fees: { provider: f.provider, platform: f.platform }, net: f.net, status: 'captured', captured_at: now(), pendingRemaining: f.net, rcvRemaining: p.amount - f.provider });
    addEvent(p, 'captured', `Net ${fmt(f.net, p.currency)} pending T+2`); store.put('payments', p);
    emit(m.id, p.mode, 'payment.succeeded', publicPayment(p));
    if (actor !== 'system') audit(actor, 'payment.capture', p.id, '', m.id);
    return p;
  });
}
function cancel(p, actor) {
  if (p.status !== 'authorized') throw bad('Only uncaptured authorizations can be canceled.');
  p.status = 'canceled'; addEvent(p, 'canceled', 'Authorization released'); store.put('payments', p);
  audit(actor, 'payment.cancel', p.id, '', p.merchant_id); emit(p.merchant_id, p.mode, 'payment.canceled', publicPayment(p));
  return p;
}
function completeSession(s, p) {
  if (!s || s.status !== 'open') return;
  if (s.payment_id && s.payment_id !== p.id) { const prev = store.get('payments', s.payment_id); if (prev && PAID.includes(prev.status)) return; }
  s.status = 'complete'; s.payment_status = 'paid'; s.payment_id = p.id; store.put('checkout_sessions', s);
  if (s.link_id) { const l = store.get('links', s.link_id); if (l) { l.payments.push(p.id); if (!l.reusable) l.status = 'completed'; store.put('links', l); } }
  emit(s.merchant_id, s.mode, 'checkout.session.completed', publicSession(s));
  if (s.metadata?.subscription_id) require('./subscriptions').onInvoicePaid(s, p);
}

/* ---------------- crypto payments ---------------- */
async function cryptoStart(s, input) {
  const m = merchant(s.merchant_id); assertMode(m, s.mode); sessionPayable(s);
  if (!s.methods.includes('crypto') || !methodAvailable(m, s.mode, 'crypto')) throw bad('Stablecoin payments are not available for this checkout.');
  const customer = customerFrom(input);
  const asset = String(input.asset || '').toUpperCase(), network = String(input.network || '').toUpperCase();
  if (!cryptoOptions(m).some(([a, n]) => a === asset && n === network)) throw bad('That asset / network pair is not offered.', 'pair_unavailable');
  const block = controlCheck(m, s.mode, s.amount, s.currency, customer);
  if (block) { alert('low', 'control_block', m.id, s.id, block, s.mode); throw bad(block, 'blocked_by_controls'); }
  if (s.mode === 'live' && s.currency !== 'USD') throw bad('Live stablecoin checkout supports USD-priced sessions only.', 'currency_unsupported');
  const quoteAmount = s.mode === 'live' ? s.amount : Math.ceil(s.amount / CURRENCIES[s.currency].fx * CURRENCIES[asset].fx);
  const p = newPayment(s, 'crypto', customer);
  const provider = s.mode === 'test' ? 'sandbox' : m.cryptoProvider;
  p.crypto = { provider, route: m.cryptoProvider, asset, network, quoteAmount, received: 0, confirmations: 0, required: P.NETWORKS[network].confirmations,
    expiresAt: now() + 15 * 60000 * (s.mode === 'test' ? 1 : 1), txHashes: [], excess: 0, tradeNo: 'DH' + rid(24, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') };
  const returnUrl = `${config.publicUrl}/pay/${s.id}`;
  if (provider === 'sandbox') p.crypto.address = P.genAddress(network);
  else if (provider === 'binance') Object.assign(p.crypto, await P.BinancePay.createOrder({ tradeNo: p.crypto.tradeNo, amount: quoteAmount, asset, description: s.description, returnUrl, cancelUrl: s.cancel_url || returnUrl }));
  else if (provider === 'coinbase') Object.assign(p.crypto, await P.Coinbase.createCharge({ paymentId: p.id, amount: s.amount, currency: s.currency, description: s.description, returnUrl, cancelUrl: s.cancel_url || returnUrl }));
  p.status = 'awaiting_payment'; addEvent(p, 'awaiting_payment', `Quote ${fmt(quoteAmount, asset)} on ${P.NETWORKS[network].label} via ${P.CRYPTO[provider].name}`);
  store.tx(() => { store.put('payments', p); s.payment_id = p.id; store.put('checkout_sessions', s); });
  emit(m.id, s.mode, 'crypto.payment.created', publicPayment(p));
  return p;
}
/** Funds seen on chain / by provider. Only called from a verified provider event or the sandbox simulator. */
function cryptoDetected(p, amount, viaNetwork) {
  return store.tx(() => {
    if (!['awaiting_payment', 'underpaid'].includes(p.status)) return p;
    if (viaNetwork && viaNetwork !== p.crypto.network) {
      p.status = 'wrong_network'; addEvent(p, 'wrong_network', `Transfer on ${viaNetwork}; invoice expects ${p.crypto.network}. Not credited.`); store.put('payments', p);
      alert('high', 'wrong_network', p.merchant_id, p.id, `Customer sent ${fmt(amount, p.crypto.asset)} on the wrong network`, p.mode);
      return p;
    }
    const n = p.crypto.txHashes.length + 1, tx = (P.NETWORKS[p.crypto.network].addr === 'evm' ? '0x' : '') + rid(64, '0123456789abcdef');
    p.crypto.txHashes.push(tx); p.crypto.received += amount; p.crypto.confirmations = 0;
    L.post(p.mode, `${p.id}:detect:${n}`, [{ acct: ACCT.P_CUSTODY, cur: p.crypto.asset, amt: amount }, { acct: ACCT.C_SUSPENSE, mid: p.merchant_id, cur: p.crypto.asset, amt: -amount }], { ref: p.id, memo: 'Funds detected, held in suspense until confirmed' });
    p.status = 'confirming'; addEvent(p, 'detected', `${fmt(amount, p.crypto.asset)} detected`); store.put('payments', p);
    emit(p.merchant_id, p.mode, 'crypto.payment.detected', publicPayment(p));
    return p;
  });
}
function cryptoTick(p, jump) {
  return store.tx(() => {
    if (p.status !== 'confirming') return p;
    p.crypto.confirmations = Math.min(p.crypto.required, p.crypto.confirmations + (jump || Math.max(1, Math.ceil(p.crypto.required / 5))));
    if (p.crypto.confirmations < p.crypto.required) { store.put('payments', p); return p; }
    const c = p.crypto;
    if (c.received < c.quoteAmount) {
      p.status = 'underpaid'; addEvent(p, 'underpaid', `Received ${fmt(c.received, c.asset)} of ${fmt(c.quoteAmount, c.asset)}`); store.put('payments', p);
      alert('low', 'underpaid', p.merchant_id, p.id, `Underpaid by ${fmt(c.quoteAmount - c.received, c.asset)}`, p.mode);
      emit(p.merchant_id, p.mode, 'crypto.payment.underpaid', publicPayment(p)); return p;
    }
    return cryptoCredit(p, c.quoteAmount, c.received - c.quoteAmount, 'Confirmed at required depth');
  });
}
function cryptoCredit(p, creditAmount, excess, note) {
  const m = merchant(p.merchant_id), c = p.crypto, f = feeQuote(m, 'crypto', creditAmount, c.asset);
  L.post(p.mode, `${p.id}:confirm`, [
    { acct: ACCT.C_SUSPENSE, mid: m.id, cur: c.asset, amt: creditAmount + excess },
    { acct: ACCT.M_AVAIL, mid: m.id, cur: c.asset, amt: -f.net },
    { acct: ACCT.P_REV, cur: c.asset, amt: -f.platform },
    { acct: ACCT.P_CUSTODY, cur: c.asset, amt: -f.provider },
    { acct: ACCT.C_OVERPAY, mid: m.id, cur: c.asset, amt: -excess },
  ], { ref: p.id, memo: excess ? 'Confirmed; excess held for customer refund' : 'Confirmed' });
  Object.assign(p, { fees: { provider: f.provider, platform: f.platform }, net: f.net, settled: true, creditedAmount: creditAmount, status: excess > 0 ? 'overpaid' : 'confirmed', confirmed_at: now() });
  c.excess = excess; addEvent(p, p.status, `${note}. Net ${fmt(f.net, c.asset)} available.`); store.put('payments', p);
  if (excess) alert('low', 'overpaid', m.id, p.id, `Overpaid by ${fmt(excess, c.asset)}`, p.mode);
  emit(m.id, p.mode, 'payment.succeeded', publicPayment(p));
  completeSession(store.get('checkout_sessions', p.session_id), p);
  return p;
}
function cryptoExpire(p) {
  if (p.status !== 'awaiting_payment') return p;
  p.status = 'expired'; addEvent(p, 'expired', 'Quote window closed with no funds received'); store.put('payments', p);
  emit(p.merchant_id, p.mode, 'crypto.payment.expired', publicPayment(p)); return p;
}
function acceptPartial(p, actor) {
  return store.tx(() => { if (p.status !== 'underpaid') throw bad('Payment is not underpaid.'); cryptoCredit(p, p.crypto.received, 0, 'Merchant accepted partial payment'); audit(actor, 'payment.accept_partial', p.id, '', p.merchant_id); return p; });
}
/** Live provider confirmed payment (verified webhook). Credits instantly at provider-confirmed amount. */
function providerPaid(p, amount) {
  return store.tx(() => {
    if (!['awaiting_payment', 'confirming', 'underpaid'].includes(p.status)) return p;
    const amt = amount ?? p.crypto.quoteAmount;
    if (p.status === 'awaiting_payment') { cryptoDetected(p, amt); p = store.get('payments', p.id); }
    return cryptoTick(p, p.crypto.required);
  });
}

/* ---------------- refunds & disputes ---------------- */
function maxRefundable(p) {
  if (p.method === 'card') return ['captured', 'settled', 'partially_refunded'].includes(p.status) ? p.amount - p.refunded : 0;
  return ['confirmed', 'overpaid', 'partially_refunded'].includes(p.status) ? (p.creditedAmount ?? 0) - p.refunded : 0;
}
function refund(p, amount, { actor, reason, address, network }) {
  return store.tx(() => {
    const m = merchant(p.merchant_id), cur = p.method === 'card' ? p.currency : p.crypto.asset;
    if (!m.perms.refunds) throw new HttpError(403, 'refunds_disabled', 'Refunds are disabled for this account.');
    amount = amount == null ? maxRefundable(p) : Number(amount);
    if (!Number.isInteger(amount) || amount <= 0) throw bad('Refund amount must be a positive integer (minor units).');
    if (amount > maxRefundable(p)) throw bad(`The most you can refund is ${fmt(maxRefundable(p), cur)}.`, 'amount_too_large');
    const today = store.list('refunds', { merchant_id: m.id, mode: p.mode, since: now() - DAY }).reduce((s, r) => s + toUSD(r.amount, r.currency), 0);
    if (today + toUSD(amount, cur) > m.limits.refundDailyUSD) throw bad('Daily refund limit reached. Contact Digital Hub.', 'refund_limit');
    const n = store.count('refunds', { merchant_id: m.id }) + 1;
    const r = { id: id('re'), merchant_id: m.id, mode: p.mode, status: 'succeeded', payment_id: p.id, amount, currency: cur, reason: U.str(reason, 100), actor, kind: 'refund' };
    if (p.method === 'card') {
      if (!p.settled && p.refunded === 0 && amount === p.amount) {
        const lines = L.entriesFor(p.id).filter(e => e.journal_key === `${p.id}:capture`).map(e => ({ acct: e.account, mid: e.merchant_id, cur: e.currency, amt: -e.amount }));
        L.post(p.mode, `${p.id}:reversal`, lines, { ref: p.id, memo: 'Reversal before settlement; fees returned' });
        Object.assign(p, { refunded: amount, status: 'reversed', pendingRemaining: 0, rcvRemaining: 0 }); r.kind = 'reversal'; addEvent(p, 'reversed', 'Full reversal before settlement');
      } else if (!p.settled) {
        if (L.balance(m.id, p.mode, ACCT.M_PENDING, cur) < amount) throw bad('Pending balance is too low for this refund.');
        L.post(p.mode, `${p.id}:refund:${n}`, [{ acct: ACCT.M_PENDING, mid: m.id, cur, amt: amount }, { acct: ACCT.ACQ_RCV, cur, amt: -amount }], { ref: p.id, memo: 'Refund before settlement' });
        p.pendingRemaining -= amount; p.rcvRemaining -= amount; p.refunded += amount;
      } else {
        if (L.balance(m.id, p.mode, ACCT.M_AVAIL, cur) < amount) throw bad(`Available ${cur} balance is too low for this refund.`, 'insufficient_balance');
        L.post(p.mode, `${p.id}:refund:${n}`, [{ acct: ACCT.M_AVAIL, mid: m.id, cur, amt: amount }, { acct: ACCT.P_CASH, cur, amt: -amount }], { ref: p.id, memo: 'Refund after settlement' });
        p.refunded += amount;
      }
    } else {
      network = String(network || p.crypto.network).toUpperCase();
      if (!P.NETWORKS[network]?.assets.includes(cur)) throw bad('Choose a refund network that supports this asset.');
      if (!P.validAddress(network, address)) throw bad(`Customer ${network === 'BINANCE_PAY' ? 'Binance Pay ID' : 'address'} is not valid for ${P.NETWORKS[network].label}.`, 'address_invalid');
      const nf = convert(Math.round(P.NETWORKS[network].payoutFeeUSD * 100), 'USD', cur);
      if (L.balance(m.id, p.mode, ACCT.M_AVAIL, cur) < amount + nf) throw bad(`Available ${cur} must cover the refund plus the ${fmt(nf, cur)} network fee.`, 'insufficient_balance');
      L.post(p.mode, `${p.id}:refund:${n}`, [{ acct: ACCT.M_AVAIL, mid: m.id, cur, amt: amount + nf }, { acct: ACCT.P_CUSTODY, cur, amt: -(amount + nf) }], { ref: p.id, memo: `Crypto refund on ${network} incl. network fee` });
      p.refunded += amount; Object.assign(r, { network_fee: nf, address, network });
      if (p.mode === 'live') r.status = 'pending_execution'; // treasury sends on-chain and records the hash
      else r.tx_hash = (P.NETWORKS[network].addr === 'evm' ? '0x' : '') + rid(64, '0123456789abcdef');
    }
    if (r.kind === 'refund') { p.status = p.refunded >= (p.method === 'card' ? p.amount : p.creditedAmount) ? 'refunded' : 'partially_refunded'; addEvent(p, p.status, `Refund ${fmt(amount, cur)}`); }
    store.put('payments', p); store.put('refunds', r);
    audit(actor, 'refund.create', p.id, fmt(amount, cur), m.id);
    emit(m.id, p.mode, 'refund.created', publicRefund(r)); emit(m.id, p.mode, 'payment.refunded', publicPayment(p));
    return r;
  });
}
function openDispute(p, reason, actor) {
  return store.tx(() => {
    if (p.mode !== 'test') throw bad('Disputes arrive from the acquirer in live mode.');
    if (p.method !== 'card' || !p.settled || !['settled', 'partially_refunded'].includes(p.status)) throw bad('Only settled card payments can be disputed.');
    const m = merchant(p.merchant_id), amt = p.amount - p.refunded, fee = convert(m.fees.disputeFeeUSD, 'USD', p.currency);
    const d = store.put('disputes', { id: id('dp'), merchant_id: m.id, mode: p.mode, status: 'needs_response', payment_id: p.id, amount: amt, fee, currency: p.currency, reason, due_at: now() + 7 * dayMs(p.mode), liability: p.card.threeDS?.liability });
    L.post(p.mode, `${d.id}:open`, [{ acct: ACCT.M_AVAIL, mid: m.id, cur: p.currency, amt: amt + fee }, { acct: ACCT.P_CASH, cur: p.currency, amt: -(amt + fee) }], { ref: p.id, memo: `Chargeback ${reason} + fee` });
    p.status = 'disputed'; addEvent(p, 'disputed', `Chargeback opened: ${reason}`); store.put('payments', p);
    alert('medium', 'dispute', m.id, p.id, `Chargeback ${reason} ${fmt(amt, p.currency)}`, p.mode);
    audit(actor, 'dispute.simulate', d.id, reason, m.id); emit(m.id, p.mode, 'dispute.created', { id: d.id, payment: p.id, amount: amt, reason });
    return d;
  });
}
function resolveDispute(d, won, actor) {
  return store.tx(() => {
    if (!['needs_response', 'under_review'].includes(d.status)) throw bad('Dispute already closed.');
    const p = store.get('payments', d.payment_id);
    if (won) { L.post(d.mode, `${d.id}:won`, [{ acct: ACCT.P_CASH, cur: d.currency, amt: d.amount }, { acct: ACCT.M_AVAIL, mid: d.merchant_id, cur: d.currency, amt: -d.amount }], { ref: p.id, memo: 'Dispute won' }); d.status = 'won'; p.status = p.refunded ? 'partially_refunded' : 'settled'; }
    else { d.status = 'lost'; p.status = 'chargeback_lost'; }
    addEvent(p, 'dispute_' + d.status); store.put('payments', p); store.put('disputes', d);
    audit(actor, 'dispute.' + d.status, d.id, '', d.merchant_id); emit(d.merchant_id, d.mode, 'dispute.closed', { id: d.id, status: d.status });
    return d;
  });
}

/* ---------------- payouts ---------------- */
function destination(m, destId) {
  const d = store.get('wallets', destId) || store.get('banks', destId);
  if (!d || d.merchant_id !== m.id) throw bad('Choose a payout destination.');
  if (d.status !== 'verified') throw bad('That destination is not verified yet.');
  return d;
}
function payoutQuote(m, mode, sourceCur, amount, destId) {
  assertMode(m, mode);
  if (!m.perms.payouts) throw new HttpError(403, 'payouts_disabled', 'Payouts are disabled for this account.');
  if (m.settlementHold) throw new HttpError(403, 'settlement_hold', `Settlement hold: ${m.settlementHold.reason}`);
  if (!CURRENCIES[sourceCur]) throw bad('Unknown currency.');
  if (!Number.isInteger(amount) || amount <= 0) throw bad('Enter an amount.');
  const dest = destination(m, destId), destCur = dest.asset || dest.currency;
  if (destCur === 'PKR' && U.CURRENCIES[sourceCur].crypto) throw bad('Stablecoin → PKR is not offered: it needs SBP / PVARA clearance and bank approval.', 'corridor_unavailable');
  if (destCur === 'PKR' && mode === 'live' && m.providers.soneri !== 'approved') throw bad('PKR settlement via Soneri Bank is not authorized for this account yet.');
  if (dest.asset && !U.CURRENCIES[sourceCur].crypto) throw bad('Fiat balances cannot be paid out as stablecoins.', 'corridor_unavailable');
  const spread = sourceCur === destCur ? 0 : m.fees.fxSpreadBps, gross = convert(amount, sourceCur, destCur, spread);
  const fee = dest.asset ? convert(Math.round(P.NETWORKS[dest.network].payoutFeeUSD * 100), 'USD', destCur) : ({ USD: 500, EUR: 100, GBP: 50, AED: 1000, PKR: 2500 }[destCur] ?? 500);
  const reasons = [];
  if (dest.asset) reasons.push('Crypto payouts are irreversible');
  if (toUSD(amount, sourceCur) > platform().approvalThresholdUSD) reasons.push(`Above ${fmt(platform().approvalThresholdUSD, 'USD')}`);
  if (m.risk === 'high') reasons.push('Merchant risk tier high');
  if (m.dualControl) reasons.push('Merchant dual control');
  return { sourceCur, amount, destCur, dest, spreadBps: spread, gross, fee, receive: gross - fee, rate: CURRENCIES[destCur].fx / CURRENCIES[sourceCur].fx * (1 - spread / 10000), reasons };
}
function requestPayout(m, mode, { currency, amount, destination: destId }, actor) {
  return store.tx(() => {
    const q = payoutQuote(m, mode, String(currency || '').toUpperCase(), Number(amount), destId);
    if (q.receive <= 0) throw bad('Amount does not cover the payout fee.');
    const avail = L.balance(m.id, mode, ACCT.M_AVAIL, q.sourceCur);
    if (q.amount > avail) throw bad(`Only ${fmt(avail, q.sourceCur)} is available.`, 'insufficient_balance');
    if (q.amount < m.minPayout && q.sourceCur === q.destCur) throw bad(`Minimum payout is ${fmt(m.minPayout, q.sourceCur)}.`);
    const po = { id: id('po'), merchant_id: m.id, mode, status: q.reasons.length ? 'pending_approval' : 'processing', amount: q.amount, currency: q.sourceCur, dest_currency: q.destCur, dest_id: q.dest.id,
      dest_label: q.dest.asset ? `${q.dest.asset} · ${P.NETWORKS[q.dest.network].label} · ${q.dest.address.slice(0, 6)}…${q.dest.address.slice(-4)}` : `${q.dest.bank_name} ••${q.dest.last4}${q.dest.rail ? ' · ' + q.dest.rail : ''}`,
      rate: q.rate, spread_bps: q.spreadBps, fee: q.fee, receive: q.receive, reasons: q.reasons, actor, events: [{ at: now(), status: 'requested', note: q.reasons.join('; ') || 'Auto-approved' }] };
    L.post(mode, `${po.id}:hold`, [{ acct: ACCT.M_AVAIL, mid: m.id, cur: q.sourceCur, amt: q.amount }, { acct: ACCT.M_HOLD, mid: m.id, cur: q.sourceCur, amt: -q.amount }], { ref: po.id, memo: 'Payout requested; funds on hold' });
    store.put('payouts', po); audit(actor, 'payout.request', po.id, `${fmt(q.amount, q.sourceCur)} → ${fmt(q.receive, q.destCur)}`, m.id);
    emit(m.id, mode, 'payout.created', publicPayout(po));
    if (!q.reasons.length && mode === 'test') completePayout(po, 'system', null);
    return po;
  });
}
function approvePayout(po, actor) {
  return store.tx(() => {
    if (po.status !== 'pending_approval') throw bad('Payout is not awaiting approval.');
    if (merchant(po.merchant_id).settlementHold) throw bad('Release the settlement hold first.');
    po.status = 'processing'; po.events.push({ at: now(), status: 'approved', note: `Approved by ${actor}` }); store.put('payouts', po); audit(actor, 'payout.approve', po.id, '', po.merchant_id);
    if (po.mode === 'test') completePayout(po, actor, null);
    return po;
  });
}
/** Live: treasury executes the transfer outside the platform, then records the reference here. */
function completePayout(po, actor, reference) {
  return store.tx(() => {
    if (po.status !== 'processing') throw bad('Payout is not processing.');
    if (po.mode === 'live' && !U.str(reference)) throw bad('Enter the transaction hash or bank reference.');
    L.post(po.mode, `${po.id}:sent`, [{ acct: ACCT.M_HOLD, mid: po.merchant_id, cur: po.currency, amt: po.amount }, { acct: U.CURRENCIES[po.currency].crypto ? ACCT.P_CUSTODY : ACCT.P_CASH, cur: po.currency, amt: -po.amount }], { ref: po.id, memo: 'Payout sent' });
    po.status = 'completed'; po.reference = U.str(reference, 120) || (U.CURRENCIES[po.dest_currency].crypto ? '0x' + rid(64, '0123456789abcdef') : 'SBX' + rid(12, '0123456789'));
    po.events.push({ at: now(), status: 'completed', note: `Reference ${po.reference}` }); store.put('payouts', po);
    audit(actor, 'payout.complete', po.id, po.reference, po.merchant_id); emit(po.merchant_id, po.mode, 'payout.paid', publicPayout(po));
    return po;
  });
}
function rejectPayout(po, actor, note) {
  return store.tx(() => {
    if (!['pending_approval', 'processing'].includes(po.status)) throw bad('Payout cannot be rejected now.');
    L.post(po.mode, `${po.id}:release`, [{ acct: ACCT.M_HOLD, mid: po.merchant_id, cur: po.currency, amt: po.amount }, { acct: ACCT.M_AVAIL, mid: po.merchant_id, cur: po.currency, amt: -po.amount }], { ref: po.id, memo: 'Payout rejected; funds released' });
    po.status = 'rejected'; po.events.push({ at: now(), status: 'rejected', note: U.str(note, 300) }); store.put('payouts', po);
    audit(actor, 'payout.reject', po.id, note, po.merchant_id); emit(po.merchant_id, po.mode, 'payout.failed', publicPayout(po));
    return po;
  });
}
function adjust(m, mode, { currency, amount, reason }, maker, checker) {
  return store.tx(() => {
    if (maker === checker) throw bad('Maker-checker: a different admin must approve.');
    L.post(mode, `adj_${rid(16)}`, [{ acct: ACCT.M_AVAIL, mid: m.id, cur: currency, amt: -amount }, { acct: ACCT.P_ADJ, cur: currency, amt: amount }], { ref: m.id, memo: `Adjustment: ${reason}` });
    audit(checker, 'ledger.adjustment', m.id, `${fmt(amount, currency)} · ${reason} · maker ${maker}`, m.id);
  });
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
function runSettlement(mode) {
  let settled = 0, released = 0;
  for (const p of store.list('payments', { mode, status: ['captured', 'partially_refunded'] }, { limit: 2000, asc: true })) {
    if (p.method !== 'card' || p.settled || now() - p.captured_at < 2 * dayMs(mode)) continue;
    store.tx(() => {
      const m = merchant(p.merchant_id), pend = p.pendingRemaining, reserve = pct(pend, m.reserve.pct);
      L.post(mode, `${p.id}:settle`, [
        { acct: ACCT.P_CASH, cur: p.currency, amt: p.rcvRemaining }, { acct: ACCT.ACQ_RCV, cur: p.currency, amt: -p.rcvRemaining },
        { acct: ACCT.M_PENDING, mid: m.id, cur: p.currency, amt: pend }, { acct: ACCT.M_AVAIL, mid: m.id, cur: p.currency, amt: -(pend - reserve) }, { acct: ACCT.M_RESERVE, mid: m.id, cur: p.currency, amt: -reserve },
      ], { ref: p.id, memo: `Acquirer settlement; ${m.reserve.pct}% reserve` });
      Object.assign(p, { settled: true, settled_at: now(), reserve, reserve_release_at: now() + m.reserve.days * dayMs(mode), pendingRemaining: 0 });
      if (p.status === 'captured') p.status = 'settled';
      addEvent(p, 'settled', `${fmt(pend - reserve, p.currency)} available, ${fmt(reserve, p.currency)} reserve`); store.put('payments', p); settled++;
    });
  }
  for (const p of store.list('payments', { mode, status: ['settled', 'partially_refunded', 'refunded', 'disputed', 'chargeback_lost'] }, { limit: 5000, asc: true })) {
    if (!p.reserve || p.reserve_released || now() < p.reserve_release_at) continue;
    store.tx(() => { L.post(mode, `${p.id}:reserve_release`, [{ acct: ACCT.M_RESERVE, mid: p.merchant_id, cur: p.currency, amt: p.reserve }, { acct: ACCT.M_AVAIL, mid: p.merchant_id, cur: p.currency, amt: -p.reserve }], { ref: p.id, memo: 'Rolling reserve released' }); p.reserve_released = true; store.put('payments', p); released++; });
  }
  for (const p of store.list('payments', { mode, status: 'authorized' })) if (now() > p.auth_expires_at) { p.status = 'canceled'; addEvent(p, 'canceled', 'Authorization expired'); store.put('payments', p); }
  return { settled, released };
}
function runExpiry() {
  for (const p of store.list('payments', { status: 'awaiting_payment' }, { limit: 1000 })) if (p.crypto && now() > p.crypto.expiresAt && p.crypto.provider === 'sandbox') cryptoExpire(p);
  for (const s of store.list('checkout_sessions', { status: 'open' }, { limit: 1000, asc: true })) if (now() > s.expires_at) { s.status = 'expired'; store.put('checkout_sessions', s); emit(s.merchant_id, s.mode, 'checkout.session.expired', publicSession(s)); }
}
function runSandboxConfirmations() { for (const p of store.list('payments', { mode: 'test', status: 'confirming' })) cryptoTick(p); }

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
  const pays = store.list('payments', { mode }, { limit: 100000 }), rcv = {}, susp = {}, over = {}, pend = {};
  for (const p of pays) {
    if (p.method === 'card' && !p.settled && p.rcvRemaining) rcv[p.currency] = (rcv[p.currency] || 0) + p.rcvRemaining;
    if (p.method === 'card' && !p.settled && p.pendingRemaining) pend[p.currency] = (pend[p.currency] || 0) - p.pendingRemaining;
    if (p.method === 'crypto' && ['confirming', 'underpaid'].includes(p.status)) susp[p.crypto.asset] = (susp[p.crypto.asset] || 0) - p.crypto.received;
    if (p.crypto?.excess) over[p.crypto.asset] = (over[p.crypto.asset] || 0) - (p.crypto.excess - (p.crypto.excessRefunded || 0));
  }
  out.push({ name: 'Acquirer receivable = unsettled captures', ok: eq(L.sumAccount(mode, ACCT.ACQ_RCV), rcv), detail: 'Money owed by the acquirer matches captured, unsettled card payments.' });
  out.push({ name: 'Merchant pending = unsettled net', ok: eq(L.sumAccount(mode, ACCT.M_PENDING), pend), detail: 'Pending balances equal net of unsettled captures.' });
  out.push({ name: 'Customer suspense = unconfirmed crypto', ok: eq(L.sumAccount(mode, ACCT.C_SUSPENSE), susp), detail: 'Detected but unconfirmed funds stay outside merchant balances.' });
  out.push({ name: 'Overpayment liability = unreturned excess', ok: eq(L.sumAccount(mode, ACCT.C_OVERPAY), over), detail: 'Excess crypto owed back to customers.' });
  const hold = {}; for (const po of store.list('payouts', { mode, status: ['pending_approval', 'processing'] }, { limit: 100000 })) hold[po.currency] = (hold[po.currency] || 0) - po.amount;
  out.push({ name: 'Payout holds = payouts in flight', ok: eq(L.sumAccount(mode, ACCT.M_HOLD), hold), detail: 'Held funds match payouts awaiting approval or execution.' });
  const neg = store.list('merchants', {}, { limit: 10000 }).flatMap(m => Object.entries(L.merchantBalances(m.id, mode)).filter(([, b]) => b.available < 0).map(([c]) => `${m.name} ${c}`));
  out.push({ name: 'No negative available balances', ok: true, warn: neg.length > 0, detail: neg.length ? 'Negative: ' + neg.join(', ') : 'All available balances are zero or positive.' });
  return [...out, ...require('./usdc').reconChecks(mode)];
}

module.exports = { METHODS, sessionPayable, newPayment, addEvent, completeSession, customerFrom, PAID, now, dayMs, platform, setPlatform, audit, alert, emit, publicEvent, newMerchant, merchant, kybReady, liveReady, assertMode, methodAvailable, cryptoOptions,
  controlCheck, non3dsAuthorized, feeQuote, publicSession, publicPayment, publicRefund, publicLink, publicPayout, createSession, createLink, linkActive, cardPay, complete3DS, capture, cancel,
  cryptoStart, cryptoDetected, cryptoTick, cryptoExpire, acceptPartial, providerPaid, maxRefundable, refund, openDispute, resolveDispute, payoutQuote, requestPayout, approvePayout,
  completePayout, rejectPayout, adjust, idempotent, runSettlement, runExpiry, runSandboxConfirmations, runDeliveries, assertWebhookTarget, reconChecks, STABLE, FIAT };
