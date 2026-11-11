'use strict';
/* Super Admin API — /a-api. Staff sessions only; every mutation checks a staff permission
   (and 2FA when REQUIRE_STAFF_MFA / production) and is written to the audit log. */
const config = require('../config');
const store = require('../db');
const L = require('../ledger');
const U = require('../util');
const core = require('../core');
const P = require('../providers');
const auth = require('../auth');
const usdc = require('../usdc');
const C = require('../chain');
const E = require('../evm');
const { HttpError, bad, DAY } = U;

const usdOf = p => U.toUSD(p.method === 'card' ? p.amount : (p.creditedAmount ?? 0), p.method === 'card' ? p.currency : p.crypto.asset);
const names = () => Object.fromEntries(store.list('merchants', {}, { limit: 10000 }).map(m => [m.id, m.name]));
const merchantSummary = (m, mode) => {
  const pays = store.list('payments', { merchant_id: m.id, mode, status: core.PAID, since: Date.now() - 30 * DAY }, { limit: 5000 });
  return { id: m.id, name: m.name, legal_name: m.legal_name, country: m.country, status: m.status, risk: m.risk, live_enabled: m.live_enabled, created_at: m.created_at, kyb_submitted: m.kyb.submitted,
    crypto_provider: m.cryptoProvider, providers: m.providers, hold: !!m.settlementHold, volume_30d_usd: pays.reduce((s, p) => s + usdOf(p), 0), payments_30d: pays.length };
};

