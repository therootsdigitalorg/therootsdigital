'use strict';
/* Public REST API — /v1. Authenticated with secret keys (Authorization: Bearer dh_test_sk_…).
   The key's mode (test / live) decides which data and money the request touches.
   Every POST accepts an Idempotency-Key header. */
const store = require('../db');
const L = require('../ledger');
const U = require('../util');
const core = require('../core');
const usdc = require('../usdc');
const C = require('../chain');
const { HttpError, bad } = U;

const SCOPES = ['checkout:write', 'checkout:read', 'payments:read', 'payments:write', 'refunds:write', 'balance:read', 'links:write', 'payouts:write', 'webhooks:write', 'events:read'];
const EVENT_TYPES = ['subscription.created', 'subscription.invoice_pending', 'subscription.paid', 'subscription.past_due', 'subscription.updated', 'subscription.canceled', 'checkout.session.completed', 'checkout.session.expired', 'payment.authorized', 'payment.succeeded', 'payment.failed', 'payment.canceled', 'payment.refunded', 'refund.created', 'refund.succeeded', 'refund.updated',
  'crypto.payment.created', 'crypto.payment.detected', 'crypto.payment.underpaid', 'crypto.payment.expired', 'payout.created', 'payout.paid', 'payout.failed', 'dispute.created', 'dispute.closed'];

const rate = new Map();
function authenticate(ctx) {
  let token = '';
  const h = ctx.headers.authorization || '';
  if (h.startsWith('Bearer ')) token = h.slice(7).trim();
  else if (h.startsWith('Basic ')) token = Buffer.from(h.slice(6), 'base64').toString().split(':')[0];
  if (!/^dh_(test|live)_(sk|pk)_[A-Za-z0-9]{24,64}$/.test(token)) throw new HttpError(401, 'api_key_missing', 'Provide a valid API key: Authorization: Bearer dh_test_sk_…');
  const key = store.byKey('api_keys', U.sha256(token));
  if (!key || !(key.status === 'active' || (key.status === 'expiring' && Date.now() < key.expires_at))) throw new HttpError(401, 'api_key_invalid', 'This API key is invalid or revoked.');
  const m = store.get('merchants', key.merchant_id);
  if (!m?.perms.api) throw new HttpError(403, 'api_disabled', 'API access is disabled for this account.');
  if (key.allowed_ips?.length && !key.allowed_ips.includes(ctx.ip)) throw new HttpError(403, 'ip_not_allowed', 'Request IP is not on this key\'s allowlist.');
  core.assertMode(m, key.mode);
  const r = rate.get(key.id) || { n: 0, t: Date.now() };
  if (Date.now() - r.t > 10000) { r.n = 0; r.t = Date.now(); }
  if (++r.n > 100) throw new HttpError(429, 'rate_limited', 'Too many requests. Slow down and retry.');
  rate.set(key.id, r);
  if (!key.last_used || Date.now() - key.last_used > 60000) { key.last_used = Date.now(); store.put('api_keys', key); }
  ctx.auth = { merchant_id: m.id, key: key.prefix + '…' + key.last4, mode: key.mode };
  return { key, m, mode: key.mode };
}
function scope(a, s) {
  if (a.key.type === 'publishable' && s !== 'checkout:read') throw new HttpError(403, 'publishable_key', 'Publishable keys can only read checkout session status. Use a secret key on your server.');
  if (a.key.type === 'secret' && !a.key.scopes.includes('*') && !a.key.scopes.includes(s)) throw new HttpError(403, 'scope_missing', `This key lacks the "${s}" permission.`);
}
const owned = (table, idv, a) => { const o = store.get(table, idv); if (!o || o.merchant_id !== a.m.id || o.mode !== a.mode) throw new HttpError(404, 'resource_missing', `No such ${table.replace(/s$/, '')}: ${idv}`); return o; };
const listOf = (rows, mapFn, limit) => ({ object: 'list', data: rows.slice(0, limit).map(mapFn), has_more: rows.length > limit });
const lim = q => Math.min(100, Math.max(1, +q.limit || 20));
const offset = q => Math.max(0, +q.offset || 0);

