'use strict';
/* Merchant dashboard API — /m-api. Session-authenticated; every query is scoped to the
   signed-in user's merchant and the selected mode (X-DH-Mode: test | live). */
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

function onboarding(m) {
  const any = (t, f) => store.list(t, { merchant_id: m.id, ...f }, { limit: 1 }).length > 0;
  const owner = store.list('users', { merchant_id: m.id }).find(u => u.role === 'owner');
  return [
    { key: 'kyb_submitted', label: 'Submit business details (KYB)', done: m.kyb.submitted, detail: 'Legal entity, registration, website, owners.' },
    { key: 'kyb_approved', label: 'Business verified by Digital Hub', done: m.status === 'approved', detail: `Status: ${m.status}` },
    { key: 'mfa', label: 'Two-factor authentication on the owner account', done: !!owner?.mfa_enabled, detail: 'Required for payouts and live keys.' },
    { key: 'api_key', label: 'Create a test API key', done: store.list('api_keys', { merchant_id: m.id, mode: 'test' }).some(k => k.type === 'secret'), detail: 'Developers → API keys.' },
    { key: 'webhook', label: 'Add a webhook endpoint', done: any('webhook_endpoints', {}), detail: 'Signed events to your server or plugin.' },
    { key: 'test_payment', label: 'Complete a test payment', done: store.list('payments', { merchant_id: m.id, mode: 'test', status: core.PAID }, { limit: 1 }).length > 0, detail: 'Use a payment link or the API in test mode.' },
    { key: 'cashapp_test', label: 'Registered with Cash App Pay sandbox', done: core.cashappReady(m, 'test'), detail: CA.simulated('test') ? 'Local simulator registers automatically on your first test checkout.' : 'Settings → Cash App Pay.' },
    { key: 'cashapp_live', label: 'Registered with Cash App Pay production', done: core.cashappReady(m, 'live'), detail: 'Done by Digital Hub after business verification and Cash App approval.' },
    { key: 'destination', label: 'Verified payout bank account', done: any('banks', { status: 'verified' }), detail: 'Bank account approved by Digital Hub.' },
    { key: 'live', label: 'Live mode activated', done: !core.liveReady(m), detail: core.liveReady(m) || 'Live payments enabled.' },
  ];
}

