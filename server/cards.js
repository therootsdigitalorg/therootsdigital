'use strict';
/* Card payments through Authorize.Net Accept Hosted (single-business platform).

   Flow:  checkout page (name / email / billing) → POST start → Digital Hub creates the payment + an invoice number and asks
   Authorize.Net for a hosted-page token → the browser form-POSTs the token to Authorize.Net, where the customer types the
   card → Authorize.Net returns the customer to /pay/:id?return=1.

   The return redirect proves nothing. A payment changes state only from
     (a) a server-side getTransactionDetails lookup (after finding the transaction by its invoice number), or
     (b) an Authorize.Net webhook whose X-ANET-Signature verifies, followed by the same server-side lookup.
   Each lookup re-checks invoice number, amount and response code before anything is booked.
   Card numbers, CVV and track data never reach Digital Hub: we only ever see Authorize.Net's masked "XXXX1111". */
const config = require('./config');
const store = require('./db');
const L = require('./ledger');
const U = require('./util');
const core = require('./core');
const anet = require('./authorizenet');
const { HttpError, bad, fmt } = U;

const A = {
  ACQ_RCV: L.ACCT.ACQ_RCV, SALES: 'business_sales', REFUNDS: 'business_refunds', DISPUTES: 'business_disputes',
};
const now = () => Date.now();
const RANK = { created: 0, pending: 1, declined: 2, authorized: 2, captured: 3, voided: 4, partially_refunded: 5, refunded: 6, disputed: 7 };
const FINAL = ['declined', 'voided', 'refunded'];
const envOf = p => p.anet?.env || anet.envForMode(p.mode);
const newInvoice = () => 'DH' + U.rid(14, '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'); // ≤ 20 characters (Authorize.Net invoiceNumber limit)

/** Is card checkout through Authorize.Net available for this mode? */
function available(mode) {
  const e = anet.envForMode(mode);
  if (!anet.configured(e)) return false;
  if (mode === 'live') return config.livePayments && !!store.getMeta('readiness', {}).cardsLive;
  return true;
}
function unavailableReason(mode) {
  if (!anet.configured(anet.envForMode(mode))) return mode === 'live' ? 'Authorize.Net production credentials are not configured.' : 'Authorize.Net sandbox credentials are not configured (Super Admin → Authorize.Net).';
  if (mode === 'live' && !config.livePayments) return 'Live payments are switched off (LIVE_PAYMENTS=0).';
  if (mode === 'live') return 'Live card payments have not been enabled on the Production Readiness page.';
  return null;
}

/* ---------------- customers ---------------- */
function upsertCustomer(mid, c, mode) {
  const email = String(c.email || '').trim().toLowerCase(); if (!U.isEmail(email)) return null;
  const k = `${mode}:${email}`;
  const cur = store.byKey('customers', k) || { id: U.id('cus'), merchant_id: mid, mode, status: 'active', k, email, payments: 0, total: 0, refunded: 0, first_seen: now() };
  Object.assign(cur, { name: U.str(c.name, 100) || cur.name || '', phone: U.str(c.phone, 30) || cur.phone || '', billing: c.billing || cur.billing || null, last_seen: now() });
  return store.put('customers', cur);
}
function customerStat(p, field, delta) {
  const c = p.customer_id && store.get('customers', p.customer_id); if (!c) return;
  c[field] = (c[field] || 0) + delta; if (field === 'total') { c.payments = (c.payments || 0) + 1; c.last_payment_at = now(); }
  store.put('customers', c);
}

