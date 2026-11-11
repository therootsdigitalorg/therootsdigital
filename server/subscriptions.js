'use strict';
/* Subscriptions as recurring invoices.

   Every period the billing job creates a pending invoice (a checkout session tagged with the subscription).
   - If the customer saved a card on an earlier invoice (sandbox test cards only until a live acquirer with card
     tokenization is connected), that card is charged automatically.
   - Otherwise the invoice stays pending: subscription.invoice_pending is sent (with the pay link) so the merchant's
     store / email system can notify the customer, and subscription.past_due follows after the grace period.
   Nothing is ever pulled from a MetaMask wallet: USDC renewals are paid by the customer from the pay link. */
const config = require('./config');
const store = require('./db');
const U = require('./util');
const core = require('./core');
const { HttpError, bad, fmt, id, DAY } = U;

const INTERVALS = { day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };
const GRACE = mode => mode === 'test' ? core.dayMs('test') * 3 : 3 * DAY;
const now = () => Date.now();
function addPeriod(t, sub) {
  if (sub.interval === 'month' || sub.interval === 'year') { const d = new Date(t); d.setUTCMonth(d.getUTCMonth() + (sub.interval === 'year' ? 12 : 1) * sub.interval_count); return d.getTime(); }
  return t + INTERVALS[sub.interval] * sub.interval_count;
}

const publicSubscription = s => ({ id: s.id, object: 'subscription', livemode: s.mode === 'live', status: s.status, customer_email: s.customer.email, customer_name: s.customer.name || null,
  amount: s.amount, currency: s.currency, description: s.description, interval: s.interval, interval_count: s.interval_count, payment_methods: s.methods,
  current_invoice: s.current_invoice || null, current_invoice_url: s.current_invoice ? `${config.publicUrl}/pay/${s.current_invoice}` : null, next_billing_at: Math.floor(s.next_at / 1000),
  auto_charge: s.card ? { type: 'card', brand: s.card.brand, last4: s.card.last4, exp_month: s.card.exp_month, exp_year: s.card.exp_year } : null,
  pending_amount: s.status === 'past_due' || s.current_invoice ? s.amount : 0, invoices: (s.invoices || []).slice(-24), metadata: s.metadata || {}, created: Math.floor(s.created_at / 1000) });

function create(m, mode, input, actor) {
  core.assertMode(m, mode);
  const amount = Number(input.amount), currency = String(input.currency || 'USD').toUpperCase();
  if (!Number.isInteger(amount) || amount < 50) throw bad('amount must be an integer in minor units, at least 50.', 'amount_invalid');
  if (!U.FIAT.includes(currency)) throw bad('Unsupported currency.', 'currency_invalid');
  const interval = String(input.interval || 'month'), interval_count = Math.max(1, Math.min(12, Math.round(+input.interval_count || 1)));
  if (!INTERVALS[interval]) throw bad('interval must be day, week, month or year.', 'interval_invalid');
  const email = U.str(input.customer_email, 200).toLowerCase(); if (!U.isEmail(email)) throw bad('customer_email is required.', 'email_invalid');
  const description = U.str(input.description, 200) || 'Subscription';
  const methods = [].concat(input.payment_methods || ['usdc', 'card']).filter(x => ['usdc', 'card'].includes(x));
  if (!methods.some(x => core.methodAvailable(m, mode, x))) throw bad('No payment method is available for this account in this mode.', 'no_payment_method');
  const metadata = {}; for (const [k, v] of Object.entries(input.metadata || {}).slice(0, 20)) metadata[U.str(k, 40)] = U.str(v, 500);
  const sub = store.put('subscriptions', { id: id('sub'), merchant_id: m.id, mode, status: 'active', customer: { email, name: U.str(input.customer_name, 120) }, amount, currency, description, interval, interval_count,
    methods, metadata, next_at: input.start_at ? Number(input.start_at) * 1000 : now(), current_invoice: null, invoices: [], card: null, events: [{ at: now(), status: 'created', note: `${fmt(amount, currency)} every ${interval_count} ${interval}(s) by ${actor}` }] });
  core.audit(actor, 'subscription.create', sub.id, fmt(amount, currency), m.id);
  core.emit(m.id, mode, 'subscription.created', publicSubscription(sub));
  if (sub.next_at <= now()) bill(sub);
  return store.get('subscriptions', sub.id);
}

