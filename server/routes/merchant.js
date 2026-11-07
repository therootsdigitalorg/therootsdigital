'use strict';
/* Wallet portal API — /m-api. Session-authenticated team members of the single store account;
   every query is scoped to that account and the selected mode (X-DH-Mode: test | live). */
const config = require('../config');
const store = require('../db');
const L = require('../ledger');
const U = require('../util');
const core = require('../core');
const CA = require('../cashapp');
const auth = require('../auth');
const api = require('./api');
const { HttpError, bad, DAY } = U;

const KEY_ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function issueKey(m, mode, { name, scopes, type = 'secret', allowed_ips = [] }, actor) {
  const secret = `dh_${mode}_${type === 'secret' ? 'sk' : 'pk'}_${U.rid(40, KEY_ALPHA)}`;
  const key = store.put('api_keys', { id: U.id('key'), merchant_id: m.id, mode, status: 'active', k: U.sha256(secret), type, name: U.str(name, 80) || 'Secret key',
    prefix: secret.slice(0, 11), last4: secret.slice(-4), scopes: type === 'secret' ? scopes : ['checkout:read'], allowed_ips, plain: type === 'publishable' ? secret : undefined, last_used: null });
  core.audit(actor, 'api_key.create', key.id, `${mode} ${type}`, m.id);
  return { key, secret };
}
const publicKey = k => ({ id: k.id, mode: k.mode, type: k.type, name: k.name, prefix: k.prefix, last4: k.last4, scopes: k.scopes, allowed_ips: k.allowed_ips || [], status: k.status, expires_at: k.expires_at || null, last_used: k.last_used, created_at: k.created_at, plain: k.type === 'publishable' ? k.plain : undefined });
function ensurePublishable(m, mode, actor) { if (!store.list('api_keys', { merchant_id: m.id, mode }).some(k => k.type === 'publishable' && k.status === 'active')) issueKey(m, mode, { name: 'Publishable key', type: 'publishable' }, actor); }

/** Setup checklist for the store: Cash App credentials, registration, integration, security. */
function onboarding(m) {
  const any = (t, f) => store.list(t, { merchant_id: m.id, ...f }, { limit: 1 }).length > 0;
  const owner = store.list('users', { merchant_id: m.id }).find(u => u.role === 'owner');
  return [
    { key: 'details', label: 'Business details for Cash App', done: !!m.cashapp.details, detail: 'US address and merchant category code (Settings → Cash App Pay).' },
    { key: 'cashapp_test', label: 'Registered with Cash App Pay sandbox', done: core.cashappReady(m, 'test'), detail: CA.simulated('test') ? 'Using the local simulator: registers automatically on the first test checkout.' : 'Settings → Cash App Pay → Register (test mode).' },
    { key: 'api_key', label: 'API key for your store', done: store.list('api_keys', { merchant_id: m.id }).some(k => k.type === 'secret' && k.status === 'active'), detail: 'Developers & API → API keys. Paste it into the WooCommerce plugin.' },
    { key: 'webhook', label: 'Webhook endpoint for your store', done: any('webhook_endpoints', {}), detail: 'Developers & API → Webhooks. The WooCommerce plugin needs one.' },
    { key: 'test_payment', label: 'Complete a test payment', done: store.list('payments', { merchant_id: m.id, mode: 'test', status: core.PAID }, { limit: 1 }).length > 0, detail: 'Pay a payment link or a test order in sandbox.' },
    { key: 'mfa', label: 'Two-factor authentication on the owner account', done: !!owner?.mfa_enabled, detail: 'Required for live keys and production Cash App changes.' },
    { key: 'cashapp_creds', label: 'Cash App production credentials on the server', done: CA.configured('live'), detail: 'CASHAPP_CLIENT_ID, CASHAPP_API_KEY_ID, CASHAPP_API_KEY_SECRET, CASHAPP_WEBHOOK_SECRET in Vercel.' },
    { key: 'cashapp_live', label: 'Registered with Cash App Pay production', done: core.cashappReady(m, 'live'), detail: 'Settings → Cash App Pay → Register (live mode).' },
    { key: 'live', label: 'Live payments on', done: !core.liveReady(m), detail: core.liveReady(m) || 'Live Cash App payments are enabled.' },
  ];
}
const needMfaLive = (c, what) => { if (c.mode === 'live' && config.production && !c.user.mfa_enabled) throw new HttpError(403, 'mfa_required', `Enable two-factor authentication before ${what}.`); };

