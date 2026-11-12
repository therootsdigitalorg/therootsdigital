'use strict';
/* Hosted checkout (customer-facing), payment-link redirects, inbound provider webhooks
   and integration downloads. Checkout session IDs are unguessable capability tokens.
   This phase: MetaMask USDC on Base. Card and legacy crypto endpoints remain but refuse work
   because those methods are switched off (core.methodAvailable). */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const store = require('../db');
const U = require('../util');
const core = require('../core');
const P = require('../providers');
const { HttpError, bad } = U;

const usdc = require('../usdc');
const cards = require('../cards');
const C = require('../chain');
const E = require('../evm');

function view(s) {
  const m = core.merchant(s.merchant_id), p = s.payment_id ? store.get('payments', s.payment_id) : null;
  const methods = s.methods.filter(x => core.methodAvailable(m, s.mode, x));
  const key = C.networkFor(s.mode), w = usdc.receivingWallet(m, s.mode);
  return {
    id: s.id, mode: s.mode, status: s.status, amount: s.amount, currency: s.currency, description: s.description, merchant: { name: m.name, website: m.website, support_email: m.support_email },
    methods, cancel_url: s.cancel_url, success_url: s.success_url, customer_email: s.customer_email, expires_at: s.expires_at,
    usdc: methods.includes('usdc') ? { chain: C.walletParams(key), recipient: w.address, amount_units: E.centsToUnits(s.amount), confirmations: C.net(key).confirmations, finality: C.net(key).finality,
      quote_minutes: C.net(key).quoteMinutes, explorer: C.NETWORKS[key].explorer } : null,
    card: methods.includes('card') && !config.multiMerchant ? { provider: 'authorize_net', hosted: true, sandbox: s.mode === 'test', test_cards: [] }
      : methods.includes('card') ? { sandbox: s.mode === 'test', test_cards: s.mode === 'test' ? Object.entries(P.TEST_CARDS).map(([number, c]) => ({ number, brand: c.brand, country: c.country, label: c.label })) : [] } : null,
    subscription: s.metadata?.subscription_id ? (() => { const sub = store.get('subscriptions', s.metadata.subscription_id); return sub ? { interval: sub.interval, interval_count: sub.interval_count, can_save_card: s.mode === 'test' && methods.includes('card') } : null; })() : null,
    payment: p ? paymentView(p) : null,
  };
}
function paymentView(p) {
  const base = { id: p.id, status: p.status, method: p.method, amount: p.amount, currency: p.currency, created: Math.floor(p.created_at / 1000), decline: p.status === 'declined' ? p.events.at(-1).note : null,
    card: p.card ? { brand: p.card.brand, last4: p.card.last4, exp_month: p.card.exp_month || null, exp_year: p.card.exp_year || null, cardholder: p.card.holder || null, three_ds: p.card.threeDS?.result || null, auth_code: p.card.authCode || null } : null,
    ...(p.provider === 'authorize_net' ? { provider: 'authorize_net', invoice: p.anet.invoice, trans_id: p.anet.transId || null, customer: { name: p.customer?.name, email: p.customer?.email } } : {}) };
  const c = p.crypto;
  if (!c) return { ...base, crypto: null };
  if (p.method !== 'usdc') return { ...base, crypto: { provider: c.provider, asset: c.asset, network: c.network, network_label: P.NETWORKS[c.network]?.label, address: c.address || null, amount_due: c.quoteAmount, received: c.received, confirmations: c.confirmations, required: c.required, expires_at: c.expiresAt, excess: c.excess } };
  const pendingUnits = c.txs.filter(t => ['pending', 'confirming'].includes(t.status)).reduce((s, t) => s + BigInt(t.valueUnits || (t.status === 'pending' ? c.amountUnits : '0')), 0n);
  const remaining = BigInt(c.amountUnits) - BigInt(c.receivedUnits || '0') - pendingUnits;
  return { ...base, crypto: { provider: 'metamask', asset: 'USDC', network: c.network, network_label: C.NETWORKS[c.network].name, chain_id: c.chain_id, token: c.token, recipient: c.recipient, payer: c.payer,
    amount_due: c.quoteAmount, amount_units: c.amountUnits, received: c.received, received_units: c.receivedUnits, remaining_units: (remaining > 0n ? remaining : 0n).toString(),
    confirmations: c.confirmations, required: c.required, finality: c.finality, expires_at: c.expiresAt, excess: c.excess || 0, head: c.head || null,
    txs: c.txs.map(t => ({ hash: t.hash, status: t.status, confirmations: t.confirmations || 0, block: t.blockNumber || null, amount_units: t.valueUnits || null, reason: t.reason || null, url: C.explorerTx(c.network, t.hash) })),
    tx_request: remaining > 0n && ['awaiting_payment', 'underpaid', 'expired'].includes(p.status) ? { from: c.payer, to: c.token, value: '0x0', data: E.transferData(c.recipient, remaining.toString()) } : null } };
}
/* Small per-IP throttle on the customer-facing write endpoints (signature + RPC work). */
const hits = new Map();
function throttle(ip, limit = 40) { const t = Date.now(), h = hits.get(ip) || { n: 0, t }; if (t - h.t > 60000) { h.n = 0; h.t = t; } if (++h.n > limit) throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a minute and try again.'); hits.set(ip, h); if (hits.size > 20000) hits.clear(); }
function sessionFor(id) { const s = store.get('checkout_sessions', id); if (!s) throw new HttpError(404, 'not_found', 'Checkout not found.'); return s; }
function paymentFor(id, sessionId) { const p = store.get('payments', id); if (!p || p.session_id !== sessionId) throw new HttpError(404, 'not_found', 'Payment not found.'); return p; }

/* Inbound provider webhook bookkeeping: dedupe by provider event id. */
function recordProviderEvent(provider, eventId, info) {
  const k = `${provider}:${eventId}`;
  if (store.byKey('provider_events', k)) return false;
  store.put('provider_events', { id: U.id('pev'), k, status: info.result, provider, ...info });
  return true;
}

function routes(r) {
  const page = file => () => ({ file: path.join(config.ROOT, 'public', file), type: 'text/html; charset=utf-8' });
  r('GET', '/pay/:id', page('checkout.html'));
  r('GET', '/l/:slug', ctx => {
    const l = store.byKey('links', ctx.params.slug);
    if (!l) throw new HttpError(404, 'not_found', 'This payment link does not exist.');
    if (!core.linkActive(l)) return { html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link unavailable</title><body style="font-family:system-ui;padding:40px;text-align:center"><h1>This payment link is no longer active</h1><p>Ask the merchant for a new link.</p>`, status: 410 };
    const m = core.merchant(l.merchant_id);
    let s;
    const methods = [...new Set([...(l.methods || []), 'card', 'usdc'])].filter(x => core.methodAvailable(m, l.mode, x));
    try { s = core.createSession(m, l.mode, { amount: l.amount, currency: l.currency, description: l.description, payment_methods: methods.length ? methods : l.methods, link_id: l.id }, 'payment_link'); }
    catch (e) { if (!(e instanceof HttpError) || e.status >= 500) throw e; return { html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment unavailable</title><body style="font-family:system-ui;padding:40px;text-align:center"><h1>This payment link cannot take payments right now</h1><p>The merchant has not finished setting up payments. Please contact them.</p>`, status: 409 }; }
    return { redirect: `/pay/${s.id}` };
  });

  r('GET', '/c-api/sessions/:id', async ctx => {
    const s = sessionFor(ctx.params.id), p = s.payment_id ? store.get('payments', s.payment_id) : null;
    // Back from the hosted page: the redirect itself proves nothing, so ask Authorize.Net (server to server) what happened.
    if (p?.provider === 'authorize_net') { if (['created', 'pending', 'authorized'].includes(p.status)) await cards.reconcile(p, { force: ctx.query.return === '1' }).catch(e => console.error('[card-return]', e.message)); }
    else if (p) await usdc.refreshPayment(p);
    return view(store.get('checkout_sessions', s.id));
  });
  /* ---- Authorize.Net Accept Hosted: customer details → hosted-page token (card data is typed on Authorize.Net only) ---- */
  r('POST', '/c-api/sessions/:id/anet/start', async ctx => { throttle(ctx.ip, 20); const out = await cards.start(sessionFor(ctx.params.id), ctx.body); return { form: out.form, payment: paymentView(out.payment) }; });
  r('POST', '/c-api/sessions/:id/card', ctx => paymentView(core.cardPay(sessionFor(ctx.params.id), ctx.body)));
  r('POST', '/c-api/sessions/:id/crypto', async ctx => paymentView(await core.cryptoStart(sessionFor(ctx.params.id), ctx.body)));
  r('POST', '/c-api/sessions/:id/payments/:pid/3ds', ctx => paymentView(core.complete3DS(paymentFor(ctx.params.pid, ctx.params.id), ctx.body.code)));
  r('GET', '/c-api/sessions/:id/payments/:pid', async ctx => paymentView(await usdc.refreshPayment(paymentFor(ctx.params.pid, ctx.params.id))));
  /* ---- MetaMask USDC ---- */
  r('POST', '/c-api/sessions/:id/usdc/challenge', ctx => { throttle(ctx.ip); return usdc.checkoutChallenge(sessionFor(ctx.params.id), ctx.body); });
  r('POST', '/c-api/sessions/:id/usdc/start', async ctx => { throttle(ctx.ip); return paymentView(await usdc.startPayment(sessionFor(ctx.params.id), ctx.body, ctx.ip)); });
  r('POST', '/c-api/sessions/:id/payments/:pid/tx', async ctx => { throttle(ctx.ip); return paymentView(await usdc.submitPaymentTx(paymentFor(ctx.params.pid, ctx.params.id), String(ctx.body.hash || ''))); });
  r('POST', '/c-api/sessions/:id/payments/:pid/cancel', ctx => paymentView(usdc.cancelAwaiting(sessionFor(ctx.params.id), paymentFor(ctx.params.pid, ctx.params.id))));
  r('POST', '/c-api/sessions/:id/payments/:pid/retry', ctx => store.tx(() => {
    const s = sessionFor(ctx.params.id), p = paymentFor(ctx.params.pid, s.id);
    if (s.status !== 'open' || s.payment_id !== p.id) throw new HttpError(409, 'payment_changed', 'This checkout has moved on to another payment attempt.');
    if (!['declined', 'expired', 'canceled', 'wrong_network'].includes(p.status)) throw bad('This payment cannot be retried.');
    s.payment_id = null; store.put('checkout_sessions', s); return { ok: true };
  }));
  /** Sandbox wallet simulator — test mode only. Stands in for a verified provider event. */
  r('POST', '/c-api/sessions/:id/payments/:pid/simulate', ctx => {
    const p = paymentFor(ctx.params.pid, ctx.params.id);
    if (p.mode !== 'test' || p.method !== 'crypto') throw new HttpError(403, 'test_only', 'The wallet simulator works in test mode only.');
    const c = p.crypto, k = ctx.body.kind;
    if (k === 'exact') core.cryptoDetected(p, c.quoteAmount);
    else if (k === 'under') core.cryptoDetected(p, Math.round(c.quoteAmount * 0.9));
    else if (k === 'over') core.cryptoDetected(p, Math.round(c.quoteAmount * 1.05));
    else if (k === 'topup') core.cryptoDetected(p, c.quoteAmount - c.received);
    else if (k === 'wrong') core.cryptoDetected(p, c.quoteAmount, Object.keys(P.NETWORKS).find(n => n !== c.network && !P.NETWORKS[n].internal && P.NETWORKS[n].assets.includes(c.asset)));
    else if (k === 'expire') { c.expiresAt = 0; core.cryptoExpire(p); }
    else throw bad('Unknown simulation.');
    store.put('provider_events', { id: U.id('pev'), k: `sandbox:${U.rid(16)}`, status: 'processed', provider: 'sandbox', type: 'simulate.' + k, payment_id: p.id, sig: 'n/a (sandbox)' });
    return paymentView(store.get('payments', p.id));
  });

  /* ---- inbound provider webhooks (raw body verified before parsing) ---- */
  r('POST', '/hooks/authorize-net', ctx => cards.webhook(ctx));
  r('POST', '/api/v1/webhooks/authorize-net', ctx => cards.webhook(ctx));
  /** Mode B placeholder: no settlement provider is integrated, so nothing is accepted here (never trust an unverified event). */
  r('POST', '/api/v1/webhooks/settlement-provider', ctx => {
    store.put('provider_events', { id: U.id('pev'), k: `settlement:refused:${U.rid(12)}`, status: 'rejected', provider: 'settlement_provider', type: 'not_integrated', sig: 'not checked', ip: ctx.ip });
    throw new HttpError(501, 'not_integrated', 'No settlement provider is integrated. Events are not accepted.');
  });
  r('POST', '/hooks/binance-pay', ctx => {
    if (!P.BinancePay.verifyWebhook(ctx.headers, ctx.raw)) { store.put('provider_events', { id: U.id('pev'), k: `binance:rejected:${U.rid(12)}`, status: 'rejected', provider: 'binance', type: 'unverified', sig: 'invalid', ip: ctx.ip }); throw new HttpError(400, 'invalid_signature', 'Signature verification failed'); }
    const e = P.BinancePay.parseWebhook(JSON.parse(ctx.raw));
    const p = store.list('payments', { status: ['awaiting_payment', 'confirming', 'underpaid'] }, { limit: 5000 }).find(x => x.crypto?.tradeNo === e.tradeNo && x.crypto.provider === 'binance');
    if (!recordProviderEvent('binance', e.eventId, { result: 'processed', type: e.raw, payment_id: p?.id || null, sig: 'verified' })) return P.BinancePay.webhookAck();
    if (p && e.status === 'paid') core.providerPaid(p, e.amount);
    if (p && e.status === 'expired') core.cryptoExpire(p);
    return P.BinancePay.webhookAck();
  });
  r('POST', '/hooks/coinbase', ctx => {
    if (!P.Coinbase.verifyWebhook(ctx.headers, ctx.raw)) { store.put('provider_events', { id: U.id('pev'), k: `coinbase:rejected:${U.rid(12)}`, status: 'rejected', provider: 'coinbase', type: 'unverified', sig: 'invalid', ip: ctx.ip }); throw new HttpError(400, 'invalid_signature', 'Signature verification failed'); }
    const e = P.Coinbase.parseWebhook(JSON.parse(ctx.raw));
    const p = e.paymentId && store.get('payments', e.paymentId);
    if (!recordProviderEvent('coinbase', e.eventId, { result: 'processed', type: e.raw, payment_id: p?.id || null, sig: 'verified' })) return { ok: true, duplicate: true };
    if (p && p.crypto?.provider === 'coinbase' && e.status === 'paid') core.providerPaid(p, e.amount);
    if (p && p.crypto?.provider === 'coinbase' && e.status === 'expired') core.cryptoExpire(p);
    return { ok: true };
  });

  /* ---- integration downloads ---- */
  const bundle = (dir, prefix) => {
    const files = []; const walk = d => { for (const f of fs.readdirSync(d)) { if (f === '.env' || f.endsWith('.log')) continue; const full = path.join(d, f); if (fs.statSync(full).isDirectory()) walk(full); else files.push([prefix + '/' + path.relative(path.join(config.ROOT, dir), full).replace(/\\/g, '/'), fs.readFileSync(full)]); } };
    walk(path.join(config.ROOT, dir)); return U.zip(files);
  };
  r('GET', '/downloads/digitalhub-woocommerce.zip', () => ({ buffer: bundle('plugins/woocommerce/digitalhub-payments', 'digitalhub-payments'), type: 'application/zip', name: 'digitalhub-woocommerce.zip' }));
  r('GET', '/downloads/digitalhub-shopify-bridge.zip', () => ({ buffer: bundle('plugins/shopify', 'digitalhub-shopify-bridge'), type: 'application/zip', name: 'digitalhub-shopify-bridge.zip' }));
  r('GET', '/downloads/digitalhub-node-sdk.zip', () => ({ buffer: bundle('sdk/node', 'digitalhub-node'), type: 'application/zip', name: 'digitalhub-node-sdk.zip' }));
}

module.exports = { routes };