/* ---------------- start (hosted page) ---------------- */
function customerInput(input) {
  const s = v => U.str(v, 60);
  const name = U.str(input.name, 100), email = String(input.email || '').trim().toLowerCase();
  if (name.length < 2) throw bad('Enter the cardholder name.', 'name_required');
  if (!U.isEmail(email)) throw bad('Enter a valid email address for the receipt.', 'email_invalid');
  const parts = name.split(/\s+/), billing = { address: s(input.address), city: U.str(input.city, 40), state: U.str(input.state, 40), zip: U.str(input.zip, 20), country: U.str(input.country, 60) };
  return { name, email, phone: U.str(input.phone, 30), billing, firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0] };
}
async function start(s, input) {
  const m = core.merchant(s.merchant_id); core.assertMode(m, s.mode); core.sessionPayable(s);
  if (!s.methods.includes('card') || !available(s.mode)) throw new HttpError(409, 'card_unavailable', unavailableReason(s.mode) || 'Card payments are not available for this checkout.');
  if (s.currency !== 'USD') throw bad('Card payments are processed in USD.', 'currency_unsupported');
  // A previous hosted-page attempt may have been paid even though the customer never came back: check it first.
  if (s.payment_id) {
    const prev = store.get('payments', s.payment_id);
    if (prev?.provider === 'authorize_net' && ['created', 'pending'].includes(prev.status)) {
      const after = await reconcile(prev, { force: true }).catch(() => prev);
      if (core.PAID.includes(after.status) || after.status === 'pending') throw new HttpError(409, 'payment_in_progress', after.status === 'pending' ? 'Your previous card payment is under review by the card processor.' : 'This checkout is already paid.');
    }
  }
  if (++s.card_attempts > 10) { store.put('checkout_sessions', s); throw new HttpError(429, 'too_many_attempts', 'Too many card attempts for this checkout.'); }
  const c = customerInput(input), e = anet.envForMode(s.mode);
  const block = core.controlCheck ? core.controlCheck(m, s.mode, s.amount, s.currency, { email: c.email, country: c.billing.country }) : null;
  if (block) throw bad(block, 'blocked_by_controls');
  const cus = upsertCustomer(m.id, c, s.mode);
  const p = core.newPayment(s, 'card', { name: c.name, email: c.email, country: c.billing.country || null, phone: c.phone || null });
  const invoice = newInvoice();
  Object.assign(p, { provider: 'authorize_net', k: invoice, customer_id: cus?.id || null, settlement_status: null, card: null,
    anet: { env: e, invoice, flow: anet.flow(), transId: null, raw: null, hosted_at: now() } });
  const base = `${config.publicUrl}/pay/${s.id}`;
  const tok = await anet.hostedToken(e, { amount: s.amount, invoice, description: s.description, email: c.email,
    billTo: { firstName: c.firstName, lastName: c.lastName, address: c.billing.address, city: c.billing.city, state: c.billing.state, zip: c.billing.zip, country: c.billing.country },
    returnUrl: `${base}?return=1`, cancelUrl: `${base}?canceled=1`, merchantName: m.name, refId: p.id.slice(-20) });
  core.addEvent(p, 'created', `Secure payment page opened (Authorize.Net ${e}, invoice ${invoice})`);
  store.tx(() => { store.put('payments', p); s.payment_id = p.id; store.put('checkout_sessions', s); });
  core.audit('checkout', 'card.hosted_page', p.id, `${fmt(p.amount, p.currency)} · ${invoice}`, m.id);
  return { payment: p, form: { action: tok.url, token: tok.token } };
}

/* ---------------- reconcile (server-side lookup) ---------------- */
const lastLookup = new Map();
/** Find the Authorize.Net transaction for a payment and apply it. Throttled per payment unless force. */
async function reconcile(p, { force = false } = {}) {
  if (p.provider !== 'authorize_net') return p;
  if (!force && (Date.now() - (lastLookup.get(p.id) || 0) < 4000)) return p;
  lastLookup.set(p.id, Date.now()); if (lastLookup.size > 5000) lastLookup.clear();
  const e = envOf(p);
  let transId = p.anet.transId;
  if (!transId) {
    if (p.status !== 'created' && p.status !== 'pending') return p;
    const hit = (await anet.unsettled(e)).find(t => String(t.invoiceNumber || '') === p.anet.invoice);
    if (!hit) return p;
    transId = hit.transId;
  }
  const tx = await anet.details(e, transId);
  return apply(store.get('payments', p.id), tx, 'api lookup');
}

