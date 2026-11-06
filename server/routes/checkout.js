'use strict';
/* Hosted checkout (customer-facing), payment-link redirects, verified Cash App webhooks and
   integration downloads. Checkout session IDs are unguessable capability tokens. */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const store = require('../db');
const U = require('../util');
const core = require('../core');
const CA = require('../cashapp');
const { HttpError, bad } = U;

function view(s) {
  const m = core.merchant(s.merchant_id), p = s.payment_id ? store.get('payments', s.payment_id) : null;
  return {
    id: s.id, mode: s.mode, status: s.status, amount: s.amount, currency: s.currency, description: s.description,
    merchant: { name: m.name, website: m.website, support_email: m.support_email },
    available: core.methodAvailable(m, s.mode), environment: CA.environmentLabel(s.mode), simulator: s.mode === 'test' && CA.simulated('test'),
    cancel_url: s.cancel_url, success_url: s.success_url, customer_email: s.customer_email,
    payment: p ? paymentView(p) : null,
  };
}
function paymentView(p) {
  const c = p.cashapp || {}, t = c.triggers || {};
  return { id: p.id, status: p.status, method: p.method, amount: p.amount, currency: p.currency, created: Math.floor(p.created_at / 1000), decline_code: p.declineCode || null,
    decline: ['declined', 'expired', 'canceled'].includes(p.status) ? (p.events.at(-1)?.note || null) : null, refunded: p.refunded,
    cash_app: p.method === 'cashapp' ? { request_status: c.request_status || null, qr_code_image_url: t.qr_code_image_url || null, qr_code_svg_url: t.qr_code_svg_url || null,
      mobile_url: t.mobile_url || null, desktop_url: t.desktop_url || null, refreshes_at: t.refreshes_at || null, expires_at: c.request_expires_at || null, payment_id: c.payment_id || null } : null };
}
function sessionFor(id) { const s = store.get('checkout_sessions', id); if (!s) throw new HttpError(404, 'not_found', 'Checkout not found. Check the link or ask the store for a new one.'); return s; }
function paymentFor(id, sessionId) { const p = store.get('payments', id); if (!p || p.session_id !== sessionId) throw new HttpError(404, 'not_found', 'Payment not found.'); return p; }
const flush = async r => { await core.flushSimEvents(); return r; };