function routes(r) {
  const M = (method, path, perm, fn) => r(method, '/m-api' + path, async ctx => {
    const a = auth.requireUser(ctx); auth.needMerchant(a.user, perm);
    const m = core.account();
    const mode = ctx.headers['x-dh-mode'] === 'live' ? 'live' : 'test';
    return fn(ctx, { user: a.user, m, mode, actor: a.user.email });
  });
  const mine = (table, idv, c, modeScoped = true) => { const o = store.get(table, idv); if (!o || o.merchant_id !== c.m.id || (modeScoped && o.mode !== c.mode)) throw new HttpError(404, 'not_found', 'Not found'); return o; };

  M('GET', '/overview', 'read', (ctx, c) => {
    const pays = store.list('payments', { merchant_id: c.m.id, mode: c.mode, since: Date.now() - 30 * DAY }, { limit: 5000 });
    const ok = pays.filter(p => core.PAID.includes(p.status)), tried = pays.filter(p => !['created', 'awaiting_customer', 'processing'].includes(p.status));
    const usd = p => U.toUSD(p.amount, p.currency);
    const series = []; const end = new Date(); end.setHours(23, 59, 59, 999);
    for (let i = 13; i >= 0; i--) { const e = end.getTime() - i * DAY, s = e - DAY; const day = ok.filter(p => p.created_at > s && p.created_at <= e); series.push({ label: new Date(e).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), amount: day.reduce((t, p) => t + usd(p), 0) }); }
    const balances = L.merchantBalances(c.m.id, c.mode);
    const attention = [
      ...store.list('payments', { merchant_id: c.m.id, mode: c.mode, status: ['authorized', 'processing'] }, { limit: 20 }).map(p => ({ payment: p.id, status: p.status, amount: p.amount, currency: p.currency })),
      ...store.list('disputes', { merchant_id: c.m.id, mode: c.mode, status: 'needs_response' }, { limit: 20 }).map(d => ({ payment: d.payment_id, status: 'dispute', amount: d.amount, currency: d.currency })),
    ];
    return { gross_usd: ok.reduce((t, p) => t + usd(p), 0), count: ok.length, attempts: tried.length, fees_usd: ok.reduce((t, p) => t + (p.fees ? U.toUSD(p.fees.provider + p.fees.platform, p.currency) : 0), 0), refunded_usd: ok.reduce((t, p) => t + U.toUSD(p.refunded || 0, p.currency), 0),
      disputes_open: store.count('disputes', { merchant_id: c.m.id, mode: c.mode, status: ['needs_response', 'under_review'] }),
      available_usd: Object.entries(balances).reduce((t, [cur, b]) => t + U.toUSD(b.available, cur), 0), balances, series, attention,
      recent: store.list('payments', { merchant_id: c.m.id, mode: c.mode }, { limit: 8 }).map(core.publicPayment), onboarding: onboarding(c.m), live_ready: core.liveReady(c.m), cashapp: cashappStatus(c.m, c.mode) };
  });

  /* ---- payments ---- */
  M('GET', '/payments', 'read', (ctx, c) => {
    const q = ctx.query, s = String(q.q || '').toLowerCase();
    let rows = store.list('payments', { merchant_id: c.m.id, mode: c.mode, ...(q.status ? { status: q.status } : {}) }, { limit: 2000 });
    if (q.method) rows = rows.filter(p => p.method === q.method);
    if (s) rows = rows.filter(p => [p.id, p.customer?.email, p.customer?.name, p.cashapp?.payment_id, p.description, p.metadata && JSON.stringify(p.metadata)].some(x => String(x || '').toLowerCase().includes(s)));
    return { total: rows.length, data: rows.slice(+q.offset || 0, (+q.offset || 0) + 50).map(core.publicPayment) };
  });
  M('GET', '/payments/:id', 'read', (ctx, c) => {
    const p = mine('payments', ctx.params.id, c);
    return { payment: core.publicPayment(p), events: p.events,
      ledger: L.entriesFor(p.id), refunds: store.list('refunds', { merchant_id: c.m.id }).filter(x => x.payment_id === p.id).map(core.publicRefund),
      dispute: (d => d && core.publicDispute(d) && { ...core.publicDispute(d), evidence: d.evidence || [] })(store.list('disputes', { merchant_id: c.m.id }).find(d => d.payment_id === p.id)) || null, refundable: core.maxRefundable(p),
      webhooks: store.list('events', { merchant_id: c.m.id, mode: c.mode }, { limit: 300 }).filter(e => e.data.object.id === p.id).map(e => ({ id: e.id, type: e.type, created: e.created_at })) };
  });
  M('POST', '/payments/:id/capture', 'payments', async (ctx, c) => core.publicPayment(await core.capture(mine('payments', ctx.params.id, c), c.actor)));
  M('POST', '/payments/:id/cancel', 'payments', async (ctx, c) => core.publicPayment(await core.cancel(mine('payments', ctx.params.id, c), c.actor)));
  M('POST', '/payments/:id/sync', 'read', async (ctx, c) => core.publicPayment(await core.syncPayment(mine('payments', ctx.params.id, c), { force: true })));
  M('POST', '/payments/:id/refund', 'refunds', async (ctx, c) => {
    const p = mine('payments', ctx.params.id, c), b = ctx.body;
    const out = await core.idempotent(c.m.id, c.mode, b.idempotency_key, U.sha256(JSON.stringify([p.id, b.amount])), async () => ({ status: 200, body: core.publicRefund(await core.refund(p, b.amount == null ? null : Number(b.amount), { actor: c.actor, reason: b.reason })) }));
    return { ...out.body, replayed: !!out.replay };
  });
  M('GET', '/disputes', 'read', (ctx, c) => store.list('disputes', { merchant_id: c.m.id, mode: c.mode }, { limit: 200 }).map(d => ({ ...core.publicDispute(d), evidence: d.evidence || [] })));
  M('POST', '/disputes/:id/:action', 'payments', async (ctx, c) => {
    const d = mine('disputes', ctx.params.id, c), a = ctx.params.action;
    if (!['accept', 'challenge', 'evidence'].includes(a)) throw bad('Unknown dispute action.');
    return core.publicDispute(await core.disputeAction(d, a, ctx.body, c.actor));
  });
  M('GET', '/refunds', 'read', (ctx, c) => store.list('refunds', { merchant_id: c.m.id, mode: c.mode }, { limit: 200 }).map(core.publicRefund));
  /* ---- Digital Hub Wallet: a record of what Cash App confirmed and settled ---- */
  M('GET', '/wallet', 'read', (ctx, c) => {
    const entries = L.recent(c.mode, 200, c.m.id).filter(e => L.MERCHANT_ACCTS.includes(e.account));
    const pays = store.list('payments', { merchant_id: c.m.id, mode: c.mode }, { limit: 20000 }).filter(p => p.method === 'cashapp');
    const disputed_held = store.list('disputes', { merchant_id: c.m.id, mode: c.mode, status: ['needs_response', 'under_review'] }, { limit: 1000 }).reduce((t, d) => t + d.amount, 0);
    return { balance: L.merchantBalances(c.m.id, c.mode).USD || { pending: 0, available: 0, reserve: 0, hold: 0 }, entries, disputed_held,
      unsettled: pays.filter(p => !p.settled && ['captured', 'partially_refunded', 'refunded', 'disputed'].includes(p.status)).map(p => ({ payment: p.id, captured_at: p.captured_at, amount: p.amount, net: p.pendingRemaining, description: p.description })),
      settlements: pays.filter(p => p.settled).slice(0, 200).map(p => ({ payment: p.id, settled_at: p.settled_at, net: p.net, reference: p.settlement_ref || null })) };
  });
  M('POST', '/settlements', 'finance', (ctx, c) => core.recordSettlement({ mode: c.mode, merchantId: c.m.id, before: ctx.body.before ? Date.parse(ctx.body.before) : null, reference: ctx.body.reference }, c.actor));
  M('GET', '/ledger', 'finance', (ctx, c) => ({ trial_balance: L.trialBalance(c.mode), checks: core.reconChecks(c.mode), journals: L.journalCount(c.mode) }));
  M('GET', '/activity', 'read', (ctx, c) => store.list('audit', { merchant_id: c.m.id }, { limit: 200 }));
  M('POST', '/sync', 'payments', async (ctx, c) => { await core.runCashAppSync(); core.runSettlement(c.mode); core.runExpiry(); core.runDeliveries(); return { ok: true }; });

  /* ---- payment links ---- */
  M('GET', '/links', 'read', (ctx, c) => store.list('links', { merchant_id: c.m.id, mode: c.mode }).map(l => ({ ...core.publicLink(l), status: core.linkActive(l) ? 'active' : (l.status === 'active' ? 'expired' : l.status), paid: l.payments.length })));
  M('POST', '/links', 'payments', (ctx, c) => core.publicLink(core.createLink(c.m, c.mode, ctx.body, c.actor)));
  M('POST', '/links/:id/status', 'payments', (ctx, c) => { const l = mine('links', ctx.params.id, c); l.status = ctx.body.active ? 'active' : 'deactivated'; store.put('links', l); core.audit(c.actor, 'payment_link.' + l.status, l.id, '', c.m.id); return core.publicLink(l); });

  /* ---- developers ---- */
  M('GET', '/keys', 'developers', (ctx, c) => { ensurePublishable(c.m, 'test', 'system'); return { keys: store.list('api_keys', { merchant_id: c.m.id, mode: c.mode }).map(publicKey), scopes: api.SCOPES, live_ready: core.liveReady(c.m) }; });
  M('POST', '/keys', 'developers', (ctx, c) => {
    if (c.mode === 'live') { const why = core.liveReady(c.m); if (why) throw bad(why, 'live_mode_unavailable'); if (!c.user.mfa_enabled) throw bad('Enable two-factor authentication before creating live keys.'); }
    let scopes = [].concat(ctx.body.scopes || ['*']).filter(s => s === '*' || api.SCOPES.includes(s)); if (!scopes.length) throw bad('Choose at least one permission.');
    const ips = String(ctx.body.allowed_ips || '').split(/[\s,]+/).filter(Boolean); if (ips.some(ip => !/^[\d.:a-fA-F]+$/.test(ip))) throw bad('Allowed IPs must be IP addresses.');
    ensurePublishable(c.m, c.mode, c.actor);
    const { key, secret } = issueKey(c.m, c.mode, { name: ctx.body.name, scopes, allowed_ips: ips }, c.actor);
    return { key: publicKey(key), secret };
  });
  M('POST', '/keys/:id/roll', 'developers', (ctx, c) => {
    const old = mine('api_keys', ctx.params.id, c); if (old.type !== 'secret' || old.status !== 'active') throw bad('Only active secret keys can be rolled.');
    old.status = 'expiring'; old.expires_at = Date.now() + DAY; store.put('api_keys', old);
    const { key, secret } = issueKey(c.m, c.mode, { name: old.name, scopes: old.scopes, allowed_ips: old.allowed_ips }, c.actor);
    core.audit(c.actor, 'api_key.roll', old.id, '', c.m.id); return { key: publicKey(key), secret };
  });
  M('POST', '/keys/:id/revoke', 'developers', (ctx, c) => { const k = mine('api_keys', ctx.params.id, c); k.status = 'revoked'; store.put('api_keys', k); core.audit(c.actor, 'api_key.revoke', k.id, '', c.m.id); return publicKey(k); });

  M('GET', '/webhooks', 'developers', (ctx, c) => ({ endpoints: store.list('webhook_endpoints', { merchant_id: c.m.id, mode: c.mode }).map(e => api.publicEndpoint(e)), event_types: api.EVENT_TYPES }));
  M('POST', '/webhooks', 'developers', async (ctx, c) => api.publicEndpoint(await api.createEndpoint(c.m, c.mode, ctx.body, c.actor), true));
  M('POST', '/webhooks/:id/status', 'developers', (ctx, c) => { const e = mine('webhook_endpoints', ctx.params.id, c); e.status = ctx.body.enabled ? 'enabled' : 'disabled'; store.put('webhook_endpoints', e); return api.publicEndpoint(e); });
  M('POST', '/webhooks/:id/secret', 'developers', (ctx, c) => { const e = mine('webhook_endpoints', ctx.params.id, c); core.audit(c.actor, 'webhook_endpoint.reveal_secret', e.id, '', c.m.id); return { secret: U.unseal(e.secret) }; });
  M('POST', '/webhooks/:id/rotate', 'developers', (ctx, c) => { const e = mine('webhook_endpoints', ctx.params.id, c); const s = 'whsec_' + U.rid(40, KEY_ALPHA); e.secret = U.seal(s); store.put('webhook_endpoints', e); core.audit(c.actor, 'webhook_endpoint.rotate', e.id, '', c.m.id); return { secret: s }; });
  M('POST', '/webhooks/:id/test', 'developers', (ctx, c) => { const e = mine('webhook_endpoints', ctx.params.id, c); const evt = store.put('events', { id: U.id('evt'), merchant_id: c.m.id, mode: c.mode, status: 'created', type: 'test.ping', livemode: c.mode === 'live', data: { object: { id: 'ping', message: 'Hello from Digital Hub' } } });
    store.put('deliveries', { id: U.id('whd'), merchant_id: c.m.id, mode: c.mode, status: 'pending', endpoint_id: e.id, url: e.url, event_id: evt.id, type: evt.type, attempts: 0, next_at: Date.now() }); core.runDeliveries(); return { ok: true }; });
  M('DELETE', '/webhooks/:id', 'developers', (ctx, c) => { const e = mine('webhook_endpoints', ctx.params.id, c); store.del('webhook_endpoints', e.id); core.audit(c.actor, 'webhook_endpoint.delete', e.id, '', c.m.id); return { ok: true }; });
  M('GET', '/deliveries', 'developers', (ctx, c) => store.list('deliveries', { merchant_id: c.m.id, mode: c.mode }, { limit: 100 }));
  M('POST', '/deliveries/:id/retry', 'developers', (ctx, c) => { const d = mine('deliveries', ctx.params.id, c); d.status = 'pending'; d.next_at = Date.now(); store.put('deliveries', d); core.runDeliveries(); return { ok: true }; });
  M('GET', '/events', 'developers', (ctx, c) => store.list('events', { merchant_id: c.m.id, mode: c.mode }, { limit: 100 }).map(core.publicEvent));

  /* ---- setup checklist ---- */
  M('GET', '/onboarding', 'read', (ctx, c) => ({ steps: onboarding(c.m), live_ready: core.liveReady(c.m), cashapp: { test: cashappStatus(c.m, 'test'), live: cashappStatus(c.m, 'live') } }));

  /* ---- Settings → Cash App Pay (credentials stay in server env and are never returned) ---- */
  M('GET', '/cashapp', 'read', (ctx, c) => ({
    details: c.m.cashapp.details, test: cashappStatus(c.m, 'test'), live: cashappStatus(c.m, 'live'), region: config.cashapp.region, live_payments: config.livePayments,
    environments: ['test', 'live'].map(environment),
    logs: store.list('api_logs', { mode: c.mode }, { limit: 100 }),
    events: store.list('provider_events', { mode: c.mode }, { limit: 100 }).filter(e => e.provider === 'cashapp'),
  }));
  M('POST', '/cashapp/details', 'settings', (ctx, c) => {
    c.m.cashapp.details = core.validateDetails(ctx.body); store.put('merchants', c.m);
    core.audit(c.actor, 'cashapp.details_update', c.m.id, '', c.m.id); return { details: c.m.cashapp.details };
  });
  M('POST', '/cashapp/register', 'settings', async (ctx, c) => {
    needMfaLive(c, 'registering with Cash App production');
    return cashappStatus(c.m, c.mode, await core.registerCashApp(c.m, c.mode, c.actor));
  });
  M('POST', '/cashapp/test-connection', 'settings', async (ctx, c) => {
    const started = Date.now();
    if (!CA.configured(c.mode) && !CA.simulated(c.mode)) throw bad('Cash App credentials for this environment are not set on the server.');
    try { await CA.client(c.mode).listMerchants({ op: 'test_connection' }); } catch (e) { core.audit(c.actor, 'cashapp.test_connection', c.mode, 'failed: ' + e.message, c.m.id); throw bad(`Cash App connection failed: ${e.message}`, e.code); }
    core.audit(c.actor, 'cashapp.test_connection', c.mode, 'ok', c.m.id); return { ok: true, environment: CA.environmentLabel(c.mode), ms: Date.now() - started };
  });
  /** Management API: register this server's webhook URL with Cash App; Cash App issues the signing secret for the env var. */
  M('POST', '/cashapp/webhook-endpoint', 'settings', async (ctx, c) => {
    needMfaLive(c, 'changing Cash App production webhooks');
    const cr = c.mode === 'live' ? config.cashapp.live : config.cashapp.sandbox;
    if (!CA.configured(c.mode)) throw bad('Set the Cash App credentials for this environment on the server first.');
    const url = `${config.publicUrl}/hooks/cashapp/${c.mode === 'live' ? 'production' : 'sandbox'}`;
    const types = ['customer_request.state.updated', 'payment.status.updated', 'refund.status.updated', 'dispute.created', 'dispute.state.updated', 'merchant.status.updated'];
    const ep = await CA.client(c.mode).createWebhookEndpoint({ idempotency_key: U.id('whe'), webhook_endpoint: { api_key_id: cr.keyId, url, event_configurations: types.map(event_type => ({ event_type, api_version: 'v1' })), reference_id: 'digitalhub' } }, { op: 'create_webhook_endpoint' }).catch(e => { throw bad(`Cash App: ${e.message}`, e.code); });
    core.audit(c.actor, 'cashapp.webhook_endpoint', c.mode, ep.id, c.m.id);
    return { endpoint: ep, note: `Copy the signing secret Cash App issued for this endpoint into ${c.mode === 'live' ? 'CASHAPP_WEBHOOK_SECRET' : 'CASHAPP_SANDBOX_WEBHOOK_SECRET'} on the server, then redeploy.` };
  });

  /* ---- settings & team ---- */
  M('PATCH', '/settings', 'settings', (ctx, c) => {
    const b = ctx.body, m = c.m;
    if (b.name !== undefined) m.name = U.str(b.name, 120) || m.name;
    if (b.support_email !== undefined) { if (b.support_email && !U.isEmail(b.support_email)) throw bad('Support email is invalid.'); m.support_email = b.support_email; }
    if (b.legal_name !== undefined) m.legal_name = U.str(b.legal_name, 160) || m.legal_name;
    if (b.website !== undefined) m.website = U.str(b.website, 200);
    if (b.captureMode) m.captureMode = b.captureMode === 'manual' ? 'manual' : 'auto';
    store.put('merchants', m); core.audit(c.actor, 'merchant.settings_update', m.id, Object.keys(b).join(','), m.id); return m;
  });
  M('GET', '/team', 'read', (ctx, c) => ({ users: store.list('users', { merchant_id: c.m.id }).map(auth.publicUser), roles: auth.MERCHANT_ROLES }));
  M('POST', '/team', 'team', (ctx, c) => {
    const role = String(ctx.body.role || ''); if (!auth.MERCHANT_ROLES[role] || role === 'owner') throw bad('Choose a role.');
    const temp = U.rid(6, 'abcdefghjkmnpqrstuvwxyz') + U.rid(6, '23456789') ;
    const u = auth.createUser({ email: ctx.body.email, name: ctx.body.name, password: temp, kind: 'merchant', role, merchant_id: c.m.id });
    core.audit(c.actor, 'team.invite', u.email, role, c.m.id);
    return { user: auth.publicUser(u), temporary_password: temp };
  });
  M('DELETE', '/team/:id', 'team', (ctx, c) => { const u = store.get('users', ctx.params.id); if (!u || u.merchant_id !== c.m.id || u.role === 'owner') throw bad('Cannot remove this user.'); u.status = 'disabled'; store.put('users', u); core.audit(c.actor, 'team.remove', u.email, '', c.m.id); return { ok: true }; });

  /* ---- sandbox helpers ---- */
  M('POST', '/test/sample-payments', 'payments', async (ctx, c) => { if (c.mode !== 'test') throw bad('Only in test mode.'); return { created: await require('../seed').samplePayments(c.m, 6) }; });
}