/** Apply an Authorize.Net transaction (from getTransactionDetails only) to a payment. Idempotent. */
function apply(p, tx, source) {
  return store.tx(() => {
    const inv = String(tx?.order?.invoiceNumber || '');
    if (inv !== p.anet.invoice) { core.alert('high', 'card_mismatch', p.merchant_id, p.id, `Authorize.Net transaction ${tx?.transId} has invoice "${inv}", expected ${p.anet.invoice}. Not applied.`, p.mode); return p; }
    if (p.anet.transId && String(p.anet.transId) !== String(tx.transId)) { core.alert('high', 'card_duplicate', p.merchant_id, p.id, `Second Authorize.Net transaction ${tx.transId} for invoice ${inv} (first ${p.anet.transId}). Review and refund if the customer paid twice.`, p.mode); return p; }
    const authCents = anet.cents(tx.authAmount);
    const st = anet.mapStatus(tx);
    if (st.card !== 'declined' && authCents !== p.amount) {
      p.status = 'pending'; core.addEvent(p, 'pending', `Amount mismatch: Authorize.Net authorized ${fmt(authCents, 'USD')}, invoice is ${fmt(p.amount, 'USD')}. Held for review.`);
      p.anet.transId = String(tx.transId); store.put('payments', p);
      core.alert('high', 'card_amount_mismatch', p.merchant_id, p.id, `Authorized ${fmt(authCents, 'USD')} vs invoice ${fmt(p.amount, 'USD')}`, p.mode);
      return p;
    }
    const cc = tx.payment?.creditCard || {};
    p.anet = { ...p.anet, transId: String(tx.transId), raw: st.raw, responseCode: String(tx.responseCode || ''), authCode: tx.authCode || null, avs: tx.AVSResponse || null, cvv: tx.cardCodeResponse || null,
      submitted: tx.submitTimeUTC || null, batch: tx.batch?.batchId || p.anet.batch || null, settleAmount: tx.settleAmount != null ? anet.cents(tx.settleAmount) : null, fds: (tx.FDSFilters || []).map(f => f.name), checked_at: now(), source };
    if (cc.cardNumber) p.card = { brand: cc.cardType || 'Card', last4: String(cc.cardNumber).slice(-4), holder: [tx.billTo?.firstName, tx.billTo?.lastName].filter(Boolean).join(' ') || p.customer?.name || null, authCode: tx.authCode || null };
    const from = p.status, to = st.card;
    if (st.settlement === 'settled' && !['settled', 'reconciled'].includes(p.settlement_status)) p.settlement_status = 'settled';
    if (st.settlement === 'failed') p.settlement_status = 'failed';
    if (to === from || (RANK[to] ?? 0) < (RANK[from] ?? 0) || (FINAL.includes(from) && to !== from)) { store.put('payments', p); return p; }
    const s = store.get('checkout_sessions', p.session_id);
    if (to === 'pending') {
      p.status = 'pending'; core.addEvent(p, 'pending', `Held by the processor (${st.raw})${p.anet.fds.length ? ': ' + p.anet.fds.join(', ') : ''}`);
      core.alert('medium', 'card_held', p.merchant_id, p.id, `Authorize.Net fraud filter hold (${st.raw})`, p.mode);
    } else if (to === 'declined') {
      p.status = 'declined'; p.declineCode = tx.responseReasonCode ? String(tx.responseReasonCode) : 'declined';
      core.addEvent(p, 'declined', tx.responseReasonDescription || 'Declined by the card issuer'); core.emit(p.merchant_id, p.mode, 'payment.failed', core.publicPayment(p));
    } else if (to === 'authorized') {
      p.status = 'authorized'; core.addEvent(p, 'authorized', `Authorized ${fmt(authCents, 'USD')} (auth ${tx.authCode || '—'}), awaiting capture`);
      core.emit(p.merchant_id, p.mode, 'payment.authorized', core.publicPayment(p));
    } else if (to === 'captured') {
      const amt = p.anet.settleAmount ?? authCents;
      L.post(p.mode, `${p.id}:capture`, [{ acct: A.ACQ_RCV, mid: p.merchant_id, cur: 'USD', amt }, { acct: A.SALES, mid: p.merchant_id, cur: 'USD', amt: -amt }], { ref: p.id, memo: 'Card captured (Authorize.Net)' });
      Object.assign(p, { status: 'captured', captured: amt, net: amt, fees: { provider: 0, platform: 0 }, settlement_status: p.settlement_status || 'pending', captured_at: now() });
      core.addEvent(p, 'captured', `Captured ${fmt(amt, 'USD')} · ${p.card ? `${p.card.brand} •••• ${p.card.last4}` : ''} · verified by ${source}`);
      customerStat(p, 'total', amt);
      core.emit(p.merchant_id, p.mode, 'payment.succeeded', core.publicPayment(p));
      core.completeSession(s, p);
    } else if (to === 'voided') {
      if (from === 'captured') L.post(p.mode, `${p.id}:void`, [{ acct: A.SALES, mid: p.merchant_id, cur: 'USD', amt: p.captured }, { acct: A.ACQ_RCV, mid: p.merchant_id, cur: 'USD', amt: -p.captured }], { ref: p.id, memo: 'Card voided before settlement' });
      p.status = 'voided'; p.settlement_status = null; core.addEvent(p, 'voided', `Voided (${st.raw})`);
      core.emit(p.merchant_id, p.mode, 'payment.canceled', core.publicPayment(p));
    } else if (to === 'disputed') {
      p.status = 'disputed'; core.addEvent(p, 'disputed', `Processor reports ${st.raw}`); core.alert('high', 'card_dispute', p.merchant_id, p.id, `Chargeback / returned item (${st.raw})`, p.mode);
    }
    store.put('payments', p);
    return p;
  });
}