/** Create this period's invoice and try the saved card. */
function bill(sub) {
  return store.tx(() => {
    sub = store.get('subscriptions', sub.id);
    if (sub.status === 'canceled' || sub.status === 'paused') return sub;
    const open = sub.current_invoice && store.get('checkout_sessions', sub.current_invoice);
    if (open && open.status === 'open') return sub; // still waiting for the previous invoice
    const m = core.merchant(sub.merchant_id);
    let s;
    try {
      const methods = sub.methods.filter(x => core.methodAvailable(m, sub.mode, x));
      s = core.createSession(m, sub.mode, { amount: sub.amount, currency: sub.currency, description: `${sub.description} · ${new Date(sub.next_at).toISOString().slice(0, 10)}`, payment_methods: methods.length ? methods : sub.methods,
        customer_email: sub.customer.email, metadata: { ...sub.metadata, subscription_id: sub.id, period_start: String(Math.floor(sub.next_at / 1000)) } }, 'subscription');
    } catch (e) { sub.events.push({ at: now(), status: 'billing_failed', note: e.message }); sub.status = 'past_due'; store.put('subscriptions', sub); core.alert('medium', 'subscription_billing_failed', sub.merchant_id, sub.id, e.message, sub.mode); return sub; }
    s.expires_at = now() + 30 * DAY; store.put('checkout_sessions', s); // renewal invoices stay payable for a month
    sub.current_invoice = s.id; sub.invoices.push({ session: s.id, amount: sub.amount, period_start: sub.next_at, status: 'pending', created_at: now() }); sub.pending_since = now();
    sub.events.push({ at: now(), status: 'invoice_created', note: s.id }); store.put('subscriptions', sub);
    if (sub.card && s.methods.includes('card')) {
      let p = null, err = null;
      try { p = core.cardPay(s, { number: U.unseal(sub.card.number), exp: sub.card.exp, cvc: '000', name: sub.customer.name || sub.customer.email, email: sub.customer.email, country: sub.card.country, offSession: true }); }
      catch (e) { err = e.message; }
      const fresh = store.get('subscriptions', sub.id);
      if (p && ['captured', 'authorized'].includes(p.status)) { fresh.events.push({ at: now(), status: 'auto_charged', note: `${sub.card.brand} ••${sub.card.last4} · ${p.id}` }); store.put('subscriptions', fresh); return store.get('subscriptions', sub.id); }
      fresh.events.push({ at: now(), status: 'auto_charge_failed', note: err || p?.events?.at(-1)?.note || 'declined' });
      if (p) { const ss = store.get('checkout_sessions', s.id); ss.payment_id = null; store.put('checkout_sessions', ss); } // invoice stays payable from the link
      store.put('subscriptions', fresh); core.alert('low', 'subscription_charge_failed', sub.merchant_id, sub.id, `Auto-charge failed for ${sub.customer.email}: ${err || 'declined'}`, sub.mode);
    }
    core.emit(sub.merchant_id, sub.mode, 'subscription.invoice_pending', { ...publicSubscription(store.get('subscriptions', sub.id)), invoice: core.publicSession(store.get('checkout_sessions', s.id)) });
    return store.get('subscriptions', sub.id);
  });
}