/** Which Cash App credentials are set on the server for one environment (never the secret values). */
function environment(mode) {
  const cr = mode === 'live' ? config.cashapp.live : config.cashapp.sandbox;
  return { mode, label: CA.environmentLabel(mode), configured: CA.configured(mode), simulated: CA.simulated(mode),
    client_id: cr.clientId || null, api_key_id: cr.keyId || null, signing_secret: !!cr.keySecret, webhook_secret: !!cr.webhookSecret, base: cr.base || (mode === 'live' ? 'https://api.cash.app' : 'https://sandbox.api.cash.app'),
    webhook_url: `${config.publicUrl}/hooks/cashapp/${mode === 'live' ? 'production' : 'sandbox'}`,
    env_names: mode === 'live' ? ['CASHAPP_CLIENT_ID', 'CASHAPP_API_KEY_ID', 'CASHAPP_API_KEY_SECRET', 'CASHAPP_WEBHOOK_SECRET'] : ['CASHAPP_SANDBOX_CLIENT_ID', 'CASHAPP_SANDBOX_API_KEY_ID', 'CASHAPP_SANDBOX_API_KEY_SECRET', 'CASHAPP_SANDBOX_WEBHOOK_SECRET'] };
}
/** Cash App registration state for one mode (no credentials). */
function cashappStatus(m, mode, reg = m.cashapp[mode]) {
  return { environment: CA.environmentLabel(mode), credentials: mode === 'test' ? (CA.simulated('test') ? 'simulator' : 'configured') : (CA.configured('live') ? 'configured' : 'missing'),
    brand_id: reg?.brand_id || null, merchant_id: reg?.merchant_id || null, status: reg?.status || 'NOT_REGISTERED', registered_at: reg?.registered_at || null, error: reg?.error || null, ready: core.cashappReady(m, mode) };
}

module.exports = { routes, issueKey, publicKey, ensurePublishable, onboarding, cashappStatus };