function routes(r) {
  /** POST wrapper: auth → scope → idempotency → handler. */
  const post = (path, sc, fn) => r('POST', path, async ctx => {
    const a = authenticate(ctx); scope(a, sc);
    const out = await core.idempotent(a.m.id, a.mode, ctx.headers['idempotency-key'], U.sha256(ctx.method + ctx.path + JSON.stringify(ctx.body)), async () => ({ status: 200, body: await fn(ctx, a) }));
    if (out.replay) ctx.extraHeaders['Idempotent-Replayed'] = 'true';
    return { status: out.status, body: out.body };
  });
  const get = (path, sc, fn) => r('GET', path, ctx => { const a = authenticate(ctx); scope(a, sc); return fn(ctx, a); });
  const actor = a => `api:${a.key.prefix}…${a.key.last4}`;

  get('/v1/account', 'payments:read', (ctx, a) => { const w = usdc.receivingWallet(a.m, a.mode), n = C.walletParams(C.networkFor(a.mode));
    return { id: a.m.id, object: 'account', name: a.m.name, country: a.m.country, status: a.m.status, livemode: a.mode === 'live',
      payment_methods: core.METHODS.filter(x => core.methodAvailable(a.m, a.mode, x)), usdc: { network: n.chainName, chain_id: n.chainId, token: n.usdc, receiving_wallet: w?.address || null, currency: 'USD' } }; });

  post('/v1/checkout/sessions', 'checkout:write', (ctx, a) => core.publicSession(core.createSession(a.m, a.mode, ctx.body, actor(a))));
  get('/v1/checkout/sessions/:id', 'checkout:read', async (ctx, a) => { const s = owned('checkout_sessions', ctx.params.id, a); if (s.payment_id) await usdc.refreshPayment(store.get('payments', s.payment_id)); return core.publicSession(store.get('checkout_sessions', s.id)); });
  get('/v1/checkout/sessions', 'payments:read', (ctx, a) => listOf(store.list('checkout_sessions', { merchant_id: a.m.id, mode: a.mode }, { limit: lim(ctx.query) + 1, offset: offset(ctx.query) }), core.publicSession, lim(ctx.query)));

  get('/v1/payments', 'payments:read', (ctx, a) => listOf(store.list('payments', { merchant_id: a.m.id, mode: a.mode, ...(ctx.query.status ? { status: ctx.query.status } : {}) }, { limit: lim(ctx.query) + 1, offset: offset(ctx.query) }), core.publicPayment, lim(ctx.query)));
  get('/v1/payments/:id', 'payments:read', async (ctx, a) => core.publicPayment(await usdc.refreshPayment(owned('payments', ctx.params.id, a))));
  const cards = require('../cards'), isAnet = p => p.provider === 'authorize_net';
  post('/v1/payments/:id/capture', 'payments:write', async (ctx, a) => { const p = owned('payments', ctx.params.id, a); return core.publicPayment(isAnet(p) ? await cards.capture(p, ctx.body.amount == null ? null : Number(ctx.body.amount), actor(a)) : core.capture(p, actor(a))); });
  post('/v1/payments/:id/cancel', 'payments:write', async (ctx, a) => { const p = owned('payments', ctx.params.id, a); return core.publicPayment(isAnet(p) ? await cards.voidPayment(p, actor(a)) : core.cancel(p, actor(a))); });

  /** USDC refunds are non-custodial: this creates a refund request (status requires_action). The merchant sends the USDC
      from the receiving wallet with MetaMask in the dashboard; the refund succeeds only when that transfer is verified on Base. */
  post('/v1/refunds', 'refunds:write', async (ctx, a) => {
    const p = owned('payments', ctx.body.payment, a), amount = ctx.body.amount == null ? null : Number(ctx.body.amount);
    if (isAnet(p)) { const out = await cards.refund(p, amount, { actor: actor(a), reason: ctx.body.reason });
      return out.refund ? core.publicRefund(out.refund) : { id: 'void_' + p.id, object: 'refund', livemode: p.mode === 'live', status: 'succeeded', payment: p.id, amount: p.captured, currency: p.currency, reason: 'voided before settlement', voided: true, created: Math.floor(Date.now() / 1000) }; }
    if (p.method === 'usdc') return usdc.publicRefund(await usdc.createRefund(p, amount, { actor: actor(a), reason: ctx.body.reason, address: ctx.body.address || null }));
    return core.publicRefund(core.refund(p, amount, { actor: actor(a), reason: ctx.body.reason, address: ctx.body.address, network: ctx.body.network }));
  });
  const anyRefund = r => r.network ? usdc.publicRefund(r) : core.publicRefund(r);
  get('/v1/refunds', 'payments:read', (ctx, a) => listOf(store.list('refunds', { merchant_id: a.m.id, mode: a.mode }, { limit: lim(ctx.query) + 1, offset: offset(ctx.query) }), anyRefund, lim(ctx.query)));
  get('/v1/refunds/:id', 'payments:read', async (ctx, a) => anyRefund(await usdc.refreshRefund(owned('refunds', ctx.params.id, a))));

  /* WooCommerce aliases (same API keys and scopes as /v1) */
  /** Without opaque_data: creates a session for the hosted payment page (redirect). With opaque_data (Accept.js token from
      the store's checkout page): creates the session and charges the token at once; the response says whether it was paid. */
  post('/api/v1/woocommerce/checkout', 'checkout:write', async (ctx, a) => {
    const s = core.createSession(a.m, a.mode, { ...ctx.body, payment_methods: ['card'] }, actor(a));
    if (!ctx.body.opaque_data) return core.publicSession(s);
    const r = await cards.chargeToken(s, ctx.body, ctx.ip), fresh = store.get('checkout_sessions', s.id);
    return { session: core.publicSession(fresh), payment: core.publicPayment(r.payment), statuses: cards.statuses(r.payment), paid: fresh.status === 'complete', authorized: r.payment.status === 'authorized', message: r.payment.status === 'declined' || r.payment.status === 'pending' ? r.message : null };
  });
  get('/api/v1/woocommerce/config', 'checkout:read', (ctx, a) => ({ ...require('../authorizenet').acceptConfig(require('../authorizenet').envForMode(a.mode)), cards_available: cards.available(a.mode), livemode: a.mode === 'live' }));
  get('/api/v1/woocommerce/payment-status', 'checkout:read', async (ctx, a) => {
    let s = ctx.query.session ? owned('checkout_sessions', String(ctx.query.session), a) : null;
    if (!s && ctx.query.order_id) s = store.list('checkout_sessions', { merchant_id: a.m.id, mode: a.mode }, { limit: 5000 }).find(x => String(x.metadata?.order_id || '') === String(ctx.query.order_id));
    if (!s) throw new HttpError(404, 'resource_missing', 'No checkout session for that session / order_id.');
    let p = s.payment_id ? store.get('payments', s.payment_id) : null; if (p) p = await usdc.refreshPayment(p);
    s = store.get('checkout_sessions', s.id);
    return { session: core.publicSession(s), payment: p ? core.publicPayment(p) : null, statuses: p?.provider === 'authorize_net' ? cards.statuses(p) : null, paid: s.status === 'complete' };
  });

  /* subscriptions — recurring invoices; saved sandbox cards are charged automatically */
  const SUB = require('../subscriptions');
  post('/v1/subscriptions', 'checkout:write', (ctx, a) => SUB.publicSubscription(SUB.create(a.m, a.mode, ctx.body, actor(a))));
  get('/v1/subscriptions', 'payments:read', (ctx, a) => listOf(store.list('subscriptions', { merchant_id: a.m.id, mode: a.mode }, { limit: lim(ctx.query) + 1, offset: offset(ctx.query) }), SUB.publicSubscription, lim(ctx.query)));
  get('/v1/subscriptions/:id', 'payments:read', (ctx, a) => SUB.publicSubscription(owned('subscriptions', ctx.params.id, a)));
  post('/v1/subscriptions/:id', 'checkout:write', (ctx, a) => SUB.publicSubscription(SUB.update(owned('subscriptions', ctx.params.id, a), ctx.body, actor(a))));
  post('/v1/subscriptions/:id/cancel', 'checkout:write', (ctx, a) => SUB.publicSubscription(SUB.cancel(owned('subscriptions', ctx.params.id, a), actor(a))));

  get('/v1/balance', 'balance:read', (ctx, a) => ({ object: 'balance', livemode: a.mode === 'live', balances: Object.entries(L.merchantBalances(a.m.id, a.mode)).map(([currency, b]) => ({ currency, ...b })) }));

  post('/v1/payment_links', 'links:write', (ctx, a) => core.publicLink(core.createLink(a.m, a.mode, ctx.body, actor(a))));
  get('/v1/payment_links', 'payments:read', (ctx, a) => listOf(store.list('links', { merchant_id: a.m.id, mode: a.mode }, { limit: lim(ctx.query) + 1, offset: offset(ctx.query) }), core.publicLink, lim(ctx.query)));
  post('/v1/payment_links/:id/deactivate', 'links:write', (ctx, a) => { const l = owned('links', ctx.params.id, a); l.status = 'deactivated'; store.put('links', l); return core.publicLink(l); });

  get('/v1/payouts', 'balance:read', (ctx, a) => listOf(store.list('payouts', { merchant_id: a.m.id, mode: a.mode }, { limit: lim(ctx.query) + 1, offset: offset(ctx.query) }), core.publicPayout, lim(ctx.query)));
  post('/v1/payouts', 'payouts:write', (ctx, a) => core.publicPayout(core.requestPayout(a.m, a.mode, { currency: ctx.body.currency, amount: Number(ctx.body.amount), destination: ctx.body.destination }, actor(a))));

  get('/v1/events', 'events:read', (ctx, a) => listOf(store.list('events', { merchant_id: a.m.id, mode: a.mode }, { limit: lim(ctx.query) + 1, offset: offset(ctx.query) }).filter(e => !ctx.query.type || e.type === ctx.query.type), core.publicEvent, lim(ctx.query)));
  get('/v1/events/:id', 'events:read', (ctx, a) => core.publicEvent(owned('events', ctx.params.id, a)));

  post('/v1/webhook_endpoints', 'webhooks:write', async (ctx, a) => publicEndpoint(await createEndpoint(a.m, a.mode, ctx.body, actor(a)), true));
  get('/v1/webhook_endpoints', 'webhooks:write', (ctx, a) => listOf(store.list('webhook_endpoints', { merchant_id: a.m.id, mode: a.mode }), e => publicEndpoint(e), 100));
  r('DELETE', '/v1/webhook_endpoints/:id', ctx => { const a = authenticate(ctx); scope(a, 'webhooks:write'); const e = owned('webhook_endpoints', ctx.params.id, a); store.del('webhook_endpoints', e.id); return { id: e.id, object: 'webhook_endpoint', deleted: true }; });
}