function routes(r) {
  const page = file => () => ({ file: path.join(config.ROOT, 'public', file), type: 'text/html; charset=utf-8' });
  r('GET', '/pay/:id', page('checkout.html'));
  r('GET', '/l/:slug', ctx => {
    const l = store.byKey('links', ctx.params.slug);
    if (!l || !core.linkActive(l)) return { html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link unavailable</title><body style="font-family:system-ui;padding:40px;text-align:center"><h1>This payment link is not active</h1><p>Ask the merchant for a new link.</p>`, status: l ? 410 : 404 };
    const s = core.createSession(core.merchant(l.merchant_id), l.mode, { amount: l.amount, currency: l.currency, description: l.description, link_id: l.id }, 'payment_link');
    return { redirect: `/pay/${s.id}` };
  });

  r('GET', '/c-api/sessions/:id', async ctx => {
    const s = sessionFor(ctx.params.id);
    if (s.payment_id) { const p = store.get('payments', s.payment_id); if (p && [...core.IN_FLIGHT].includes(p.status)) await core.syncPayment(p); await core.flushSimEvents(); }
    return view(store.get('checkout_sessions', s.id));
  });
  r('POST', '/c-api/sessions/:id/cashapp', async ctx => flush(paymentView(await core.startCashApp(sessionFor(ctx.params.id), ctx.body))));
  /** Polled by the checkout page; pulls the latest state from Cash App when the payment is still in flight. */
  r('GET', '/c-api/sessions/:id/payments/:pid', async ctx => {
    let p = paymentFor(ctx.params.pid, ctx.params.id);
    if ([...core.IN_FLIGHT].includes(p.status)) p = await core.syncPayment(p);
    await core.flushSimEvents();
    return paymentView(store.get('payments', p.id));
  });
  r('POST', '/c-api/sessions/:id/payments/:pid/cancel', async ctx => {
    const p = paymentFor(ctx.params.pid, ctx.params.id);
    if (p.status !== 'awaiting_customer') throw bad('This payment can no longer be canceled here.');
    return paymentView(await core.cancel(p, 'customer'));
  });
  r('POST', '/c-api/sessions/:id/payments/:pid/retry', ctx => store.tx(() => {
    const s = sessionFor(ctx.params.id), p = paymentFor(ctx.params.pid, s.id);
    if (s.status !== 'open' || s.payment_id !== p.id) throw new HttpError(409, 'payment_changed', 'This checkout has moved on to another payment attempt.');
    if (!['declined', 'expired', 'canceled'].includes(p.status)) throw bad('This payment cannot be retried.');
    s.payment_id = null; store.put('checkout_sessions', s); return { ok: true };
  }));

  /* ---- local simulator approval screen (test mode without Cash App sandbox credentials) ---- */
  const simRequest = id => { if (!CA.simulated('test') || !/^GRR_sim_/.test(id)) throw new HttpError(404, 'not_found', 'Not available.'); return id; };
  r('GET', '/cashapp-sim/:rid', ctx => { simRequest(ctx.params.rid); return { file: path.join(config.ROOT, 'public', 'cashapp-sim.html'), type: 'text/html; charset=utf-8' }; });
  r('GET', '/c-api/cashapp-sim/:rid', async ctx => {
    const req = await CA.sim.retrieveCustomerRequest(simRequest(ctx.params.rid));
    const p = store.byKey('payments', req.id), m = p && core.merchant(p.merchant_id);
    return { id: req.id, status: req.status, amount: req.actions[0]?.amount, currency: req.actions[0]?.currency, merchant: m?.name || 'Merchant', redirect_url: req.redirect_url, expires_at: req.expires_at };
  });
  r('POST', '/c-api/cashapp-sim/:rid', async ctx => {
    const req = CA.sim.decide(simRequest(ctx.params.rid), ctx.body.decision === 'approve');
    await core.flushSimEvents();
    const p = store.byKey('payments', req.id);
    if (p && core.IN_FLIGHT.includes(p.status)) await core.syncPayment(p, { force: true });
    await core.flushSimEvents();
    return { status: req.status, redirect_url: req.redirect_url };
  });

  /* ---- inbound Cash App webhooks: signature verified on the raw body, deduplicated by event_id ---- */
  for (const [seg, mode] of [['sandbox', 'test'], ['production', 'live']]) {
    r('POST', `/hooks/cashapp/${seg}`, async ctx => {
      const ok = CA.verifyWebhook(mode, { method: 'POST', path: ctx.path, headers: ctx.headers, raw: ctx.raw });
      if (!ok) { store.put('provider_events', { id: U.id('pev'), k: `cashapp:${mode}:rejected:${U.rid(12)}`, status: 'rejected', provider: 'cashapp', mode, type: 'unverified', sig: 'invalid', ip: ctx.ip }); throw new HttpError(403, 'invalid_signature', 'Signature verification failed'); }
      let evt; try { evt = JSON.parse(ctx.raw); } catch { throw bad('Invalid JSON'); }
      const k = `cashapp:${mode}:${evt.event_id}`;
      if (!evt.event_id || store.byKey('provider_events', k)) return { ok: true, duplicate: !!evt.event_id };
      const result = await core.handleCashAppEvent(evt, mode);
      store.put('provider_events', { id: U.id('pev'), k, status: 'processed', provider: 'cashapp', mode, type: evt.type, sig: 'verified', payment_id: result.payment || null, result });
      return { ok: true };
    });
  }

  /* ---- integration downloads ---- */
  const bundle = (dir, prefix) => {
    const files = []; const walk = d => { for (const f of fs.readdirSync(d)) { if (f === '.env' || f.endsWith('.log')) continue; const full = path.join(d, f); if (fs.statSync(full).isDirectory()) walk(full); else files.push([prefix + '/' + path.relative(path.join(config.ROOT, dir), full).replace(/\\/g, '/'), fs.readFileSync(full)]); } };
    walk(path.join(config.ROOT, dir)); return U.zip(files);
  };
  r('GET', '/downloads/digitalhub-woocommerce.zip', () => ({ buffer: bundle('plugins/woocommerce/digitalhub-payments', 'digitalhub-payments'), type: 'application/zip', name: 'digitalhub-woocommerce.zip' }));
  r('GET', '/downloads/digitalhub-node-sdk.zip', () => ({ buffer: bundle('sdk/node', 'digitalhub-node'), type: 'application/zip', name: 'digitalhub-node-sdk.zip' }));
}

module.exports = { routes };