/* ---------------- admin actions (each verified by a lookup afterwards) ---------------- */
const owned = p => { if (p?.provider !== 'authorize_net') throw bad('This is not an Authorize.Net card payment.'); return p; };
async function capture(p, amount, actor) {
  owned(p); if (p.status !== 'authorized') throw bad('Only authorized payments can be captured.');
  const amt = amount == null ? p.amount : Number(amount); if (!Number.isInteger(amt) || amt < 1 || amt > p.amount) throw bad('Capture amount must be between 0.01 and the authorized amount.');
  await anet.capture(envOf(p), p.anet.transId, amt);
  core.audit(actor, 'card.capture', p.id, fmt(amt, 'USD'), p.merchant_id);
  return reconcile(store.get('payments', p.id), { force: true });
}
async function voidPayment(p, actor) {
  owned(p); if (!['authorized', 'captured'].includes(p.status) || ['settled', 'reconciled'].includes(p.settlement_status)) throw bad('Only unsettled payments can be voided. Refund settled payments instead.');
  await anet.voidTx(envOf(p), p.anet.transId);
  core.audit(actor, 'card.void', p.id, p.anet.transId, p.merchant_id);
  return reconcile(store.get('payments', p.id), { force: true });
}
const refundedSoFar = p => store.list('refunds', { merchant_id: p.merchant_id, mode: p.mode, status: ['pending', 'succeeded'] }, { limit: 1000 }).filter(r => r.payment_id === p.id).reduce((s, r) => s + r.amount, 0);
/** Refund: void when the batch has not settled (full amount only), refund through the API once settled. */
async function refund(p, amount, { actor, reason }) {
  owned(p);
  if (!['captured', 'partially_refunded'].includes(p.status)) throw bad(`A ${p.status} payment cannot be refunded.`);
  const left = p.captured - refundedSoFar(p), amt = amount == null ? left : Number(amount);
  if (!Number.isInteger(amt) || amt < 1 || amt > left) throw bad(`Refund amount must be between 0.01 and ${fmt(left, 'USD')}.`, 'amount_invalid');
  // Settlement state comes from Authorize.Net, not from our copy.
  const tx = await anet.details(envOf(p), p.anet.transId); const settled = tx.transactionStatus === 'settledSuccessfully';
  if (!settled) {
    if (amt !== p.captured) throw bad('This payment has not settled yet: it can only be voided in full now. Partial refunds are possible after settlement.', 'not_settled');
    const v = await voidPayment(p, actor);
    if (v.status !== 'voided') throw new HttpError(502, 'void_unconfirmed', 'Authorize.Net accepted the void but the lookup does not show it yet. Check again in a minute.');
    return { payment: v, refund: null, voided: true };
  }
  if (!p.card?.last4) throw bad('Card last four digits are missing for this payment; refund it in the Authorize.Net merchant interface.');
  const r = store.put('refunds', { id: U.id('re'), merchant_id: p.merchant_id, mode: p.mode, status: 'pending', payment_id: p.id, amount: amt, currency: 'USD', provider: 'authorize_net', reason: U.str(reason, 200), by: actor });
  let res;
  try { res = await anet.refund(envOf(p), p.anet.transId, amt, p.card.last4); }
  catch (e) { r.status = 'failed'; r.error = e.message; store.put('refunds', r); core.audit(actor, 'card.refund_failed', r.id, e.message, p.merchant_id); throw e; }
  return { payment: recordRefund(p.id, r.id, { transId: res.transId, amount: amt, actor }), refund: store.get('refunds', r.id), voided: false };
}
/** Book a refund Authorize.Net accepted (from our API call or a verified refund webhook). Idempotent per refund transaction. */
function recordRefund(pid, rid, { transId, amount, actor = 'system', external = false }) {
  return store.tx(() => {
    const p = store.get('payments', pid);
    let r = rid ? store.get('refunds', rid) : store.list('refunds', { merchant_id: p.merchant_id, mode: p.mode }, { limit: 1000 }).find(x => x.anet_trans_id === String(transId));
    if (r?.status === 'succeeded') return p;
    if (!r) r = { id: U.id('re'), merchant_id: p.merchant_id, mode: p.mode, payment_id: p.id, amount, currency: 'USD', provider: 'authorize_net', reason: external ? 'Refunded in the Authorize.Net merchant interface' : '', by: actor };
    Object.assign(r, { status: 'succeeded', anet_trans_id: String(transId), settlement_status: 'pending', succeeded_at: now() }); store.put('refunds', r);
    L.post(p.mode, `${r.id}:refund`, [{ acct: A.REFUNDS, mid: p.merchant_id, cur: 'USD', amt: r.amount }, { acct: A.ACQ_RCV, mid: p.merchant_id, cur: 'USD', amt: -r.amount }], { ref: p.id, memo: `Card refund ${r.anet_trans_id}` });
    p.refunded = (p.refunded || 0) + r.amount; p.status = p.refunded >= p.captured ? 'refunded' : 'partially_refunded';
    core.addEvent(p, p.status, `Refunded ${fmt(r.amount, 'USD')} (Authorize.Net ${r.anet_trans_id})`); store.put('payments', p);
    customerStat(p, 'refunded', r.amount);
    core.audit(actor, 'card.refund', r.id, fmt(r.amount, 'USD'), p.merchant_id);
    core.emit(p.merchant_id, p.mode, 'refund.succeeded', core.publicRefund(r)); core.emit(p.merchant_id, p.mode, 'payment.refunded', core.publicPayment(p));
    return p;
  });
}
/** Disputes are recorded manually from the processor's chargeback notice (Authorize.Net has no dispute webhook). */
function recordDispute(p, { amount, reason, reference }, actor) {
  owned(p); if (!['captured', 'partially_refunded', 'refunded'].includes(p.status)) throw bad('Only captured payments can be disputed.');
  const amt = amount == null ? p.captured : Number(amount); if (!Number.isInteger(amt) || amt < 1 || amt > p.captured) throw bad('Dispute amount is invalid.');
  const d = store.put('disputes', { id: U.id('dp'), merchant_id: p.merchant_id, mode: p.mode, status: 'open', payment_id: p.id, amount: amt, currency: 'USD', reason: U.str(reason, 200), reference: U.str(reference, 80), by: actor, provider: 'authorize_net' });
  L.post(p.mode, `${d.id}:open`, [{ acct: A.DISPUTES, mid: p.merchant_id, cur: 'USD', amt }, { acct: A.ACQ_RCV, mid: p.merchant_id, cur: 'USD', amt: -amt }], { ref: p.id, memo: 'Chargeback recorded' });
  p.status = 'disputed'; p.dispute_id = d.id; core.addEvent(p, 'disputed', `Chargeback ${fmt(amt, 'USD')} ${reference ? '(' + reference + ')' : ''}`); store.put('payments', p);
  core.audit(actor, 'card.dispute_recorded', d.id, `${fmt(amt, 'USD')} ${reason || ''}`, p.merchant_id); core.emit(p.merchant_id, p.mode, 'dispute.created', { id: d.id, payment: p.id, amount: amt });
  return d;
}
function resolveDispute(d, won, actor, note) {
  if (d.provider !== 'authorize_net' || d.status !== 'open') throw bad('Dispute is not open.');
  const p = store.get('payments', d.payment_id);
  if (won) L.post(d.mode, `${d.id}:won`, [{ acct: A.ACQ_RCV, mid: d.merchant_id, cur: 'USD', amt: d.amount }, { acct: A.DISPUTES, mid: d.merchant_id, cur: 'USD', amt: -d.amount }], { ref: p.id, memo: 'Chargeback reversed (won)' });
  d.status = won ? 'won' : 'lost'; d.resolved = { by: actor, at: now(), note: U.str(note, 300) }; store.put('disputes', d);
  if (won) { p.status = p.refunded >= p.captured ? 'refunded' : p.refunded ? 'partially_refunded' : 'captured'; core.addEvent(p, p.status, 'Dispute won'); store.put('payments', p); }
  core.audit(actor, 'card.dispute_' + d.status, d.id, note || '', d.merchant_id); core.emit(d.merchant_id, d.mode, 'dispute.closed', { id: d.id, payment: p.id, status: d.status });
  return d;
}