async function createEndpoint(m, mode, body, actor) {
  const url = U.str(body.url, 500);
  if (!U.isUrl(url)) throw bad('url must be a full http(s) URL.');
  try { await core.assertWebhookTarget(url); } catch (e) { throw bad(e.message, 'url_invalid'); }
  let events = [].concat(body.events || body.enabled_events || ['*']).map(String);
  if (events.includes('*')) events = ['*'];
  const unknown = events.filter(e => e !== '*' && !EVENT_TYPES.includes(e)); if (unknown.length) throw bad(`Unknown event types: ${unknown.join(', ')}`);
  if (store.count('webhook_endpoints', { merchant_id: m.id, mode }) >= 16) throw bad('Endpoint limit reached (16).');
  const secret = 'whsec_' + U.rid(40, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const ep = store.put('webhook_endpoints', { id: U.id('we'), merchant_id: m.id, mode, status: 'enabled', url, events, description: U.str(body.description, 100), secret: U.seal(secret) });
  core.audit(actor, 'webhook_endpoint.create', ep.id, url, m.id);
  ep._secret = secret; return ep;
}
const publicEndpoint = (e, withSecret) => ({ id: e.id, object: 'webhook_endpoint', livemode: e.mode === 'live', url: e.url, enabled_events: e.events, status: e.status, description: e.description || null, created: Math.floor(e.created_at / 1000), ...(withSecret ? { secret: e._secret } : {}) });

module.exports = { routes, SCOPES, EVENT_TYPES, createEndpoint, publicEndpoint };