function routes(r) {
  const M = (method, path, perm, fn) => r(method, '/m-api' + path, async ctx => {
    const a = auth.requireUser(ctx, 'merchant'); auth.needMerchant(a.user, perm);
    const m = core.normalizeMerchant(store.get('merchants', a.user.merchant_id)); if (!m) throw new HttpError(404, 'not_found', 'Merchant missing');
    const mode = ctx.headers['x-dh-mode'] === 'live' ? 'live' : 'test';
    return fn(ctx, { user: a.user, m, mode, actor: a.user.email });
  });
  const mine = (table, idv, c, modeScoped = true) => { const o = store.get(table, idv); if (!o || o.merchant_id !== c.m.id || (modeScoped && o.mode !== c.mode)) throw new HttpError(404, 'not_found', 'Not found'); return o; };

  M('GET', '/overview', 'read', (ctx, c) => {
    const pays = store.list('payments', { merchant_id: c.m.id, mode: c.mode, since: Date.now() - 30 * DAY }, { limit: 5000 });
    const ok = pays.filter(p => core.PAID.includes(p.status)), tried = pays.filter(p => !['created', 'awaiting_customer', 'processing'].includes(p.status));
    const usd = p => U.toUSD(p.amount, p.currency);
    const series = []; const end = new Date(); end.setHours(23, 59, 59, 999);
    for (let i = 13; i >= 0; i--) { const e = end.getTime() - i * DAY, s = e - DAY; const day = ok.filter(p => p.created_at > s && p.created_at <= e); series.push({ label: new Date(e).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), card: day.reduce((t, p) => t + usd(p), 0), crypto: 0 }); }
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
  M('GET', '/wallet', 'read', (ctx, c) => {
    const entries = L.recent(c.mode, 200, c.m.id).filter(e => L.MERCHANT_ACCTS.includes(e.account));
    return { balances: L.merchantBalances(c.m.id, c.mode), entries, settlements: store.list('payments', { merchant_id: c.m.id, mode: c.mode, status: ['settled', 'partially_refunded', 'refunded'] }, { limit: 200 }).filter(p => p.settled).map(p => ({ payment: p.id, settled_at: p.settled_at, net: p.net, reserve: p.reserve, reference: p.settlement_ref || null })) };
  });

  /* ---- payment links ---- */
  M('GET', '/links', 'read', (ctx, c) => store.list('links', { merchant_id: c.m.id, mode: c.mode }).map(l => ({ ...core.publicLink(l), status: core.linkActive(l) ? 'active' : (l.status === 'active' ? 'expired' : l.status), paid: l.payments.length })));
  M('POST', '/links', 'payments', (ctx, c) => core.publicLink(core.createLink(c.m, c.mode, ctx.body, c.actor)));
  M('POST', '/links/:id/status', 'payments', (ctx, c) => { const l = mine('links', ctx.params.id, c); l.status = ctx.body.active ? 'active' : 'deactivated'; store.put('links', l); core.audit(c.actor, 'payment_link.' + l.status, l.id, '', c.m.id); return core.publicLink(l); });

  /* ---- balances & payouts ---- */
  M('GET', '/balances', 'read', (ctx, c) => ({ balances: L.merchantBalances(c.m.id, c.mode), payouts: store.list('payouts', { merchant_id: c.m.id, mode: c.mode }, { limit: 100 }).map(po => ({ ...core.publicPayout(po), events: po.events, reasons: po.reasons })), hold: c.m.settlementHold, min_payout: c.m.minPayout }));
  M('POST', '/payouts/quote', 'payouts', (ctx, c) => { const q = core.payoutQuote(c.m, c.mode, String(ctx.body.currency || '').toUpperCase(), Number(ctx.body.amount), ctx.body.destination); return { ...q, dest: undefined, available: L.balance(c.m.id, c.mode, L.ACCT.M_AVAIL, q.sourceCur) }; });
  M('POST', '/payouts', 'payouts', async (ctx, c) => {
    if (c.mode === 'live' && !c.user.mfa_enabled) throw new HttpError(403, 'mfa_required', 'Enable two-factor authentication before requesting live payouts.');
    const b = ctx.body;
    const out = await core.idempotent(c.m.id, c.mode, b.idempotency_key, U.sha256(JSON.stringify([b.currency, b.amount, b.destination])), () => ({ status: 200, body: core.publicPayout(core.requestPayout(c.m, c.mode, { currency: b.currency, amount: Number(b.amount), destination: b.destination }, c.actor)) }));
    return { ...out.body, replayed: !!out.replay };
  });

  /* ---- payout destinations (shared by test and live) ---- */
  M('GET', '/destinations', 'read', (ctx, c) => ({ wallets: [], banks: store.list('banks', { merchant_id: c.m.id }).map(b => ({ ...b, account: undefined })) }));
  M('POST', '/banks', 'payouts', (ctx, c) => {
    const currency = String(ctx.body.currency || '').toUpperCase(), acct = String(ctx.body.account || '').replace(/\s/g, '').toUpperCase(), holder = U.str(ctx.body.holder, 120);
    if (!U.FIAT.includes(currency)) throw bad('Choose a currency.');
    if (currency === 'PKR' ? !/^PK\d{2}[A-Z]{4}\d{16}$/.test(acct) : !/^[A-Z0-9]{6,34}$/.test(acct)) throw bad(currency === 'PKR' ? 'Enter a valid Pakistani IBAN (PK + 22 characters).' : 'Enter a valid IBAN or account number.');
    if (holder.toLowerCase() !== String(c.m.legal_name).toLowerCase()) throw bad('Account holder must match your legal business name.');
    const b = store.put('banks', { id: U.id('bnk'), merchant_id: c.m.id, status: 'pending_review', currency, bank_name: U.str(ctx.body.bank_name, 100), holder, last4: acct.slice(-4), account: U.seal(acct), routing: U.str(ctx.body.routing, 40), rail: '' });
    core.audit(c.actor, 'bank.add', b.id, currency, c.m.id); return { ...b, account: undefined };
  });
  M('DELETE', '/destinations/:id', 'payouts', (ctx, c) => { const t = 'banks'; const d = mine(t, ctx.params.id, c, false); store.del(t, d.id); core.audit(c.actor, t + '.remove', d.id, '', c.m.id); return { ok: true }; });

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

  /* ---- go live ---- */
  M('GET', '/onboarding', 'read', (ctx, c) => ({ steps: onboarding(c.m), kyb: c.m.kyb, status: c.m.status, live_ready: core.liveReady(c.m), cashapp: { test: cashappStatus(c.m, 'test'), live: cashappStatus(c.m, 'live') } }));
  M('POST', '/kyb', 'settings', (ctx, c) => {
    const b = ctx.body, biz = { legal_name: U.str(b.legal_name, 160), registration_number: U.str(b.registration_number, 60), incorporation_country: U.str(b.country, 2).toUpperCase(), address: U.str(b.address, 300),
      website: U.str(b.website, 200), description: U.str(b.description, 600), monthly_volume_usd: Math.max(0, +b.monthly_volume_usd || 0) };
    if (biz.legal_name.length < 2 || !biz.registration_number || !biz.address || !biz.description) throw bad('Fill in legal name, registration number, address and business description.');
    const owners = [].concat(b.owners || []).slice(0, 6).map(o => ({ name: U.str(o.name, 120), pct: Math.min(100, Math.max(0, +o.pct || 0)), dob: U.str(o.dob, 10), nationality: U.str(o.nationality, 2).toUpperCase(), idStatus: 'pending' })).filter(o => o.name);
    if (!owners.length) throw bad('Add every owner with 25% or more (at least one).');
    if (owners.reduce((s, o) => s + o.pct, 0) > 100) throw bad('Ownership cannot exceed 100%.');
    if (c.m.status === 'approved') throw bad('Your business is already verified. Contact support to change details.');
    c.m.kyb = { ...c.m.kyb, submitted: true, submitted_at: Date.now(), business: biz, owners };
    c.m.legal_name = biz.legal_name; if (biz.website) c.m.website = biz.website; if (c.m.status === 'rejected') c.m.status = 'pending';
    store.put('merchants', c.m); core.audit(c.actor, 'kyb.submit', c.m.id, '', c.m.id);
    return { ok: true };
  });
  /* ---- Settings → Cash App Pay ---- */
  M('GET', '/cashapp', 'read', (ctx, c) => ({ details: c.m.cashapp.details, test: cashappStatus(c.m, 'test'), live: cashappStatus(c.m, 'live'),
    logs: store.list('api_logs', { merchant_id: c.m.id, mode: c.mode }, { limit: 50 }) }));
  M('POST', '/cashapp/details', 'settings', (ctx, c) => {
    if (core.cashappReady(c.m, 'live')) throw bad('Your business is registered with Cash App production. Contact Digital Hub to change these details.');
    c.m.cashapp.details = core.validateDetails(ctx.body); store.put('merchants', c.m);
    core.audit(c.actor, 'cashapp.details_update', c.m.id, '', c.m.id); return { details: c.m.cashapp.details };
  });
  M('POST', '/cashapp/register', 'settings', async (ctx, c) => {
    if (c.mode !== 'test') throw bad('Production registration is done by Digital Hub after your business is verified.');
    return cashappStatus(c.m, 'test', await core.registerCashApp(c.m, 'test', c.actor));
  });

  /* ---- settings & team ---- */
  M('PATCH', '/settings', 'settings', (ctx, c) => {
    const b = ctx.body, m = c.m;
    if (b.name !== undefined) m.name = U.str(b.name, 120) || m.name;
    if (b.support_email !== undefined) { if (b.support_email && !U.isEmail(b.support_email)) throw bad('Support email is invalid.'); m.support_email = b.support_email; }
    if (b.website !== undefined) m.website = U.str(b.website, 200);
    if (b.captureMode) m.captureMode = b.captureMode === 'manual' ? 'manual' : 'auto';
    if (b.minPayout !== undefined) { const v = Math.round(+b.minPayout); if (!(v > 0)) throw bad('Minimum payout must be positive.'); m.minPayout = v; }
    if (b.dualControl !== undefined) m.dualControl = !!b.dualControl;
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

/** Cash App registration state for one mode, safe to show the merchant (no credentials). */
function cashappStatus(m, mode, reg = m.cashapp[mode]) {
  return { environment: CA.environmentLabel(mode), credentials: mode === 'test' ? (CA.simulated('test') ? 'simulator' : 'configured') : (CA.configured('live') ? 'configured' : 'missing'),
    brand_id: reg?.brand_id || null, merchant_id: reg?.merchant_id || null, status: reg?.status || 'NOT_REGISTERED', registered_at: reg?.registered_at || null, error: reg?.error || null, ready: core.cashappReady(m, mode) };
}

module.exports = { routes, issueKey, publicKey, ensurePublishable, onboarding, cashappStatus };