/** Called from core.completeSession when a subscription invoice is paid (card, USDC or auto-charge). */
function onInvoicePaid(session, payment) {
  const sub = store.get('subscriptions', session.metadata?.subscription_id); if (!sub || sub.merchant_id !== session.merchant_id) return;
  const inv = sub.invoices.find(i => i.session === session.id); if (inv) { inv.status = 'paid'; inv.payment = payment.id; inv.paid_at = now(); }
  if (sub.current_invoice === session.id) { sub.current_invoice = null; sub.pending_since = null; sub.next_at = addPeriod(Number(session.metadata.period_start) * 1000 || sub.next_at, sub); }
  if (sub.status === 'past_due') sub.status = 'active';
  sub.events.push({ at: now(), status: 'paid', note: `${session.id} · ${payment.id}` }); store.put('subscriptions', sub);
  core.emit(sub.merchant_id, sub.mode, 'subscription.paid', publicSubscription(sub));
}
/** Customer ticked "save card for automatic renewals" while paying a subscription invoice by card (sandbox test cards). */
function saveCard(subId, merchantId, { number, exp, brand, country }) {
  const sub = store.get('subscriptions', subId); if (!sub || sub.merchant_id !== merchantId || sub.status === 'canceled') return;
  const [mm, yy] = String(exp).split('/').map(x => x.trim());
  sub.card = { number: U.seal(number), exp, exp_month: +mm, exp_year: 2000 + +yy, brand, last4: number.slice(-4), country, saved_at: now() };
  sub.events.push({ at: now(), status: 'card_saved', note: `${brand} ••${number.slice(-4)}` }); store.put('subscriptions', sub);
}

function update(sub, input, actor) {
  if (sub.status === 'canceled') throw bad('This subscription is canceled.');
  const changes = [];
  if (input.amount != null) { const a = Number(input.amount); if (!Number.isInteger(a) || a < 50) throw bad('amount must be an integer in minor units, at least 50.'); changes.push(`amount ${fmt(sub.amount, sub.currency)} → ${fmt(a, sub.currency)}`); sub.amount = a; }
  if (input.description != null) { sub.description = U.str(input.description, 200) || sub.description; changes.push('description'); }
  if (input.remove_card) { sub.card = null; changes.push('auto-charge card removed'); }
  if (input.status === 'paused' || input.status === 'active') { if (input.status === 'active' && sub.status === 'paused') sub.status = sub.current_invoice ? 'past_due' : 'active'; else if (input.status === 'paused') sub.status = 'paused'; changes.push('status ' + sub.status); }
  sub.events.push({ at: now(), status: 'updated', note: `${changes.join(', ')} by ${actor}` }); store.put('subscriptions', sub);
  core.audit(actor, 'subscription.update', sub.id, changes.join(', '), sub.merchant_id); core.emit(sub.merchant_id, sub.mode, 'subscription.updated', publicSubscription(sub));
  return sub; // the new amount applies from the next invoice; an already-issued pending invoice keeps its amount
}
function cancel(sub, actor) {
  if (sub.status === 'canceled') return sub;
  sub.status = 'canceled'; sub.canceled_at = now(); sub.events.push({ at: now(), status: 'canceled', note: `by ${actor}` });
  const s = sub.current_invoice && store.get('checkout_sessions', sub.current_invoice);
  if (s && s.status === 'open' && !s.payment_id) { s.status = 'expired'; store.put('checkout_sessions', s); }
  sub.card = null; store.put('subscriptions', sub);
  core.audit(actor, 'subscription.cancel', sub.id, '', sub.merchant_id); core.emit(sub.merchant_id, sub.mode, 'subscription.canceled', publicSubscription(sub));
  return sub;
}

/** Billing job: issue due invoices, mark long-pending ones past due. */
function run() {
  let billed = 0, pastDue = 0;
  for (const sub of store.list('subscriptions', { status: ['active', 'past_due'] }, { limit: 5000, asc: true })) {
    if (sub.next_at <= now() && !(sub.current_invoice && store.get('checkout_sessions', sub.current_invoice)?.status === 'open')) { bill(sub); billed++; continue; }
    if (sub.status === 'active' && sub.pending_since && now() - sub.pending_since > GRACE(sub.mode)) {
      sub.status = 'past_due'; sub.events.push({ at: now(), status: 'past_due', note: 'Invoice unpaid after the grace period' }); store.put('subscriptions', sub); pastDue++;
      core.emit(sub.merchant_id, sub.mode, 'subscription.past_due', publicSubscription(sub));
    }
  }
  return { billed, pastDue };
}

module.exports = { INTERVALS, publicSubscription, create, bill, onInvoicePaid, saveCard, update, cancel, run };
