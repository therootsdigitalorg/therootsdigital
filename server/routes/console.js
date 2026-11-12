'use strict';
/* DIGITAL HUB console API — /api/v1/admin (single-business platform).
   Staff sessions only, two-factor authentication mandatory, CSRF header on every write, per-user rate limit,
   permission check per action and an audit entry for every change. Sensitive changes (credentials, wallet approval,
   live switches, adopting a business record) also need a fresh 6-digit authenticator code. */
const config = require('../config');
const store = require('../db');
const L = require('../ledger');
const U = require('../util');
const core = require('../core');
const auth = require('../auth');
const anet = require('../authorizenet');
const cards = require('../cards');
const SET = require('../settlement');
const PROV = require('../settlement-providers');
const BIZ = require('../business');
const usdc = require('../usdc');
const C = require('../chain');
const { HttpError, bad, DAY, fmt } = U;

const WOO_SCOPES = ['checkout:write', 'checkout:read', 'payments:read', 'refunds:write', 'events:read'];
const rate = new Map();
function limit(user) { const t = Date.now(), r = rate.get(user.id) || { n: 0, t }; if (t - r.t > 60000) { r.n = 0; r.t = t; } if (++r.n > 120) throw new HttpError(429, 'rate_limited', 'Too many changes in a minute. Slow down.'); rate.set(user.id, r); }
/** Fresh TOTP for sensitive changes (when the user has 2FA; it is mandatory unless REQUIRE_STAFF_MFA=0 in tests). */
function needCode(user, code) {
  if (!user.mfa_enabled) { if (config.requireStaffMfa) throw new HttpError(403, 'mfa_enrollment_required', 'Enable two-factor authentication first.'); return; }
  if (!U.verifyTotp(U.unseal(user.mfa_secret), code)) throw new HttpError(401, 'invalid_code', 'Enter the current 6-digit code from your authenticator app.');
}
const page = (q, max = 200) => ({ limit: Math.min(max, Math.max(1, +q.limit || 50)), offset: Math.max(0, +q.offset || 0) });
const get = (t, id) => { const o = store.get(t, id); if (!o) throw new HttpError(404, 'not_found', 'Not found.'); return o; };
const cardPayment = id => { const p = get('payments', id); if (p.provider !== 'authorize_net') throw new HttpError(404, 'not_found', 'Card transaction not found.'); return p; };
const webhookUrl = () => `${config.publicUrl}/api/v1/webhooks/authorize-net`;