/* ---------------- webhook ---------------- */
async function webhook(ctx) {
  const e = anet.verifyWebhook(ctx.headers, ctx.raw);
  if (!e) {
    store.put('provider_events', { id: U.id('pev'), k: `anet:rejected:${U.rid(12)}`, status: 'rejected', provider: 'authorize_net', type: 'unverified', sig: 'invalid', ip: ctx.ip });
    throw new HttpError(401, 'invalid_signature', 'X-ANET-Signature verification failed.');
  }
  let body; try { body = JSON.parse(ctx.raw); } catch { throw bad('Invalid JSON.'); }
  const nid = U.str(body.notificationId, 80) || U.sha256(ctx.raw), type = U.str(body.eventType, 120), pl = body.payload || {};
  const k = `anet:${nid}`;
  if (store.byKey('provider_events', k)) return { ok: true, duplicate: true };
  const ev = { id: U.id('pev'), k, status: 'received', provider: 'authorize_net', env: e, type, trans_id: U.str(pl.id, 40), sig: 'verified', ip: ctx.ip, received_at: now() };
  store.put('provider_events', ev);
  if (pl.entityName && pl.entityName !== 'transaction') { ev.status = 'ignored'; store.put('provider_events', ev); return { ok: true }; }
  const mode = e === 'production' ? 'live' : 'test';
  let tx;
  try { tx = await anet.details(e, pl.id); }
  catch (err) { ev.status = 'lookup_failed'; ev.error = err.message; store.put('provider_events', ev); throw new HttpError(503, 'lookup_failed', 'Transaction lookup failed; Authorize.Net will retry.'); }
  let p;
  if (tx.transactionType === 'refundTransaction' && tx.refTransId) {
    p = store.list('payments', { mode }, { limit: 20000 }).find(x => x.anet?.transId === String(tx.refTransId));
    if (p && ['captured', 'partially_refunded'].includes(p.status) && tx.transactionStatus !== 'declined' && String(tx.responseCode) === '1') recordRefund(p.id, null, { transId: tx.transId, amount: anet.cents(tx.settleAmount || tx.authAmount), external: true });
  } else {
    p = store.byKey('payments', String(tx.order?.invoiceNumber || '')) || store.list('payments', { mode }, { limit: 20000 }).find(x => x.anet?.transId === String(tx.transId));
    if (p && p.mode === mode) p = apply(p, tx, 'verified webhook');
  }
  ev.status = p ? 'processed' : 'unmatched'; ev.payment_id = p?.id || null; ev.invoice = U.str(tx.order?.invoiceNumber, 20) || null; store.put('provider_events', ev);
  return { ok: true };
}