function routes(r) {
  const A = (method, path, perm, fn) => r(method, '/a-api' + path, async ctx => {
    const a = auth.requireUser(ctx, 'staff'); if (perm) auth.needStaff(a.user, perm);
    const mode = (ctx.query.mode || ctx.headers['x-dh-mode']) === 'live' ? 'live' : 'test';
    return fn(ctx, { user: a.user, mode, actor: a.user.email });
  });
  const get = (t, idv) => { const o = store.get(t, idv); if (!o) throw new HttpError(404, 'not_found', 'Not found'); return o; };
  const saveM = (m, c, action, detail = '') => { store.put('merchants', m); core.audit(c.actor, action, m.id, detail, m.id); return m; };

  A('GET', '/overview', null, (ctx, c) => {
    const since = Date.now() - 30 * DAY, pays = store.list('payments', { mode: c.mode, since }, { limit: 20000 }), ok = pays.filter(p => core.PAID.includes(p.status));
    const rev = L.sumAccount(c.mode, L.ACCT.P_REV);
    const series = []; const end = new Date(); end.setHours(23, 59, 59, 999);
    for (let i = 13; i >= 0; i--) { const e = end.getTime() - i * DAY, s = e - DAY; const d = ok.filter(p => p.created_at > s && p.created_at <= e); series.push({ label: new Date(e).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), card: d.filter(p => p.method === 'card').reduce((t, p) => t + usdOf(p), 0), crypto: d.filter(p => p.method !== 'card').reduce((t, p) => t + usdOf(p), 0) }); }
    return { volume_usd: ok.reduce((s, p) => s + usdOf(p), 0), payments: ok.length, failed: pays.filter(p => ['declined', 'expired', 'wrong_network'].includes(p.status)).length,
      revenue_usd: Object.entries(rev).reduce((s, [cur, v]) => s - U.toUSD(v, cur), 0), merchants: { total: store.count('merchants'), approved: store.count('merchants', { status: 'approved' }), pending: store.count('merchants', { status: 'pending' }), suspended: store.count('merchants', { status: 'suspended' }) },
      queues: { payouts: store.count('payouts', { mode: c.mode, status: ['pending_approval', 'processing'] }), destinations: store.count('wallets', { status: 'pending_review' }) + store.count('banks', { status: 'pending_review' }),
        provider_requests: store.count('provider_requests', { status: ['requested', 'submitted'] }), kyb: store.list('merchants', { status: 'pending' }).filter(m => m.kyb.submitted).length, alerts: store.count('alerts', { status: 'open' }),
        refunds: store.count('refunds', { mode: c.mode, status: 'pending_execution' }), adjustments: store.count('adjustments', { status: 'pending_approval' }), wallets: store.count('merchant_wallets', { status: 'verified' }) },
      series, live_payments: config.livePayments, audit: store.list('audit', {}, { limit: 8 }),
      usdc: (() => { const u = pays.filter(p => p.method === 'usdc'), led = store.db.prepare('SELECT account, SUM(amount) s FROM ledger WHERE mode=? AND currency=? GROUP BY account').all(c.mode, 'USDC'), g = a => led.find(r => r.account === a)?.s || 0;
        return { network: C.walletParams(C.networkFor(c.mode)), platform_mode: C.settings().platformMode, paid: u.filter(p => core.PAID.includes(p.status)).length, in_flight: u.filter(p => usdc.ACTIVE.includes(p.status)).length,
          exceptions: u.filter(p => ['underpaid', 'overpaid'].includes(p.status)).length, received: g(L.ACCT.MW_RECEIPTS), fees_receivable: g(L.ACCT.P_FEE_RCV), revenue: -g(L.ACCT.P_REV),
          wallets_pending: store.count('merchant_wallets', { status: 'verified' }), refunds_open: store.count('refunds', { mode: c.mode, status: ['requires_action', 'pending'] }), monitor: usdc.status[C.networkFor(c.mode)] || null }; })() };
  });

  /** Sidebar badges: a handful of indexed COUNTs instead of the full overview. */
  A('GET', '/counts', null, (ctx, c) => ({ wallets: store.count('merchant_wallets', { status: 'verified' }), alerts: store.count('alerts', { status: 'open' }),
    kyb: store.list('merchants', { status: 'pending' }, { limit: 500 }).filter(m => m.kyb.submitted).length, adjustments: store.count('adjustments', { status: 'pending_approval' }),
    refunds: store.count('refunds', { mode: c.mode, status: ['requires_action', 'pending'] }) }));

  /* ---- merchants ---- */
  A('GET', '/merchants', null, (ctx, c) => {
    const q = String(ctx.query.q || '').toLowerCase();
    return store.list('merchants', ctx.query.status ? { status: ctx.query.status } : {}, { limit: 5000 }).filter(m => !q || [m.name, m.legal_name, m.website, m.id, m.support_email].join(' ').toLowerCase().includes(q)).map(m => merchantSummary(m, c.mode));
  });
  A('GET', '/merchants/:id', null, (ctx, c) => {
    const m = get('merchants', ctx.params.id);
    return { merchant: m, kyb_ready: core.kybReady(m), live_ready: core.liveReady(m), balances: { test: L.merchantBalances(m.id, 'test'), live: L.merchantBalances(m.id, 'live') },
      users: store.list('users', { merchant_id: m.id }).map(auth.publicUser), keys: store.list('api_keys', { merchant_id: m.id }).map(k => ({ id: k.id, mode: k.mode, type: k.type, name: k.name, prefix: k.prefix, last4: k.last4, status: k.status, last_used: k.last_used, created_at: k.created_at })),
      requests: store.list('provider_requests', { merchant_id: m.id }), summary: merchantSummary(m, c.mode), wallets: store.list('merchant_wallets', { merchant_id: m.id }, { limit: 100 }).map(usdc.publicWallet), receiving: m.receiving || {},
      direct: { test: usdc.directBalances(m.id, 'test'), live: usdc.directBalances(m.id, 'live') }, webhooks: store.list('webhook_endpoints', { merchant_id: m.id }).map(e => ({ id: e.id, mode: e.mode, url: e.url, status: e.status })) };
  });
  A('POST', '/merchants/:id/status', 'merchants.manage', (ctx, c) => {
    const m = get('merchants', ctx.params.id), to = String(ctx.body.status);
    if (!['approved', 'rejected', 'suspended', 'pending'].includes(to)) throw bad('Invalid status.');
    if (to === 'approved' && !core.kybReady(m)) throw bad('Complete every KYB check, verify every owner and clear AML screening first.');
    m.status = to; if (to !== 'approved') m.live_enabled = false;
    if (to === 'approved') for (const mode of ['test']) require('./merchant').ensurePublishable(m, mode, c.actor);
    return saveM(m, c, 'merchant.status_' + to, U.str(ctx.body.note, 300));
  });
  A('POST', '/merchants/:id/kyb', 'merchants.manage', (ctx, c) => {
    const m = get('merchants', ctx.params.id), b = ctx.body;
    if (b.check && b.check in m.kyb.checks) m.kyb.checks[b.check] = !!b.value;
    if (b.owner != null && m.kyb.owners[+b.owner]) { m.kyb.owners[+b.owner].idStatus = b.idStatus === 'verified' ? 'verified' : 'rejected'; m.kyb.checks.owners = m.kyb.owners.length > 0 && m.kyb.owners.every(o => o.idStatus === 'verified'); }
    if (b.aml) { const hit = [m.name, m.legal_name, ...m.kyb.owners.map(o => o.name)].some(n => /sanction|blocked/i.test(n)); m.kyb.aml = { status: hit ? 'hit' : 'clear', at: Date.now(), by: c.actor, note: 'Screening is simulated — connect a sanctions / PEP screening vendor for production.' }; m.kyb.checks.sanctions = !hit; if (hit) core.alert('high', 'aml_hit', m.id, m.id, 'Potential sanctions / PEP match', 'live'); }
    return saveM(m, c, 'merchant.kyb_update', JSON.stringify(b).slice(0, 200));
  });
  A('PATCH', '/merchants/:id/controls', 'merchants.controls', (ctx, c) => {
    const m = get('merchants', ctx.params.id), b = ctx.body;
    if (b.perms) for (const k of Object.keys(m.perms)) if (k in b.perms) m.perms[k] = !!b.perms[k];
    if (b.limits) { const Lm = {}; for (const k of ['perTxnUSD', 'dailyUSD', 'monthlyUSD', 'refundDailyUSD']) { const v = Math.round(+b.limits[k]); if (!(v >= 0)) throw bad(`${k} must be a non-negative number.`); Lm[k] = v; } if (Lm.perTxnUSD > Lm.dailyUSD || Lm.dailyUSD > Lm.monthlyUSD) throw bad('Limits must satisfy per-transaction ≤ daily ≤ 30-day.'); m.limits = Lm; }
    if (b.controls) m.controls = { velocityPerHour: Math.max(1, Math.round(+b.controls.velocityPerHour || 10)), blockedCountries: [].concat(b.controls.blockedCountries || []).map(x => U.str(x, 2).toUpperCase()).filter(Boolean) };
    if (b.risk) { if (!['low', 'medium', 'high'].includes(b.risk)) throw bad('Invalid risk tier.'); m.risk = b.risk; }
    return saveM(m, c, 'merchant.controls_update', JSON.stringify(b).slice(0, 200));
  });
  A('PATCH', '/merchants/:id/pricing', 'merchants.pricing', (ctx, c) => {
    const m = get('merchants', ctx.params.id), b = ctx.body, n = (v, label, max = 100) => { v = +v; if (!(v >= 0 && v <= max)) throw bad(`${label} is out of range.`); return v; };
    m.fees = { card: { acqPct: n(b.acqPct, 'Acquirer %'), acqFixedUSD: Math.round(n(b.acqFixedUSD, 'Fixed fee', 100000)), platPct: n(b.cardPlatPct, 'Card platform %') }, crypto: { provPct: n(b.provPct, 'Provider %'), platPct: n(b.cryptoPlatPct, 'Crypto platform %') }, fxSpreadBps: Math.round(n(b.fxSpreadBps, 'FX spread', 2000)), disputeFeeUSD: Math.round(n(b.disputeFeeUSD, 'Dispute fee', 1000000)) };
    m.reserve = { pct: n(b.reservePct, 'Reserve %', 50), days: Math.round(n(b.reserveDays, 'Reserve days', 365)) };
    return saveM(m, c, 'merchant.pricing_update');
  });
  A('POST', '/merchants/:id/providers', 'providers.authorize', (ctx, c) => {
    const m = get('merchants', ctx.params.id), pv = String(ctx.body.provider), st = String(ctx.body.status);
    if (!(pv in m.providers) || !['approved', 'rejected', 'revoked', 'submitted'].includes(st)) throw bad('Invalid provider or status.');
    m.providers[pv] = st;
    for (const q of store.list('provider_requests', { merchant_id: m.id, status: ['requested', 'submitted'] })) if (q.provider === pv && q.type === 'connection') { q.status = st === 'revoked' ? 'rejected' : st; q.events.push({ at: Date.now(), status: q.status, by: c.actor }); store.put('provider_requests', q); }
    if (pv === 'card_acquirer' && st !== 'approved') { m.non3ds = null; m.threeDS.mode = 'always'; }
    return saveM(m, c, `merchant.provider_${st}`, pv);
  });
  A('POST', '/merchants/:id/route', 'providers.authorize', (ctx, c) => {
    const m = get('merchants', ctx.params.id), pv = String(ctx.body.provider);
    if (!['binance', 'coinbase'].includes(pv)) throw bad('Choose Binance Pay or Coinbase.');
    m.cryptoProvider = pv; return saveM(m, c, 'merchant.crypto_route', pv);
  });
  A('POST', '/merchants/:id/non3ds', 'providers.authorize', (ctx, c) => {
    const m = get('merchants', ctx.params.id);
    if (ctx.body.revoke) { m.non3ds = null; m.threeDS.mode = 'always'; return saveM(m, c, 'merchant.non3ds_revoke'); }
    const ref = U.str(ctx.body.ref, 60);
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,59}$/.test(ref)) throw bad('Enter the acquirer\'s written approval reference.');
    if (m.providers.card_acquirer !== 'approved') throw bad('The card acquirer must authorize this merchant first.');
    m.non3ds = { ref, scope: U.str(ctx.body.scope, 200), at: Date.now(), by: c.actor };
    for (const q of store.list('provider_requests', { merchant_id: m.id, status: ['requested', 'submitted'] })) if (q.type === 'non3ds') { q.status = 'approved'; q.events.push({ at: Date.now(), status: 'approved', by: c.actor, ref }); store.put('provider_requests', q); }
    return saveM(m, c, 'merchant.non3ds_authorize', ref);
  });
  A('POST', '/merchants/:id/live', 'merchants.live', (ctx, c) => {
    const m = get('merchants', ctx.params.id);
    if (ctx.body.enabled) { if (m.status !== 'approved') throw bad('Approve the merchant first.'); if (!store.list('merchant_wallets', { merchant_id: m.id, status: 'approved' }, { limit: 1 }).length) throw bad('Approve a signature-verified receiving wallet (Digital Wallet) first.'); }
    m.live_enabled = !!ctx.body.enabled; return saveM(m, c, 'merchant.live_' + (m.live_enabled ? 'enable' : 'disable'));
  });
  A('POST', '/merchants/:id/hold', 'payouts.approve', (ctx, c) => {
    const m = get('merchants', ctx.params.id);
    if (ctx.body.release) { m.settlementHold = null; return saveM(m, c, 'merchant.hold_release'); }
    const reason = U.str(ctx.body.reason, 300); if (reason.length < 5) throw bad('Give a reason (shown to the merchant).');
    m.settlementHold = { reason, at: Date.now(), by: c.actor }; return saveM(m, c, 'merchant.hold_place', reason);
  });
  /* Admin-side onboarding: create a merchant, its API keys and webhook endpoints (secrets are returned once, stored hashed / encrypted). */
  const WOO_SCOPES = ['checkout:write', 'checkout:read', 'payments:read', 'refunds:write', 'events:read'];
  const keyMode = (m, c) => { if (c.mode === 'live') { const why = core.liveReady(m); if (why) throw bad(why, 'live_mode_unavailable'); } return c.mode; };
  A('POST', '/merchants', 'merchants.manage', (ctx, c) => {
    const b = ctx.body, name = U.str(b.business_name, 120), country = U.str(b.country || 'US', 2).toUpperCase();
    if (name.length < 2) throw bad('Enter the business name.'); if (!/^[A-Z]{2}$/.test(country)) throw bad('Choose a country.');
    const temp = U.rid(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ') + '-' + U.rid(6, 'abcdefghjkmnpqrstuvwxyz') + '-' + U.rid(4, '23456789');
    let m, u;
    store.tx(() => {
      m = core.newMerchant({ name, legal_name: U.str(b.legal_name, 160) || name, country, website: U.str(b.website, 200), support_email: String(b.owner_email || '').toLowerCase() });
      store.put('merchants', m);
      u = auth.createUser({ email: b.owner_email, name: b.owner_name, password: temp, kind: 'merchant', role: 'owner', merchant_id: m.id });
      require('./merchant').ensurePublishable(m, 'test', c.actor);
      core.audit(c.actor, 'merchant.create_by_admin', m.id, name, m.id);
    });
    return { merchant: merchantSummary(m, c.mode), owner: auth.publicUser(u), temporary_password: temp };
  });
  A('POST', '/merchants/:id/keys', 'merchants.controls', (ctx, c) => {
    const m = get('merchants', ctx.params.id), mode = keyMode(m, c);
    const scopes = ctx.body.scope === 'woocommerce' ? WOO_SCOPES : ['*'];
    const { key, secret } = require('./merchant').issueKey(m, mode, { name: U.str(ctx.body.name, 80) || 'Store key', scopes }, c.actor);
    core.audit(c.actor, 'api_key.create_by_admin', key.id, mode, m.id);
    return { id: key.id, mode, name: key.name, scopes, secret };
  });
  A('POST', '/merchants/:id/webhooks', 'merchants.controls', async (ctx, c) => {
    const m = get('merchants', ctx.params.id), mode = keyMode(m, c);
    const ep = await require('./api').createEndpoint(m, mode, { url: ctx.body.url, events: ctx.body.events || ['*'] }, c.actor);
    return require('./api').publicEndpoint(ep, true);
  });
  /** One step: API key (store scopes) + webhook endpoint at <store>/wc-api/digitalhub/ → everything the plugin needs. */
  A('POST', '/woocommerce/connect', 'merchants.controls', async (ctx, c) => {
    const m = get('merchants', ctx.body.merchant), mode = keyMode(m, c);
    let site; try { site = new URL(String(ctx.body.store_url || '').trim()); } catch { throw bad('Enter the store address, for example https://yourshop.com'); }
    if (site.protocol !== 'https:' && config.production) throw bad('The store must use HTTPS.');
    const base = site.origin + site.pathname.replace(/\/+$/, '');
    const hook = base + '/wc-api/digitalhub/';
    const existing = store.list('webhook_endpoints', { merchant_id: m.id, mode }).find(e => e.url === hook && e.status === 'enabled');
    if (existing) throw bad('This store is already connected for this merchant. Revoke the old key / delete the webhook first, or use the existing settings.', 'already_connected');
    const ep = await require('./api').createEndpoint(m, mode, { url: hook, events: ['*'], description: 'WooCommerce ' + site.host }, c.actor);
    const { key, secret } = require('./merchant').issueKey(m, mode, { name: 'WooCommerce ' + site.host, scopes: WOO_SCOPES }, c.actor);
    core.audit(c.actor, 'woocommerce.connect', m.id, site.host + ' ' + mode, m.id);
    return { merchant: m.name, mode, store: site.host, plugin_settings: { digital_hub_url: config.publicUrl, test_mode: mode === 'test', secret_key: secret, webhook_secret: ep._secret },
      webhook_url: hook, key_id: key.id, endpoint_id: ep.id, receiving_wallet: !!require('../usdc').receivingWallet(m, mode) };
  });
  A('POST', '/merchants/:id/webhooks/:ep/delete', 'merchants.controls', (ctx, c) => { const e = get('webhook_endpoints', ctx.params.ep); if (e.merchant_id !== ctx.params.id) throw bad('Endpoint mismatch.'); store.del('webhook_endpoints', e.id); core.audit(c.actor, 'webhook_endpoint.delete_by_admin', e.id, e.url, e.merchant_id); return { ok: true }; });

  A('POST', '/merchants/:id/keys/:key/revoke', 'merchants.controls', (ctx, c) => { const k = get('api_keys', ctx.params.key); if (k.merchant_id !== ctx.params.id) throw bad('Key mismatch.'); k.status = 'revoked'; store.put('api_keys', k); core.audit(c.actor, 'api_key.revoke_by_admin', k.id, '', k.merchant_id); return { ok: true }; });
  A('POST', '/merchants/:id/users/:user/status', 'merchants.manage', (ctx, c) => { const u = get('users', ctx.params.user); if (u.merchant_id !== ctx.params.id) throw bad('User mismatch.'); u.status = ctx.body.active ? 'active' : 'disabled'; store.put('users', u); core.audit(c.actor, 'merchant_user.' + u.status, u.email, '', u.merchant_id); return auth.publicUser(u); });

  /* ---- payments, disputes, refunds ---- */
  A('GET', '/payments', null, (ctx, c) => {
    const q = ctx.query, s = String(q.q || '').toLowerCase();
    let rows = store.list('payments', { mode: c.mode, ...(q.merchant ? { merchant_id: q.merchant } : {}), ...(q.status ? { status: q.status } : {}) }, { limit: 3000 });
    if (q.method) rows = rows.filter(p => p.method === q.method);
    if (s) rows = rows.filter(p => [p.id, p.customer?.email, p.description, p.card?.last4, p.crypto?.payer, p.crypto?.recipient, ...(p.crypto?.txs || []).map(t => t.hash)].some(x => String(x || '').toLowerCase().includes(s)));
    const names = Object.fromEntries(store.list('merchants', {}, { limit: 10000 }).map(m => [m.id, m.name]));
    return { total: rows.length, data: rows.slice(0, 200).map(p => ({ ...core.publicPayment(p), merchant: p.merchant_id, merchant_name: names[p.merchant_id] })) };
  });
  A('GET', '/payments/:id', null, async (ctx, c) => {
    const p = await usdc.refreshPayment(get('payments', ctx.params.id));
    return { payment: core.publicPayment(p), merchant: merchantSummary(get('merchants', p.merchant_id), p.mode), events: p.events, risk: p.risk || null, three_ds: p.card?.threeDS || null, crypto: p.crypto || null, ledger: L.entriesFor(p.id),
      refunds: store.list('refunds', { merchant_id: p.merchant_id }).filter(x => x.payment_id === p.id), dispute: store.list('disputes', { merchant_id: p.merchant_id }).find(d => d.payment_id === p.id) || null,
      provider_events: store.list('provider_events', {}, { limit: 300 }).filter(e => e.payment_id === p.id) };
  });
  A('POST', '/payments/:id/crypto', 'payments.manage', (ctx, c) => {
    const p = get('payments', ctx.params.id);
    if (p.mode !== 'test') throw bad('Live crypto status comes only from verified provider webhooks.');
    if (ctx.body.action === 'tick') core.cryptoTick(p); else if (ctx.body.action === 'expire') { p.crypto.expiresAt = 0; core.cryptoExpire(p); } else throw bad('Unknown action.');
    core.audit(c.actor, 'payment.crypto_' + ctx.body.action, p.id, '', p.merchant_id); return core.publicPayment(store.get('payments', p.id));
  });
  A('POST', '/payments/:id/wrong-network-returned', 'payments.manage', (ctx, c) => { const p = get('payments', ctx.params.id); if (p.status !== 'wrong_network') throw bad('Not a wrong-network payment.'); p.status = 'refunded'; p.events.push({ at: Date.now(), status: 'refunded', note: `Returned to customer outside the platform: ${U.str(ctx.body.reference, 120)}` }); store.put('payments', p); core.audit(c.actor, 'payment.wrong_network_returned', p.id, '', p.merchant_id); return { ok: true }; });
  A('GET', '/disputes', null, (ctx, c) => store.list('disputes', { mode: c.mode }, { limit: 500 }));
  A('POST', '/disputes/:id/resolve', 'payments.manage', (ctx, c) => core.resolveDispute(get('disputes', ctx.params.id), !!ctx.body.won, c.actor));
  A('GET', '/refunds', null, (ctx, c) => { const n = names(); return store.list('refunds', { mode: c.mode, ...(ctx.query.status ? { status: ctx.query.status.split(',') } : {}) }, { limit: 500 })
    .map(r => ({ ...r, merchant_name: n[r.merchant_id], explorer: r.tx?.hash && r.network ? C.explorerTx(r.network, r.tx.hash) : null })); });
  A('POST', '/refunds/:id/check', 'payments.manage', async (ctx, c) => usdc.refreshRefund(get('refunds', ctx.params.id), { force: true }));
  A('POST', '/refunds/:id/complete', 'payouts.execute', (ctx, c) => { const r = get('refunds', ctx.params.id); if (r.status !== 'pending_execution') throw bad('Refund is not awaiting execution.'); const ref = U.str(ctx.body.reference, 120); if (!ref) throw bad('Enter the transaction hash.'); r.status = 'succeeded'; r.tx_hash = ref; store.put('refunds', r); core.audit(c.actor, 'refund.executed', r.id, ref, r.merchant_id); return r; });

  /* ---- payouts & destinations ---- */
  A('GET', '/payouts', null, (ctx, c) => { const names = Object.fromEntries(store.list('merchants', {}, { limit: 10000 }).map(m => [m.id, m.name])); return store.list('payouts', { mode: c.mode, ...(ctx.query.status ? { status: ctx.query.status.split(',') } : {}) }, { limit: 500 }).map(po => ({ ...core.publicPayout(po), merchant: po.merchant_id, merchant_name: names[po.merchant_id], reasons: po.reasons, events: po.events, requested_by: po.actor })); });
  A('POST', '/payouts/:id/approve', 'payouts.approve', (ctx, c) => core.publicPayout(core.approvePayout(get('payouts', ctx.params.id), c.actor)));
  A('POST', '/payouts/:id/reject', 'payouts.approve', (ctx, c) => { const note = U.str(ctx.body.note, 300); if (!note) throw bad('Add a note for the merchant.'); return core.publicPayout(core.rejectPayout(get('payouts', ctx.params.id), c.actor, note)); });
  A('POST', '/payouts/:id/complete', 'payouts.execute', (ctx, c) => core.publicPayout(core.completePayout(get('payouts', ctx.params.id), c.actor, ctx.body.reference)));
  A('GET', '/destinations', null, (ctx, c) => { const names = Object.fromEntries(store.list('merchants', {}, { limit: 10000 }).map(m => [m.id, m.name])); const st = ctx.query.status || 'pending_review';
    return [...store.list('wallets', { status: st }).map(w => ({ ...w, kind: 'wallet' })), ...store.list('banks', { status: st }).map(b => ({ ...b, account: undefined, kind: 'bank' }))].map(d => ({ ...d, merchant_name: names[d.merchant_id] })); });
  A('POST', '/destinations/:id/decision', 'destinations.review', (ctx, c) => {
    const t = ctx.params.id.startsWith('wal_') ? 'wallets' : 'banks', d = get(t, ctx.params.id);
    d.status = ctx.body.approve ? 'verified' : 'rejected'; d.reviewed_by = c.actor; d.review_note = U.str(ctx.body.note, 300); store.put(t, d);
    core.audit(c.actor, `${t}.${d.status}`, d.id, d.review_note, d.merchant_id); return { ok: true };
  });
  A('GET', '/provider-requests', null, (ctx, c) => { const names = Object.fromEntries(store.list('merchants', {}, { limit: 10000 }).map(m => [m.id, m.name])); return store.list('provider_requests', ctx.query.all ? {} : { status: ['requested', 'submitted'] }).map(q => ({ ...q, merchant_name: names[q.merchant_id] })); });
  A('POST', '/provider-requests/:id', 'providers.authorize', (ctx, c) => {
    const q = get('provider_requests', ctx.params.id), st = String(ctx.body.status);
    if (!['submitted', 'approved', 'rejected'].includes(st)) throw bad('Invalid status.');
    if (q.type === 'non3ds' && st === 'approved') throw bad('Record the acquirer reference from the merchant page (Providers & 3DS).');
    q.status = st; q.events.push({ at: Date.now(), status: st, by: c.actor, note: U.str(ctx.body.note, 300) }); store.put('provider_requests', q);
    if (q.type === 'connection') { const m = get('merchants', q.merchant_id); m.providers[q.provider] = st; store.put('merchants', m); }
    core.audit(c.actor, 'provider_request.' + st, q.id, q.provider, q.merchant_id); return q;
  });

  /* ---- providers & webhooks ---- */
  A('GET', '/providers', null, (ctx, c) => ({
    live_payments: config.livePayments,
    providers: P.PROVIDER_INFO.map(p => ({ ...p, configured: p.id === 'binance' ? P.BinancePay.configured() : p.id === 'coinbase' ? P.Coinbase.configured() : false,
      webhook_configured: p.id === 'binance' ? P.BinancePay.webhookConfigured() : p.id === 'coinbase' ? P.Coinbase.webhookConfigured() : false,
      webhook_url: p.kind === 'crypto' ? `${config.publicUrl}/hooks/${p.id === 'binance' ? 'binance-pay' : 'coinbase'}` : null,
      merchants: store.list('merchants', {}, { limit: 10000 }).filter(m => m.providers[p.id] === 'approved').length })),
    networks: P.NETWORKS, networks_enabled: core.platform().networksEnabled,
    events: store.list('provider_events', {}, { limit: 100 }),
  }));
  A('GET', '/deliveries', null, (ctx, c) => store.list('deliveries', { mode: c.mode, ...(ctx.query.status ? { status: ctx.query.status.split(',') } : {}) }, { limit: 300 }));
  A('POST', '/deliveries/:id/retry', 'payments.manage', (ctx, c) => { const d = get('deliveries', ctx.params.id); d.status = 'pending'; d.next_at = Date.now(); store.put('deliveries', d); core.runDeliveries(); return { ok: true }; });

  /* ---- ledger, adjustments ---- */
  A('GET', '/ledger', null, (ctx, c) => ({ trial_balance: L.trialBalance(c.mode), accounts: L.accountTotals(c.mode), checks: core.reconChecks(c.mode), journals: L.journalCount(c.mode), entries: L.recent(c.mode, 150, ctx.query.merchant || undefined) }));
  A('GET', '/adjustments', null, () => store.list('adjustments', {}, { limit: 300 }));
  A('POST', '/adjustments', 'finance.adjust', (ctx, c) => {
    const m = get('merchants', ctx.body.merchant), cur = String(ctx.body.currency || '').toUpperCase(), amount = Math.round(+ctx.body.amount), reason = U.str(ctx.body.reason, 300);
    if (!U.CURRENCIES[cur]) throw bad('Choose a currency.'); if (!Number.isInteger(amount) || amount === 0) throw bad('Enter a non-zero amount (minor units).'); if (reason.length < 10) throw bad('Explain the adjustment (10+ characters).');
    const mode = ctx.body.mode === 'live' ? 'live' : 'test';
    const a = store.put('adjustments', { id: U.id('adj'), merchant_id: m.id, mode, status: 'pending_approval', currency: cur, amount, reason, maker: c.actor });
    core.audit(c.actor, 'adjustment.draft', a.id, `${U.fmt(amount, cur)} ${reason}`, m.id); return a;
  });
  A('POST', '/adjustments/:id/:decision', 'finance.adjust', (ctx, c) => {
    const a = get('adjustments', ctx.params.id); if (a.status !== 'pending_approval') throw bad('Already decided.');
    if (a.maker === c.actor) throw bad('Maker-checker: a different staff member must approve this adjustment.');
    if (ctx.params.decision === 'approve') { core.adjust(get('merchants', a.merchant_id), a.mode, a, a.maker, c.actor); a.status = 'posted'; } else a.status = 'rejected';
    a.checker = c.actor; store.put('adjustments', a); core.audit(c.actor, 'adjustment.' + a.status, a.id, '', a.merchant_id); return a;
  });

  /* ---- risk, audit, staff, platform ---- */
  A('GET', '/alerts', null, (ctx) => store.list('alerts', ctx.query.status ? { status: ctx.query.status } : {}, { limit: 500 }));
  A('POST', '/alerts/:id', 'alerts.manage', (ctx, c) => { const al = get('alerts', ctx.params.id); if (!['acknowledged', 'resolved'].includes(ctx.body.status)) throw bad('Invalid status.'); al.status = ctx.body.status; store.put('alerts', al); core.audit(c.actor, 'alert.' + al.status, al.id, '', al.merchant_id); return al; });
  A('GET', '/audit', null, (ctx) => { const q = String(ctx.query.q || '').toLowerCase(); return store.list('audit', ctx.query.merchant ? { merchant_id: ctx.query.merchant } : {}, { limit: 3000 }).filter(a => !q || JSON.stringify(a).toLowerCase().includes(q)).slice(0, 300); });
  A('GET', '/staff', null, () => ({ staff: store.list('users', {}, { limit: 10000 }).filter(u => u.kind === 'staff').map(auth.publicUser), roles: auth.STAFF_ROLES, perms: auth.STAFF_PERMS }));
  A('POST', '/staff', 'staff.manage', (ctx, c) => {
    if (!auth.STAFF_ROLES[ctx.body.role]) throw bad('Choose a role.');
    const temp = U.rid(8, 'abcdefghjkmnpqrstuvwxyz') + U.rid(6, '23456789');
    const u = auth.createUser({ email: ctx.body.email, name: ctx.body.name, password: temp, kind: 'staff', role: ctx.body.role });
    core.audit(c.actor, 'staff.invite', u.email, u.role); return { user: auth.publicUser(u), temporary_password: temp };
  });
  A('PATCH', '/staff/:id', 'staff.manage', (ctx, c) => {
    const u = get('users', ctx.params.id); if (u.kind !== 'staff') throw bad('Not a staff user.');
    if (u.id === c.user.id && (ctx.body.status === 'disabled' || (ctx.body.role && ctx.body.role !== u.role))) throw bad('You cannot change your own role or disable yourself.');
    if (ctx.body.role) { if (!auth.STAFF_ROLES[ctx.body.role]) throw bad('Invalid role.'); u.role = ctx.body.role; }
    if (ctx.body.status) u.status = ctx.body.status === 'disabled' ? 'disabled' : 'active';
    if (ctx.body.reset_mfa) { u.mfa_enabled = false; u.mfa_secret = null; }
    const supers = store.list('users', {}, { limit: 10000 }).filter(x => x.kind === 'staff' && x.role === 'super_admin' && x.status === 'active' && x.id !== u.id);
    if (!supers.length && !(u.role === 'super_admin' && u.status === 'active')) throw bad('At least one active Super admin must remain.');
    store.put('users', u); core.audit(c.actor, 'staff.update', u.email, JSON.stringify(ctx.body)); return auth.publicUser(u);
  });
  A('GET', '/platform', null, () => ({ settings: core.platform(), config: { livePayments: config.livePayments, sandboxDayMs: config.sandboxDayMs, requireStaffMfa: config.requireStaffMfa, publicUrl: config.publicUrl }, networks: P.NETWORKS }));
  A('PATCH', '/platform', 'platform.settings', (ctx, c) => {
    const b = ctx.body, cur = core.platform();
    if (b.networksEnabled) for (const k of Object.keys(cur.networksEnabled)) if (k in b.networksEnabled) cur.networksEnabled[k] = !!b.networksEnabled[k];
    if (b.approvalThresholdUSD != null) { const v = Math.round(+b.approvalThresholdUSD); if (!(v >= 0)) throw bad('Invalid threshold.'); cur.approvalThresholdUSD = v; }
    if (b.risk) cur.risk = { declineCount: Math.max(1, Math.round(+b.risk.declineCount || 3)), highValueUSD: Math.max(100, Math.round(+b.risk.highValueUSD || 500000)) };
    if (b.defaults) for (const k of Object.keys(cur.defaults)) if (k in b.defaults) { const v = +b.defaults[k]; if (!(v >= 0)) throw bad(`Invalid ${k}.`); cur.defaults[k] = v; }
    core.setPlatform(cur); core.audit(c.actor, 'platform.update', 'platform', Object.keys(b).join(',')); return cur;
  });
  /* ================= MetaMask USDC gateway ================= */
  /* Digital Wallet: merchant receiving wallets */
  A('GET', '/wallets', null, (ctx, c) => { const n = names(), st = ctx.query.status;
    return store.list('merchant_wallets', st ? { status: st.split(',') } : {}, { limit: 2000 }).map(w => { const m = store.get('merchants', w.merchant_id);
      return { ...usdc.publicWallet(w), merchant: w.merchant_id, merchant_name: n[w.merchant_id], proof: w.proof ? { signer: w.proof.signer, signed_at: w.proof.signed_at, ip: w.proof.ip, message: w.proof.message, signature: w.proof.signature } : null,
        receiving_test: m?.receiving?.test === w.id, receiving_live: m?.receiving?.live === w.id,
        received: { test: store.list('payments', { merchant_id: w.merchant_id, mode: 'test', status: core.PAID }, { limit: 5000 }).filter(p => p.crypto?.wallet_id === w.id).reduce((s, p) => s + (p.creditedAmount || 0), 0),
          live: store.list('payments', { merchant_id: w.merchant_id, mode: 'live', status: core.PAID }, { limit: 5000 }).filter(p => p.crypto?.wallet_id === w.id).reduce((s, p) => s + (p.creditedAmount || 0), 0) } }; }); });
  A('POST', '/wallets/:id/review', 'destinations.review', (ctx, c) => usdc.publicWallet(usdc.reviewWallet(get('merchant_wallets', ctx.params.id), !!ctx.body.approve, ctx.body.note, c.actor)));
  A('POST', '/wallets/:id/recheck', 'destinations.review', (ctx, c) => { const w = get('merchant_wallets', ctx.params.id); if (!w.proof) throw bad('No signature on file.');
    const ok = E.verifyPersonal(w.proof.message, w.proof.signature, w.address); core.audit(c.actor, 'wallet.signature_recheck', w.id, ok ? 'valid' : 'INVALID', w.merchant_id); return { valid: ok, signer: ok ? w.address : null }; });

  /* Invoices = checkout sessions */
  A('GET', '/invoices', null, (ctx, c) => { const n = names(), q = ctx.query, s = String(q.q || '').toLowerCase();
    let rows = store.list('checkout_sessions', { mode: c.mode, ...(q.merchant ? { merchant_id: q.merchant } : {}), ...(q.status ? { status: q.status } : {}) }, { limit: 3000 });
    if (s) rows = rows.filter(x => [x.id, x.description, x.customer_email, JSON.stringify(x.metadata || {})].some(v => String(v || '').toLowerCase().includes(s)));
    return { total: rows.length, data: rows.slice(0, 300).map(x => { const p = x.payment_id ? store.get('payments', x.payment_id) : null;
      return { ...core.publicSession(x), merchant: x.merchant_id, merchant_name: n[x.merchant_id], payment_detail: p ? { id: p.id, status: p.status, method: p.method, card: p.card ? { brand: p.card.brand, last4: p.card.last4, exp_month: p.card.exp_month, exp_year: p.card.exp_year, cardholder: p.card.holder, three_d_secure: p.card.threeDS?.result || null } : null, payer: p.crypto?.payer || null, tx: p.crypto?.txs?.find(t => t.status === 'confirmed')?.hash || p.crypto?.txs?.at(-1)?.hash || null, network: p.crypto?.network || null } : null,
        source: x.metadata?.subscription_id ? 'subscription' : x.metadata?.order_id ? 'woocommerce' : x.link_id ? 'payment_link' : 'api' }; }) }; });

  /* Subscriptions */
  A('GET', '/subscriptions', null, (ctx, c) => { const n = names(), SUB = require('../subscriptions'); return store.list('subscriptions', { mode: c.mode, ...(ctx.query.status ? { status: ctx.query.status } : {}) }, { limit: 2000 }).map(s => ({ ...SUB.publicSubscription(s), merchant: s.merchant_id, merchant_name: n[s.merchant_id] })); });

  /* Settlements: platform fees owed by merchants (funds never pass through Digital Hub) */
  A('GET', '/settlements', null, (ctx, c) => { const n = names();
    const merchants = store.list('merchants', {}, { limit: 10000 }).map(m => ({ id: m.id, name: m.name, fees_due: usdc.feeDue(m.id, c.mode), fee_pct: m.fees.crypto.platPct,
      open: store.list('settlements', { merchant_id: m.id, mode: c.mode, status: ['open', 'verifying'] }, { limit: 100 }).reduce((s, x) => s + x.amount, 0), volume: usdc.directBalances(m.id, c.mode).sales })).filter(x => x.fees_due || x.volume || x.open);
    return { fee_wallet: C.settings().feeWallet, merchants, statements: store.list('settlements', { mode: c.mode }, { limit: 500 }).map(s => ({ ...s, merchant_name: n[s.merchant_id], explorer: s.tx?.hash ? C.explorerTx(C.networkFor(s.mode), s.tx.hash) : null })) }; });
  A('POST', '/settlements', 'payouts.approve', (ctx, c) => usdc.createSettlement(get('merchants', ctx.body.merchant), c.mode, c.actor));
  A('POST', '/settlements/:id/tx', 'payouts.execute', async (ctx, c) => usdc.submitSettlementTx(get('settlements', ctx.params.id), String(ctx.body.hash || ''), c.actor));
  A('POST', '/settlements/:id/check', 'payouts.execute', async (ctx, c) => usdc.refreshSettlement(get('settlements', ctx.params.id)));
  A('POST', '/settlements/:id/void', 'payouts.approve', (ctx, c) => usdc.voidSettlement(get('settlements', ctx.params.id), c.actor, ctx.body.note));

  /* WooCommerce integrations: stores connected through webhooks + API keys */
  A('GET', '/woocommerce', null, (ctx, c) => { const n = names();
    const eps = store.list('webhook_endpoints', { mode: c.mode }, { limit: 5000 }).filter(e => /\/wc-api\/digitalhub\/?$/.test(new URL(e.url).pathname) || /wc-api=digitalhub/.test(e.url));
    const stores = eps.map(e => { const dels = store.list('deliveries', { merchant_id: e.merchant_id, mode: c.mode }, { limit: 300 }).filter(d => d.endpoint_id === e.id);
      const orders = store.list('checkout_sessions', { merchant_id: e.merchant_id, mode: c.mode }, { limit: 1000 }).filter(s => s.metadata?.order_id);
      const keys = store.list('api_keys', { merchant_id: e.merchant_id, mode: c.mode }, { limit: 100 }).filter(k => k.type === 'secret' && k.status === 'active');
      return { endpoint: e.id, merchant: e.merchant_id, merchant_name: n[e.merchant_id], url: e.url, status: e.status, events: e.events, site: orders.find(o => o.metadata?.site)?.metadata.site || new URL(e.url).origin,
        delivered: dels.filter(d => d.status === 'delivered').length, failing: dels.filter(d => ['retrying', 'failed'].includes(d.status)).length, last_delivery: dels[0] ? { at: dels[0].last_attempt || dels[0].created_at, status: dels[0].status, code: dels[0].code, type: dels[0].type, error: dels[0].error } : null,
        orders: orders.length, paid_orders: orders.filter(o => o.status === 'complete').length, open_orders: orders.filter(o => o.status === 'open').length, key_last_used: Math.max(0, ...keys.map(k => k.last_used || 0)) || null }; });
    const recent = store.list('checkout_sessions', { mode: c.mode }, { limit: 2000 }).filter(s => s.metadata?.order_id).slice(0, 50).map(s => ({ ...core.publicSession(s), merchant_name: n[s.merchant_id] }));
    return { stores, recent, plugin: { version: '2.0.0', download: '/downloads/digitalhub-woocommerce.zip', webhook_path: '/wc-api/digitalhub/' } }; });

  /* Settings → MetaMask */
  const chainView = async (probe = false) => { const s = C.settings();
    const nets = {}; for (const [k, n] of Object.entries(C.NETWORKS)) { const cur = s.networks[k];
      nets[k] = { ...C.walletParams(k), mode: n.mode, enabled: cur.enabled, confirmations: cur.confirmations, finality: cur.finality, quote_minutes: cur.quoteMinutes, usdc: cur.usdc, usdc_canonical: n.usdc, usdc_pinned: n.usdcPinned, min_confirmations: n.minConfirmations,
        rpc_source: C.rpcSource(k), rpc_env_locked: !!process.env[n.envRpc], rpcs: probe ? await C.probe(k) : C.healthView(k), rpc_count: C.rpcUrls(k).length, ws: C.socketView(k), ws_env_locked: !!process.env[n.envWs],
        token: probe ? await C.verifyToken(k, cur.usdc) : (s.tokenChecks?.[k] || null), monitor: usdc.status[k] || null, scan_cursor: store.getMeta('scan:' + k, null) }; }
    return { platform_mode: s.platformMode, fee_wallet: s.feeWallet, providers: s.providers, networks: nets, rpc_errors: C.rpcErrors.slice(0, 20), live_payments_env: config.livePayments, finality_options: C.FINALITY }; };
  A('GET', '/chain', null, async (ctx) => chainView(ctx.query.probe === '1'));
  A('POST', '/chain/networks/:key', 'platform.settings', async (ctx, c) => {
    const key = ctx.params.key, n = C.NETWORKS[key]; if (!n) throw bad('Unknown network.');
    const s = C.settings(), cur = { ...s.networks[key] }, b = ctx.body, changes = [];
    if (b.confirmations != null) { const v = Math.round(+b.confirmations); if (!(v >= n.minConfirmations && v <= 500)) throw bad(`Confirmations must be between ${n.minConfirmations} and 500 on ${n.name}.`); cur.confirmations = v; changes.push('confirmations=' + v); }
    if (b.finality != null) { if (!C.FINALITY.includes(b.finality)) throw bad('Finality must be confirmations, safe or finalized.'); cur.finality = b.finality; changes.push('finality=' + b.finality); }
    if (b.quote_minutes != null) { const v = Math.round(+b.quote_minutes); if (!(v >= 5 && v <= 180)) throw bad('Payment window must be 5–180 minutes.'); cur.quoteMinutes = v; changes.push('quoteMinutes=' + v); }
    if (b.enabled != null) { if (key === 'base' && b.enabled && s.platformMode !== 'live') throw bad('Enable Base Mainnet through the live-mode switch (production checks).'); cur.enabled = !!b.enabled; changes.push('enabled=' + cur.enabled); }
    if (b.usdc != null && E.lower(b.usdc) !== E.lower(cur.usdc)) {
      if (n.usdcPinned) throw bad(`The ${n.name} USDC contract is pinned to Circle's canonical address and cannot be changed.`);
      const a = E.normalizeAddress(b.usdc); if (!a) throw bad('USDC contract must be a valid address.');
      const t = await C.verifyToken(key, a); if (!t.ok) throw bad('Token check failed: ' + t.error);
      cur.usdc = a; changes.push('usdc=' + a);
      if (store.list('payments', { mode: n.mode, status: usdc.ACTIVE }, { limit: 1 }).length) throw bad('Wait until no USDC payments are in flight before changing the token contract.');
    }
    if (b.rpc_urls != null) {
      if (process.env[n.envRpc]) throw bad(`RPC endpoints are set by the ${n.envRpc} environment variable.`);
      const urls = [].concat(b.rpc_urls).map(x => String(x).trim()).filter(Boolean).slice(0, 6);
      for (const u of urls) { let url; try { url = new URL(u); } catch { throw bad('Invalid RPC URL: ' + C.mask(u)); }
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !config.production && ['localhost', '127.0.0.1'].includes(url.hostname))) throw bad('RPC URLs must use HTTPS.'); }
      const probeOne = async u => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(e => ({ error: { message: e.message } }));
        if (r.error || Number(E.fromHexQty(r.result)) !== n.chainId) throw bad(`${C.mask(u)} is not a working ${n.name} endpoint (${r.error?.message || 'chain ' + Number(E.fromHexQty(r.result))}).`); };
      for (const u of urls) await probeOne(u);
      cur.rpcUrls = urls.map(u => U.seal(u)); changes.push(`rpcUrls=${urls.length}`);
    }
    if (b.ws_url != null) {
      if (process.env[n.envWs]) throw bad(`The WebSocket endpoint is set by ${n.envWs}.`);
      const w = String(b.ws_url).trim(); if (w && !/^wss:\/\//.test(w) && !(!config.production && /^ws:\/\/(localhost|127\.0\.0\.1)/.test(w))) throw bad('WebSocket URL must start with wss://');
      cur.wsUrl = w ? U.seal(w) : ''; changes.push('wsUrl=' + (w ? 'set' : 'cleared'));
    }
    s.networks[key] = cur; C.saveSettings(s); core.audit(c.actor, 'chain.network_update', key, changes.join(', '));
    return chainView(false); });
  A('POST', '/chain/probe/:key', 'platform.settings', async (ctx, c) => { const key = ctx.params.key; if (!C.NETWORKS[key]) throw bad('Unknown network.');
    const s = C.settings(), t = await C.verifyToken(key, s.networks[key].usdc); s.tokenChecks = { ...(s.tokenChecks || {}), [key]: t }; C.saveSettings(s);
    return { rpcs: await C.probe(key), token: t }; });
  A('PATCH', '/chain', 'platform.settings', (ctx, c) => { const s = C.settings(), b = ctx.body;
    if (b.card_sandbox !== undefined) s.providers = { ...s.providers, card: !!b.card_sandbox }; // sandbox test cards only; live cards stay off without an acquirer
    if (b.fee_wallet !== undefined) { const a = b.fee_wallet ? E.normalizeAddress(b.fee_wallet) : null; if (b.fee_wallet && !a) throw bad('Fee treasury wallet must be a valid address.'); s.feeWallet = a; }
    C.saveSettings(s); core.audit(c.actor, 'chain.settings_update', 'chain', Object.keys(b).join(',')); return { ok: true, fee_wallet: s.feeWallet }; });
  A('GET', '/chain/production-checks', null, async () => C.productionChecks({ live: true }));
  A('POST', '/chain/mode', 'platform.settings', async (ctx, c) => { const s = C.settings(), to = ctx.body.mode === 'live' ? 'live' : 'sandbox';
    if (to === 'live') { const pc = await C.productionChecks({ live: true }); if (!pc.ready) throw bad('Production checks failing: ' + pc.checks.filter(x => x.required && !x.ok).map(x => x.label).join('; ')); s.networks.base.enabled = true; }
    else s.networks.base.enabled = false;
    s.platformMode = to; C.saveSettings(s); core.audit(c.actor, 'chain.mode_' + to, 'chain', ''); return chainView(false); });
  A('POST', '/chain/monitor', 'platform.settings', async (ctx, c) => usdc.tickAll());

  /* API logs */
  A('GET', '/api-logs', null, (ctx) => { const q = ctx.query, s = String(q.q || '').toLowerCase(), n = names();
    let rows = store.list('api_logs', { ...(q.merchant ? { merchant_id: q.merchant } : {}) }, { limit: 3000 });
    if (q.status === 'error') rows = rows.filter(r => r.code >= 400); else if (q.status === 'ok') rows = rows.filter(r => r.code < 400);
    if (q.kind) rows = rows.filter(r => r.kind === q.kind);
    if (s) rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(s));
    return { total: rows.length, data: rows.slice(0, 300).map(r => ({ ...r, merchant_name: n[r.merchant_id] || null })), rpc_errors: C.rpcErrors.slice(0, 20) }; });

  /* Risk & Security */
  A('GET', '/risk', null, (ctx, c) => { const staff = store.list('users', {}, { limit: 10000 }), dayAgo = Date.now() - DAY;
    const audit = store.list('audit', { since: Date.now() - 7 * DAY }, { limit: 5000 });
    return { alerts: store.list('alerts', { status: 'open' }, { limit: 300 }),
      posture: { staff_total: staff.filter(u => u.kind === 'staff' && u.status === 'active').length, staff_no_mfa: staff.filter(u => u.kind === 'staff' && u.status === 'active' && !u.mfa_enabled).length,
        merchant_owners_no_mfa: staff.filter(u => u.kind === 'merchant' && u.role === 'owner' && u.status === 'active' && !u.mfa_enabled).length, require_staff_mfa: config.requireStaffMfa, https: config.publicUrl.startsWith('https://'), production: config.production, postgres: store.usePg },
      onchain: { rejected_txs_24h: store.list('alerts', { since: dayAgo }, { limit: 2000 }).filter(a => ['tx_rejected', 'refund_tx_rejected'].includes(a.kind)).length,
        signature_mismatches_7d: audit.filter(a => a.action === 'wallet.signature_mismatch').length, duplicate_payments: store.list('alerts', {}, { limit: 5000 }).filter(a => a.kind === 'duplicate_payment' && a.status !== 'resolved').length,
        wallets_awaiting_review: store.count('merchant_wallets', { status: 'verified' }), failed_logins_note: 'Login throttling: 5 failures → 15-minute lockout per IP+email.' },
      security_events: audit.filter(a => /^(auth\.|wallet\.|chain\.|staff\.|api_key\.|merchant\.status|merchant\.live)/.test(a.action)).slice(0, 100) }; });

  A('POST', '/jobs/run', 'platform.settings', (ctx, c) => { const out = { test: core.runSettlement('test'), live: core.runSettlement('live') }; core.runExpiry(); core.runDeliveries(); core.audit(c.actor, 'jobs.run', 'jobs', JSON.stringify(out)); return out; });
}

module.exports = { routes };