function routes(r) {
  r('GET', '/api/mode', () => ({ multi_merchant: config.multiMerchant, product: config.productName }));
  if (config.multiMerchant) return;

  const X = (method, path, perm, fn) => r(method, '/api/v1/admin' + path, async ctx => {
    const a = auth.requireUser(ctx, 'staff');
    if (config.requireStaffMfa && !a.user.mfa_enabled) throw new HttpError(403, 'mfa_enrollment_required', 'Two-factor authentication is mandatory. Set it up to continue.');
    if (perm) auth.needStaff(a.user, perm);
    if (method !== 'GET') limit(a.user);
    const mode = (ctx.query.mode || ctx.headers['x-dh-mode']) === 'live' ? 'live' : 'test';
    const m = BIZ.get(); if (!m) throw new HttpError(503, 'business_missing', 'Business record missing; restart the server.');
    return fn(ctx, { user: a.user, actor: a.user.email, mode, m });
  });
  const cardsOf = (c, f = {}) => store.list('payments', { merchant_id: c.m.id, mode: c.mode, ...f }, { limit: 20000 }).filter(p => p.provider === 'authorize_net');

  /* ---------------- Overview ---------------- */
  X('GET', '/overview', null, (ctx, c) => {
    const since = Date.now() - 30 * DAY, pays = cardsOf(c, { since });
    const cap = pays.filter(p => ['captured', 'partially_refunded', 'refunded', 'disputed'].includes(p.status));
    const series = []; const end = new Date(); end.setHours(23, 59, 59, 999);
    for (let i = 13; i >= 0; i--) { const e = end.getTime() - i * DAY, s = e - DAY; series.push({ label: new Date(e).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), amount: cap.filter(p => p.created_at > s && p.created_at <= e).reduce((t, p) => t + (p.captured || 0), 0) }); }
    const e = anet.envForMode(c.mode), cfg = anet.publicConfig().environments[e], rd = store.getMeta('readiness', {});
    return { mode: c.mode, business: { name: c.m.name, id: c.m.id },
      kpis: { captured: cap.reduce((t, p) => t + (p.captured || 0), 0), captured_count: cap.length, authorized: pays.filter(p => p.status === 'authorized').reduce((t, p) => t + p.amount, 0), authorized_count: pays.filter(p => p.status === 'authorized').length,
        declined: pays.filter(p => p.status === 'declined').length, refunded: pays.reduce((t, p) => t + (p.refunded || 0), 0), disputed: pays.filter(p => p.status === 'disputed').length, held: pays.filter(p => p.status === 'pending').length },
      series, settlement: SET.summary(c.mode),
      integrations: { authorize_net: { env: e, configured: cfg.configured, last_test: cfg.last_test, webhook: !!cfg.webhook, signature_key: cfg.signature_key }, infura: C.infuraStatus(), wallet: !!SET.businessWallet(c.mode), woocommerce: store.list('webhook_endpoints', { merchant_id: c.m.id, mode: c.mode }).filter(x => x.status === 'enabled').length },
      live: { payments: config.livePayments, cards: !!rd.cardsLive, payouts: !!rd.payoutsLive },
      alerts: store.list('alerts', { merchant_id: c.m.id, mode: c.mode, status: 'open' }, { limit: 10 }),
      recent: pays.slice(0, 8).map(cards.publicCard) };
  });

  /* ---------------- Card transactions ---------------- */
  X('GET', '/transactions', null, (ctx, c) => {
    const q = String(ctx.query.q || '').toLowerCase(), st = ctx.query.status, { limit: n, offset } = page(ctx.query);
    let rows = cardsOf(c, st ? { status: st } : {});
    if (q) rows = rows.filter(p => [p.id, p.anet?.invoice, p.anet?.transId, p.customer?.email, p.customer?.name, p.metadata?.order_id, p.card?.last4].some(v => String(v || '').toLowerCase().includes(q)));
    return { total: rows.length, data: rows.slice(offset, offset + n).map(cards.publicCard) };
  });
  X('GET', '/transactions/:id', null, (ctx, c) => {
    const p = cardPayment(ctx.params.id);
    return { ...cards.publicCard(p), ledger: L.entriesFor(p.id), refunds: store.list('refunds', { merchant_id: p.merchant_id, mode: p.mode }, { limit: 1000 }).filter(x => x.payment_id === p.id),
      disputes: store.list('disputes', { merchant_id: p.merchant_id, mode: p.mode }, { limit: 1000 }).filter(x => x.payment_id === p.id),
      provider_events: store.list('provider_events', {}, { limit: 3000 }).filter(e => e.payment_id === p.id).map(e => ({ id: e.id, type: e.type, status: e.status, at: e.created_at })) };
  });
  X('POST', '/transactions/:id/refresh', null, async ctx => cards.publicCard(await cards.reconcile(cardPayment(ctx.params.id), { force: true })));
  X('POST', '/transactions/:id/capture', 'payments.manage', async (ctx, c) => cards.publicCard(await cards.capture(cardPayment(ctx.params.id), ctx.body.amount == null || ctx.body.amount === '' ? null : Math.round(+ctx.body.amount * 100), c.actor)));
  X('POST', '/transactions/:id/void', 'payments.manage', async (ctx, c) => cards.publicCard(await cards.voidPayment(cardPayment(ctx.params.id), c.actor)));
  X('POST', '/transactions/:id/refund', 'payments.manage', async (ctx, c) => {
    const out = await cards.refund(cardPayment(ctx.params.id), ctx.body.amount == null || ctx.body.amount === '' ? null : Math.round(+ctx.body.amount * 100), { actor: c.actor, reason: ctx.body.reason });
    return { payment: cards.publicCard(out.payment), refund: out.refund, voided: out.voided };
  });
  X('POST', '/transactions/:id/dispute', 'payments.manage', (ctx, c) => cards.recordDispute(cardPayment(ctx.params.id), { amount: ctx.body.amount == null || ctx.body.amount === '' ? null : Math.round(+ctx.body.amount * 100), reason: ctx.body.reason, reference: ctx.body.reference }, c.actor));

  /* ---------------- Refunds & disputes ---------------- */
  X('GET', '/refunds', null, (ctx, c) => {
    const pays = Object.fromEntries(cardsOf(c).map(p => [p.id, p]));
    const refunds = store.list('refunds', { merchant_id: c.m.id, mode: c.mode }, { limit: 5000 }).filter(x => x.provider === 'authorize_net').map(x => ({ ...x, invoice: pays[x.payment_id]?.anet?.invoice, customer: pays[x.payment_id]?.customer?.email }));
    const disputes = store.list('disputes', { merchant_id: c.m.id, mode: c.mode }, { limit: 5000 }).filter(x => x.provider === 'authorize_net').map(x => ({ ...x, invoice: pays[x.payment_id]?.anet?.invoice, customer: pays[x.payment_id]?.customer?.email }));
    return { refunds, disputes };
  });
  X('POST', '/disputes/:id/resolve', 'payments.manage', (ctx, c) => cards.resolveDispute(get('disputes', ctx.params.id), !!ctx.body.won, c.actor, ctx.body.note));

  /* ---------------- Authorize.Net ---------------- */
  X('GET', '/authorize-net', null, () => ({ ...anet.publicConfig(), webhook_url: webhookUrl(), events: anet.WEBHOOK_EVENTS }));
  const envParam = ctx => { const e = ctx.params.env; if (!anet.ENVS.includes(e)) throw bad('Unknown environment.'); return e; };
  X('POST', '/authorize-net/:env', 'platform.settings', (ctx, c) => {
    const e = envParam(ctx);
    if (ctx.body.login_id || ctx.body.transaction_key || ctx.body.signature_key || e === 'production') needCode(c.user, ctx.body.code);
    anet.save(e, ctx.body, c.actor); return anet.publicConfig();
  });
  X('POST', '/authorize-net/:env/test', 'platform.settings', async (ctx, c) => anet.testConnection(envParam(ctx), c.actor));
  X('POST', '/authorize-net/:env/webhook', 'platform.settings', async (ctx, c) => anet.registerWebhook(envParam(ctx), webhookUrl(), c.actor));
  X('POST', '/authorize-net/:env/remove', 'platform.settings', (ctx, c) => { needCode(c.user, ctx.body.code); anet.clear(envParam(ctx), c.actor); return anet.publicConfig(); });

  /* ---------------- Customers ---------------- */
  X('GET', '/customers', null, (ctx, c) => {
    const q = String(ctx.query.q || '').toLowerCase();
    const rows = store.list('customers', { merchant_id: c.m.id, mode: c.mode }, { limit: 10000 }).filter(x => !q || `${x.email} ${x.name}`.toLowerCase().includes(q));
    return { total: rows.length, data: rows.slice(0, 500) };
  });
  X('GET', '/customers/:id', null, (ctx, c) => { const cu = get('customers', ctx.params.id); return { ...cu, payments: cardsOf(c).filter(p => p.customer_id === cu.id).map(cards.publicCard) }; });

  /* ---------------- Payment links ---------------- */
  X('GET', '/links', null, (ctx, c) => store.list('links', { merchant_id: c.m.id, mode: c.mode }, { limit: 1000 }).map(l => ({ ...core.publicLink(l), paid: (l.payments || []).length })));
  X('POST', '/links', 'payments.manage', (ctx, c) => core.publicLink(core.createLink(c.m, c.mode, { ...ctx.body, amount: Math.round(+ctx.body.amount * 100), currency: 'USD', payment_methods: ['card'] }, c.actor)));
  X('POST', '/links/:id/deactivate', 'payments.manage', (ctx, c) => { const l = get('links', ctx.params.id); if (l.merchant_id !== c.m.id) throw new HttpError(404, 'not_found', 'Not found.'); l.status = 'deactivated'; store.put('links', l); core.audit(c.actor, 'payment_link.deactivate', l.id, '', c.m.id); return core.publicLink(l); });

  /* ---------------- WooCommerce ---------------- */
  const M = require('./merchant'), API = require('./api');
  X('GET', '/woocommerce', null, (ctx, c) => {
    M.ensurePublishable(c.m, c.mode, 'system');
    const keys = store.list('api_keys', { merchant_id: c.m.id, mode: c.mode }, { limit: 200 }).map(M.publicKey);
    const eps = store.list('webhook_endpoints', { merchant_id: c.m.id, mode: c.mode }, { limit: 100 }).map(e => {
      const d = store.list('deliveries', { merchant_id: c.m.id, mode: c.mode }, { limit: 300 }).filter(x => x.endpoint_id === e.id);
      return { ...API.publicEndpoint(e), delivered: d.filter(x => x.status === 'delivered').length, failing: d.filter(x => ['retrying', 'failed'].includes(x.status)).length, last: d[0] ? { status: d[0].status, code: d[0].code, type: d[0].type, at: d[0].last_attempt || d[0].created_at } : null };
    });
    const orders = store.list('checkout_sessions', { merchant_id: c.m.id, mode: c.mode }, { limit: 2000 }).filter(s => s.metadata?.order_id).slice(0, 50).map(core.publicSession);
    return { keys, endpoints: eps, orders, plugin: { name: 'Digital Hub Payments', version: '3.0.0', download: '/downloads/digitalhub-woocommerce.zip', webhook_path: '/wc-api/digitalhub/' },
      api: { checkout: `${config.publicUrl}/api/v1/woocommerce/checkout`, status: `${config.publicUrl}/api/v1/woocommerce/payment-status`, base: config.publicUrl } };
  });
  X('POST', '/woocommerce/connect', 'platform.settings', async (ctx, c) => {
    let site; try { site = new URL(String(ctx.body.store_url || '').trim()); } catch { throw bad('Enter the store address, for example https://yourshop.com'); }
    if (site.protocol !== 'https:' && config.production) throw bad('The store must use HTTPS.');
    const hook = site.origin + site.pathname.replace(/\/+$/, '') + '/wc-api/digitalhub/';
    if (store.list('webhook_endpoints', { merchant_id: c.m.id, mode: c.mode }).some(e => e.url === hook && e.status === 'enabled')) throw bad('This store is already connected in this mode. Delete its webhook first to reconnect.', 'already_connected');
    const ep = await API.createEndpoint(c.m, c.mode, { url: hook, events: ['*'], description: 'WooCommerce ' + site.host }, c.actor);
    const { key, secret } = M.issueKey(c.m, c.mode, { name: 'WooCommerce ' + site.host, scopes: WOO_SCOPES }, c.actor);
    core.audit(c.actor, 'woocommerce.connect', c.m.id, site.host + ' ' + c.mode, c.m.id);
    return { store: site.host, mode: c.mode, plugin_settings: { digital_hub_url: config.publicUrl, test_mode: c.mode === 'test', secret_key: secret, webhook_secret: ep._secret }, webhook_url: hook, key_id: key.id, endpoint_id: ep.id };
  });
  X('POST', '/woocommerce/keys/:id/revoke', 'platform.settings', (ctx, c) => { const k = get('api_keys', ctx.params.id); if (k.merchant_id !== c.m.id) throw new HttpError(404, 'not_found', 'Not found.'); k.status = 'revoked'; store.put('api_keys', k); core.audit(c.actor, 'api_key.revoke', k.id, '', c.m.id); return M.publicKey(k); });
  X('POST', '/woocommerce/webhooks/:id/delete', 'platform.settings', (ctx, c) => { const e = get('webhook_endpoints', ctx.params.id); if (e.merchant_id !== c.m.id) throw new HttpError(404, 'not_found', 'Not found.'); store.del('webhook_endpoints', e.id); core.audit(c.actor, 'webhook_endpoint.delete', e.id, e.url, c.m.id); return { ok: true }; });

  /* ---------------- Settlements (USD) + conversions ---------------- */
  X('GET', '/settlements', null, (ctx, c) => ({ summary: SET.summary(c.mode), settlement_mode: PROV.settings(), providers: PROV.list(),
    settlements: store.list('usd_settlements', { merchant_id: c.m.id, mode: c.mode }, { limit: 1000 }),
    conversions: store.list('conversions', { merchant_id: c.m.id, mode: c.mode }, { limit: 1000 }),
    unsettled: cardsOf(c, { status: ['captured', 'partially_refunded'] }).filter(p => !p.settlement_id).map(cards.publicCard) }));
  X('POST', '/settlements/sync', 'payouts.execute', async (ctx, c) => SET.syncBatches(c.mode, c.actor, +ctx.body.days || 30));
  X('POST', '/settlements/:id/reconcile', 'payouts.execute', (ctx, c) => SET.reconcile(get('usd_settlements', ctx.params.id), ctx.body, c.actor));
  X('POST', '/conversions', 'payouts.approve', (ctx, c) => SET.createConversion(c.mode, ctx.body, c.actor));
  X('POST', '/conversions/:id/:action', 'payouts.execute', (ctx, c) => SET.updateConversion(get('conversions', ctx.params.id), ctx.params.action, ctx.body, c.actor));
  X('POST', '/settlement-mode', 'platform.settings', (ctx, c) => { needCode(c.user, ctx.body.code); return PROV.setMode(String(ctx.body.mode), String(ctx.body.provider || ''), c.actor); });
  X('POST', '/settlement-providers/:key/approval', 'platform.settings', (ctx, c) => PROV.recordApproval(ctx.params.key, ctx.body, c.actor));

  /* ---------------- Crypto wallet (business MetaMask) ---------------- */
  X('GET', '/wallet', null, (ctx, c) => {
    const ws = store.list('merchant_wallets', { merchant_id: c.m.id }, { limit: 50 }).filter(w => !['disabled', 'rejected'].includes(w.status));
    return { wallets: ws.map(w => ({ ...usdc.publicWallet(w), receiving_test: c.m.receiving?.test === w.id, receiving_live: c.m.receiving?.live === w.id })), chain: C.walletParams(C.networkFor(c.mode)),
      balances: SET.summary(c.mode), note: 'Digital Hub never asks for or stores private keys or seed phrases, and never signs or sends transactions for you.' };
  });
  X('POST', '/wallet', 'destinations.review', (ctx, c) => usdc.publicWallet(usdc.addWallet(c.m, ctx.body, c.actor)));
  X('POST', '/wallet/:id/challenge', 'destinations.review', (ctx, c) => usdc.walletChallenge(c.m, get('merchant_wallets', ctx.params.id), c.mode, c.actor));
  X('POST', '/wallet/:id/verify', 'destinations.review', (ctx, c) => usdc.publicWallet(usdc.verifyWalletSignature(c.m, get('merchant_wallets', ctx.params.id), String(ctx.body.signature || ''), { actor: c.actor, ip: ctx.ip })));
  /** Approval for Base Mainnet: type the last 6 characters of the address + a fresh 2FA code. */
  X('POST', '/wallet/:id/approve', 'destinations.review', (ctx, c) => {
    const w = get('merchant_wallets', ctx.params.id); if (w.merchant_id !== c.m.id) throw new HttpError(404, 'not_found', 'Not found.');
    if (String(ctx.body.confirm || '').trim().toLowerCase() !== w.address.slice(-6).toLowerCase()) throw bad('Type the last 6 characters of the wallet address to confirm.', 'confirm_mismatch');
    needCode(c.user, ctx.body.code);
    return usdc.publicWallet(usdc.reviewWallet(w, true, 'Business wallet approved by Super Admin', c.actor));
  });
  X('POST', '/wallet/:id/receiving', 'destinations.review', (ctx, c) => { usdc.setReceiving(c.m, get('merchant_wallets', ctx.params.id), ctx.body.mode === 'live' ? 'live' : 'test', c.actor); return { ok: true }; });
  X('POST', '/wallet/:id/remove', 'destinations.review', (ctx, c) => usdc.publicWallet(usdc.removeWallet(c.m, get('merchant_wallets', ctx.params.id), c.actor)));

  /* ---------------- USDC transfers (payouts to the business wallet) ---------------- */
  const pubPayout = p => ({ ...p, explorer: p.tx?.hash ? C.explorerTx(p.network, p.tx.hash) : null, network_name: C.NETWORKS[p.network]?.name });
  X('GET', '/payouts', null, (ctx, c) => ({ payouts: store.list('crypto_payouts', { merchant_id: c.m.id, mode: c.mode }, { limit: 1000 }).map(pubPayout),
    ready: store.list('conversions', { merchant_id: c.m.id, mode: c.mode, status: 'completed' }, { limit: 500 }), wallet: SET.businessWallet(c.mode) ? usdc.publicWallet(SET.businessWallet(c.mode)) : null }));
  X('POST', '/payouts', 'payouts.approve', (ctx, c) => pubPayout(SET.createPayout(get('conversions', String(ctx.body.conversion_id || '')), ctx.body, c.actor)));
  X('POST', '/payouts/:id/tx', 'payouts.execute', async (ctx, c) => pubPayout(await SET.submitPayoutTx(get('crypto_payouts', ctx.params.id), String(ctx.body.hash || '').trim(), c.actor)));
  X('POST', '/payouts/:id/check', 'payouts.execute', async (ctx, c) => pubPayout(await SET.refreshPayout(get('crypto_payouts', ctx.params.id), c.actor)));
  X('POST', '/payouts/:id/fail', 'payouts.execute', (ctx, c) => pubPayout(SET.failPayout(get('crypto_payouts', ctx.params.id), ctx.body.reason, c.actor)));

  /* ---------------- Webhook logs ---------------- */
  X('GET', '/webhook-logs', null, (ctx, c) => ({
    inbound: store.list('provider_events', {}, { limit: 300 }).filter(e => ['authorize_net', 'settlement_provider'].includes(e.provider)).map(e => ({ id: e.id, at: e.created_at, provider: e.provider, env: e.env || null, type: e.type, status: e.status, signature: e.sig, trans_id: e.trans_id || null, invoice: e.invoice || null, payment: e.payment_id || null, error: e.error || null })),
    outbound: store.list('deliveries', { merchant_id: c.m.id, mode: c.mode }, { limit: 300 }).map(d => ({ id: d.id, at: d.created_at, url: d.url, type: d.type, status: d.status, attempts: d.attempts, code: d.code, error: d.error })) }));
  X('POST', '/webhook-logs/:id/retry', 'platform.settings', (ctx, c) => { const d = get('deliveries', ctx.params.id); if (d.merchant_id !== c.m.id) throw new HttpError(404, 'not_found', 'Not found.'); Object.assign(d, { status: 'pending', next_at: Date.now() }); store.put('deliveries', d); core.audit(c.actor, 'delivery.retry', d.id, '', c.m.id); return { ok: true }; });

  /* ---------------- Reports ---------------- */
  const range = q => { const to = q.to ? Date.parse(q.to) + DAY : Date.now(), from = q.from ? Date.parse(q.from) : to - 30 * DAY; if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw bad('Invalid date range.'); return { from, to }; };
  X('GET', '/reports', null, (ctx, c) => {
    const { from, to } = range(ctx.query), rows = cardsOf(c).filter(p => p.created_at >= from && p.created_at < to);
    const by = {}; for (const p of rows) by[p.status] = (by[p.status] || 0) + 1;
    const days = {}; for (const p of rows) { const d = new Date(p.created_at).toISOString().slice(0, 10); days[d] ??= { date: d, count: 0, captured: 0, refunded: 0, declined: 0 }; days[d].count++; days[d].captured += p.captured || 0; days[d].refunded += p.refunded || 0; if (p.status === 'declined') days[d].declined++; }
    const cap = rows.reduce((t, p) => t + (p.captured || 0), 0), ref = rows.reduce((t, p) => t + (p.refunded || 0), 0), att = rows.filter(p => p.status !== 'created').length;
    return { from, to, totals: { transactions: rows.length, captured: cap, refunded: ref, net: cap - ref, approval_rate: att ? +(rows.filter(p => !['declined', 'created', 'pending'].includes(p.status)).length / att * 100).toFixed(1) : null },
      by_status: by, daily: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)),
      settlements: store.list('usd_settlements', { merchant_id: c.m.id, mode: c.mode, since: from, until: to }, { limit: 1000 }).map(s => ({ batch: s.batch_id, net: s.net, status: s.status, conversion: s.conversion_status, payout: s.payout_status })),
      ledger: L.accountTotals(c.mode).filter(x => true), trial_balance: L.trialBalance(c.mode) };
  });
  X('GET', '/reports/transactions.csv', null, (ctx, c) => {
    const { from, to } = range(ctx.query), esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['created', 'id', 'invoice', 'trans_id', 'customer', 'email', 'amount', 'captured', 'refunded', 'card_status', 'usd_settlement', 'conversion', 'usdc_payout', 'card', 'order_id'];
    const lines = cardsOf(c).filter(p => p.created_at >= from && p.created_at < to).map(cards.publicCard).map(p => [new Date(p.created).toISOString(), p.id, p.invoice, p.trans_id, p.customer.name, p.customer.email, (p.amount / 100).toFixed(2), (p.captured / 100).toFixed(2), (p.refunded / 100).toFixed(2), p.statuses.card, p.statuses.usd_settlement, p.statuses.conversion, p.statuses.usdc_payout, p.card ? `${p.card.brand} ${p.card.last4}` : '', p.order_id].map(esc).join(','));
    core.audit(c.actor, 'report.export', 'transactions.csv', `${lines.length} rows`, c.m.id);
    return { buffer: Buffer.from([head.join(','), ...lines].join('\n')), type: 'text/csv; charset=utf-8', name: `digitalhub-transactions-${c.mode}.csv`, private: true };
  });

  /* ---------------- Security & audit ---------------- */
  X('GET', '/security', null, ctx => {
    const q = String(ctx.query.q || '').toLowerCase();
    const audit = store.list('audit', {}, { limit: 1000 }).filter(a => !q || `${a.actor} ${a.action} ${a.target} ${a.detail}`.toLowerCase().includes(q)).slice(0, 300);
    const staff = store.list('users', {}, { limit: 1000 }).filter(u => u.kind === 'staff').map(auth.publicUser);
    return { audit, staff, policy: { mfa: config.requireStaffMfa ? 'mandatory' : 'optional (REQUIRE_STAFF_MFA=0)', session_hours: 12, login_lockout: '5 failures → 15 minutes', csrf: 'X-Requested-With header + SameSite=Lax HttpOnly cookie', secrets: 'AES-256-GCM sealed with APP_ENCRYPTION_KEY; never returned to the browser' },
      rejected_webhooks: store.list('provider_events', { status: 'rejected' }, { limit: 50 }).length };
  });

  /* ---------------- Settings ---------------- */
  X('GET', '/settings', null, (ctx, c) => {
    const bizId = c.m.id, retired = store.list('merchants', {}, { limit: 10000 }).filter(x => x.id !== bizId);
    const candidates = retired.map(x => ({ id: x.id, name: x.name, status: x.status, keys: store.list('api_keys', { merchant_id: x.id }, { limit: 50 }).filter(k => k.type === 'secret' && k.status === 'active').length, webhooks: store.list('webhook_endpoints', { merchant_id: x.id }, { limit: 50 }).length })).filter(x => x.keys || x.webhooks);
    return { business: { id: c.m.id, name: c.m.name, legal_name: c.m.legal_name, support_email: c.m.support_email, website: c.m.website, descriptor: c.m.descriptor || '', country: c.m.country },
      platform: { product: config.productName, multi_merchant: false, require_staff_mfa: config.requireStaffMfa, live_payments: config.livePayments, public_url: config.publicUrl, anet_flow: anet.flow() },
      backup: store.getMeta('last_backup', null), migration: store.getMeta('migration:single_business', null), adopt_candidates: candidates, retired_merchants: retired.length };
  });
  X('PATCH', '/settings/business', 'platform.settings', (ctx, c) => BIZ.updateProfile(ctx.body, c.actor));
  X('POST', '/settings/flow', 'platform.settings', (ctx, c) => { anet.save('sandbox', { flow: ctx.body.flow }, c.actor); return { flow: anet.flow() }; });
  X('POST', '/settings/adopt', 'platform.settings', (ctx, c) => { needCode(c.user, ctx.body.code); const m = BIZ.adopt(String(ctx.body.merchant_id || ''), c.actor); return { id: m.id, name: m.name }; });
  X('GET', '/backup', 'platform.settings', (ctx, c) => { const b = require('../backup').exportAll(c.actor); return { buffer: b.buffer, type: 'application/gzip', name: b.name, private: true }; });

  /* ---------------- Production readiness ---------------- */
  async function readiness() {
    const checks = [], add = (key, group, label, ok, detail, required = true) => checks.push({ key, group, label, ok: !!ok, required, detail });
    const prod = anet.publicConfig().environments.production, sb = anet.publicConfig().environments.sandbox, m = BIZ.get();
    const staff = store.list('users', {}, { limit: 1000 }).filter(u => u.kind === 'staff' && u.status === 'active');
    const bk = store.getMeta('last_backup', null);
    add('live_flag', 'Platform', 'LIVE_PAYMENTS=1 in the server environment', config.livePayments, 'Hard kill switch for real money.');
    add('production', 'Platform', 'NODE_ENV=production', config.production, 'Secure cookies, strict defaults.');
    add('https', 'Platform', 'PUBLIC_URL uses HTTPS', config.publicUrl.startsWith('https://'), config.publicUrl);
    add('enc_key', 'Platform', 'APP_ENCRYPTION_KEY set (64 hex)', /^[0-9a-f]{64}$/i.test(process.env.APP_ENCRYPTION_KEY || ''), 'Encrypts API keys, webhook secrets and 2FA seeds.');
    add('cron', 'Platform', 'CRON_SECRET set', !!config.cronSecret, 'Protects the scheduled jobs endpoint.');
    add('mfa', 'Security', 'Two-factor authentication on for every staff account', staff.every(u => u.mfa_enabled), `${staff.filter(u => u.mfa_enabled).length}/${staff.length} enrolled`);
    add('backup', 'Security', 'Backup taken in the last 7 days', bk && Date.now() - bk.at < 7 * DAY, bk ? `Last: ${new Date(bk.at).toISOString()}` : 'Settings → Download backup, or npm run backup');
    add('sandbox_ok', 'Authorize.Net', 'Sandbox credentials tested', sb.last_test?.ok, sb.last_test ? `${sb.last_test.code} ${sb.last_test.text || ''}` : 'Authorize.Net → Sandbox → Test connection');
    add('sandbox_flow', 'Authorize.Net', 'A sandbox card payment was captured and verified end to end', store.list('payments', { mode: 'test', status: ['captured', 'partially_refunded', 'refunded'] }, { limit: 2000 }).some(p => p.provider === 'authorize_net' && p.anet?.transId), 'Pay a payment link with an Authorize.Net sandbox test card.');
    add('prod_creds', 'Authorize.Net', 'Production credentials configured', prod.configured, prod.source || 'not configured');
    add('prod_test', 'Authorize.Net', 'Production credentials tested', prod.last_test?.ok, prod.last_test ? `${prod.last_test.code} ${prod.last_test.text || ''}` : 'not tested');
    add('prod_sig', 'Authorize.Net', 'Production Signature Key configured', prod.signature_key, 'Needed to verify webhooks.');
    add('prod_hook', 'Authorize.Net', 'Production webhook registered', !!prod.webhook, prod.webhook?.url || webhookUrl());
    add('infura', 'Blockchain', 'Infura API key configured', C.infuraStatus().configured, 'Used to verify USDC payouts on Base.', false);
    add('base_live', 'Blockchain', 'Base Mainnet enabled (Infura & Blockchain)', C.settings().platformMode === 'live' && C.net('base').enabled, 'Needed only for live USDC payouts.', false);
    add('wallet_live', 'Blockchain', 'Business wallet approved for Base Mainnet', m && !!usdc.receivingWallet(m, 'live'), 'Crypto Wallet → verify with MetaMask → approve.', false);
    const required = checks.filter(x => x.required), payoutKeys = ['infura', 'base_live', 'wallet_live'];
    return { checks, ready_cards: required.every(x => x.ok), ready_payouts: required.every(x => x.ok) && checks.filter(x => payoutKeys.includes(x.key)).every(x => x.ok), state: store.getMeta('readiness', {}) };
  }
  X('GET', '/readiness', null, () => readiness());
  X('POST', '/readiness', 'platform.settings', async (ctx, c) => {
    needCode(c.user, ctx.body.code);
    const r = await readiness(), s = store.getMeta('readiness', {});
    if (ctx.body.cards_live !== undefined) { if (ctx.body.cards_live && !r.ready_cards) throw bad('Every required check must pass before live card payments can be enabled.', 'not_ready'); s.cardsLive = !!ctx.body.cards_live; }
    if (ctx.body.payouts_live !== undefined) { if (ctx.body.payouts_live && !r.ready_payouts) throw bad('Every required and blockchain check must pass before live USDC payouts can be enabled.', 'not_ready'); s.payoutsLive = !!ctx.body.payouts_live; }
    s.at = Date.now(); s.by = c.actor; store.setMeta('readiness', s);
    core.audit(c.actor, 'readiness.update', 'platform', `cards_live=${!!s.cardsLive} payouts_live=${!!s.payoutsLive}`);
    return readiness();
  });
}

module.exports = { routes };