/* ---------------- views ---------------- */
function statuses(p) {
  const st = p.settlement_id ? store.get('usd_settlements', p.settlement_id) : null;
  return { card: p.status, usd_settlement: p.settlement_status || (core.PAID.includes(p.status) ? 'pending' : null), conversion: st?.conversion_status || 'not_requested', usdc_payout: st?.payout_status || 'not_initiated' };
}
const publicCard = p => ({ id: p.id, created: p.created_at, mode: p.mode, amount: p.amount, currency: p.currency, description: p.description, invoice: p.anet?.invoice, trans_id: p.anet?.transId || null,
  customer: { name: p.customer?.name, email: p.customer?.email }, card: p.card ? { brand: p.card.brand, last4: p.card.last4 } : null, auth_code: p.anet?.authCode || null, avs: p.anet?.avs || null, cvv: p.anet?.cvv || null,
  refunded: p.refunded || 0, captured: p.captured || 0, statuses: statuses(p), raw_status: p.anet?.raw || null, batch: p.anet?.batch || null, settlement_id: p.settlement_id || null, session: p.session_id,
  order_id: p.metadata?.order_id || null, events: p.events, checked_at: p.anet?.checked_at || null });

module.exports = { A, available, unavailableReason, start, reconcile, apply, capture, voidPayment, refund, recordRefund, recordDispute, resolveDispute, webhook, statuses, publicCard, upsertCustomer, newInvoice };
