'use strict';
/* Public REST API — /v1. Authenticated with secret keys (Authorization: Bearer dh_test_sk_…).
   The key's mode (test / live) decides which data and money the request touches.
   Every POST accepts an Idempotency-Key header. */
const store = require('../db');
const L = require('../ledger');
const U = require('../util');
const core = require('../core');
const { HttpError, bad } = U;

const SCOPES = ['checkout:write', 'payments:read', 'payments:write', 'refunds:write', 'balance:read', 'links:write', 'payouts:write', 'webhooks:write', 'events:read'];
const EVENT_TYPES = ['checkout.session.completed', 'checkout.session.expired', 'payment.authorized', 'payment.succeeded', 'payment.failed', 'payment.canceled', 'payment.refunded', 'refund.created',
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

  get('/v1/account', 'payments:read', (ctx, a) => ({ id: a.m.id, object: 'account', name: a.m.name, country: a.m.country, status: a.m.status, livemode: a.mode === 'live',
    payment_methods: ['card', 'crypto'].filter(x => core.methodAvailable(a.m, a.mode, x)), crypto_options: core.cryptoOptions(a.m).map(([asset, network]) => ({ asset, network })) }));

  post('/v1/checkout/sessions', 'checkout:write', (ctx, a) => core.publicSession(core.createSession(a.m, a.mode, ctx.body, actor(a))));
  get('/v1/checkout/sessions/:id', 'checkout:read', (ctx, a) => core.publicSession(owned('checkout_sessions', ctx.params.id, a)));
  get('/v1/checkout/sessions', 'payments:read', (ctx, a) => listOf(store.list('checkout_sessions', { merchant_id: a.m.id, mode: a.mode }, { limit: lim(ctx.query) + 1, offset: offset(ctx.query) }), core.publicSession, lim(ctx.query)));

  get('/v1/payments', 'payments:read', (ctx, a) => listOf(store.list('payments', { merchant_id: a.m.id, mode: a.mode, ...(ctx.query.status ? { status: ctx.query.status } : {}) }, { limit: lim(ctx.query) + 1, offset: offset(ctx.query) }), core.publicPayment, lim(ctx.query)));
  get('/v1/payments/:id', 'payments:read', (ctx, a) => core.publicPayment(owned('payments', ctx.params.id, a)));
  post('/v1/payments/:id/capture', 'payments:write', (ctx, a) => core.publicPayment(core.capture(owned('payments', ctx.params.id, a), actor(a))));
  post('/v1/payments/:id/cancel', 'payments:write', (ctx, a) => core.publicPayment(core.cancel(owned('payments', ctx.params.id, a), actor(a))));

  post('/v1/refunds', 'refunds:write', (ctx, a) => {
    const p = owned('payments', ctx.body.payment, a);
    return core.publicRefund(core.refund(p, ctx.body.amount == null ? null : Number(ctx.body.amount), { actor: actor(a), reason: ctx.body.reason, address: ctx.body.address, network: ctx.body.network }));
  });
  get('/v1/refunds', 'payments:read', (ctx, a) => listOf(store.list('refunds', { merchant_id: a.m.id, mode: a.mode }, { limit: lim(ctx.query) + 1, offset: offset(ctx.query) }), core.publicRefund, lim(ctx.query)));

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
