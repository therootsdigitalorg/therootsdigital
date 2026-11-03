'use strict';
/* Hosted checkout (customer-facing), payment-link redirects, inbound provider webhooks
   and integration downloads. Checkout session IDs are unguessable capability tokens. */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const store = require('../db');
const U = require('../util');
const core = require('../core');
const P = require('../providers');
const { HttpError, bad } = U;

function view(s) {
  const m = core.merchant(s.merchant_id), p = s.payment_id ? store.get('payments', s.payment_id) : null;
  const methods = s.methods.filter(x => core.methodAvailable(m, s.mode, x));
  return {
    id: s.id, mode: s.mode, status: s.status, amount: s.amount, currency: s.currency, description: s.description, merchant: { name: m.name, website: m.website, support_email: m.support_email },
    methods, cancel_url: s.cancel_url, success_url: s.success_url, customer_email: s.customer_email,
    crypto: { provider: s.mode === 'test' ? `${P.CRYPTO[m.cryptoProvider].name} (sandbox)` : P.CRYPTO[m.cryptoProvider].name, options: core.cryptoOptions(m).map(([asset, network]) => ({ asset, network, label: P.NETWORKS[network].label, confirmations: P.NETWORKS[network].confirmations })),
      quotes: Object.fromEntries(U.STABLE.map(a => [a, s.mode === 'live' ? s.amount : Math.ceil(s.amount / U.CURRENCIES[s.currency].fx * U.CURRENCIES[a].fx)])) },
    test_cards: s.mode === 'test' ? Object.entries(P.TEST_CARDS).map(([number, c]) => ({ number, brand: c.brand, country: c.country, label: c.label })) : [],
    payment: p ? paymentView(p) : null,
  };
}
function paymentView(p) {
  return { id: p.id, status: p.status, method: p.method, amount: p.amount, currency: p.currency, decline: p.status === 'declined' ? p.events.at(-1).note : null,
    card: p.card ? { brand: p.card.brand, last4: p.card.last4, three_ds: p.card.threeDS?.result || null } : null,
    crypto: p.crypto ? { provider: p.crypto.provider, asset: p.crypto.asset, network: p.crypto.network, network_label: P.NETWORKS[p.crypto.network].label, address: p.crypto.address || null, checkout_url: p.crypto.checkoutUrl || null, qr: p.crypto.qrContent || null,
      amount_due: p.crypto.quoteAmount, received: p.crypto.received, confirmations: p.crypto.confirmations, required: p.crypto.required, expires_at: p.crypto.expiresAt, excess: p.crypto.excess } : null };
}
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
    const s = core.createSession(m, l.mode, { amount: l.amount, currency: l.currency, description: l.description, payment_methods: l.methods, link_id: l.id }, 'payment_link');
    return { redirect: `/pay/${s.id}` };
  });

  r('GET', '/c-api/sessions/:id', ctx => view(sessionFor(ctx.params.id)));
  r('POST', '/c-api/sessions/:id/card', ctx => paymentView(core.cardPay(sessionFor(ctx.params.id), ctx.body)));
  r('POST', '/c-api/sessions/:id/crypto', async ctx => paymentView(await core.cryptoStart(sessionFor(ctx.params.id), ctx.body)));
  r('POST', '/c-api/sessions/:id/payments/:pid/3ds', ctx => paymentView(core.complete3DS(paymentFor(ctx.params.pid, ctx.params.id), ctx.body.code)));
  r('GET', '/c-api/sessions/:id/payments/:pid', ctx => paymentView(paymentFor(ctx.params.pid, ctx.params.id)));
  r('POST', '/c-api/sessions/:id/payments/:pid/retry', ctx => {
    const s = sessionFor(ctx.params.id), p = paymentFor(ctx.params.pid, s.id);
    if (!['declined', 'expired', 'canceled'].includes(p.status)) throw bad('This payment cannot be retried.');
    s.payment_id = null; store.put('checkout_sessions', s); return { ok: true };
  });
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
