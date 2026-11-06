'use strict';
/* Super Admin API — /a-api. Staff sessions only; every mutation checks a staff permission
   (and 2FA when REQUIRE_STAFF_MFA / production) and is written to the audit log. */
const config = require('../config');
const store = require('../db');
const L = require('../ledger');
const U = require('../util');
const core = require('../core');
const CA = require('../cashapp');
const auth = require('../auth');
const { HttpError, bad, DAY } = U;

const usdOf = p => U.toUSD(p.amount, p.currency);
const merchantSummary = (m, mode) => {
  core.normalizeMerchant(m);
  const pays = store.list('payments', { merchant_id: m.id, mode, status: core.PAID, since: Date.now() - 30 * DAY }, { limit: 5000 });
  return { id: m.id, name: m.name, legal_name: m.legal_name, country: m.country, status: m.status, risk: m.risk, live_enabled: m.live_enabled, created_at: m.created_at, kyb_submitted: m.kyb.submitted,
    cashapp: { test: m.cashapp.test.status || 'NOT_REGISTERED', live: m.cashapp.live.status || 'NOT_REGISTERED' }, hold: !!m.settlementHold, volume_30d_usd: pays.reduce((s, p) => s + usdOf(p), 0), payments_30d: pays.length };
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
    for (let i = 13; i >= 0; i--) { const e = end.getTime() - i * DAY, s = e - DAY; const d = ok.filter(p => p.created_at > s && p.created_at <= e); series.push({ label: new Date(e).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), card: d.reduce((t, p) => t + usdOf(p), 0), crypto: 0 }); }
    return { volume_usd: ok.reduce((s, p) => s + usdOf(p), 0), payments: ok.length, failed: pays.filter(p => ['declined', 'expired'].includes(p.status)).length, refunded_usd: ok.reduce((t, p) => t + U.toUSD(p.refunded || 0, p.currency), 0),
      disputes_open: store.count('disputes', { mode: c.mode, status: ['needs_response', 'under_review'] }), cashapp: { test: CA.environmentLabel('test'), live: CA.configured('live') ? 'Cash App production' : 'Production credentials missing' },
      revenue_usd: Object.entries(rev).reduce((s, [cur, v]) => s - U.toUSD(v, cur), 0), merchants: { total: store.count('merchants'), approved: store.count('merchants', { status: 'approved' }), pending: store.count('merchants', { status: 'pending' }), suspended: store.count('merchants', { status: 'suspended' }) },
      queues: { payouts: store.count('payouts', { mode: c.mode, status: ['pending_approval', 'processing'] }), destinations: store.count('banks', { status: 'pending_review' }),
        cashapp_registrations: store.list('merchants', { status: 'approved' }, { limit: 5000 }).map(core.normalizeMerchant).filter(m => m.cashapp.details && !m.cashapp.live.merchant_id).length, kyb: store.list('merchants', { status: 'pending' }).filter(m => m.kyb.submitted).length, alerts: store.count('alerts', { status: 'open' }),
        refunds: store.count('refunds', { mode: c.mode, status: 'pending' }), adjustments: store.count('adjustments', { status: 'pending_approval' }) },
      series, recon_ok: core.reconChecks(c.mode).every(x => x.ok), live_payments: config.livePayments, audit: store.list('audit', {}, { limit: 8 }) };
  });

  /* ---- merchants ---- */
  A('GET', '/merchants', null, (ctx, c) => {
    const q = String(ctx.query.q || '').toLowerCase();
    return store.list('merchants', ctx.query.status ? { status: ctx.query.status } : {}, { limit: 5000 }).filter(m => !q || [m.name, m.legal_name, m.website, m.id, m.support_email].join(' ').toLowerCase().includes(q)).map(m => merchantSummary(m, c.mode));
  });
  A('GET', '/merchants/:id', null, (ctx, c) => {
    const m = core.normalizeMerchant(get('merchants', ctx.params.id));
    return { merchant: m, cashapp: { test: require('./merchant').cashappStatus(m, 'test'), live: require('./merchant').cashappStatus(m, 'live') }, kyb_ready: core.kybReady(m), live_ready: core.liveReady(m), balances: { test: L.merchantBalances(m.id, 'test'), live: L.merchantBalances(m.id, 'live') },
      users: store.list('users', { merchant_id: m.id }).map(auth.publicUser), keys: store.list('api_keys', { merchant_id: m.id }).map(k => ({ id: k.id, mode: k.mode, type: k.type, name: k.name, prefix: k.prefix, last4: k.last4, status: k.status, last_used: k.last_used, created_at: k.created_at })),
      summary: merchantSummary(m, c.mode), webhooks: store.list('webhook_endpoints', { merchant_id: m.id }).map(e => ({ id: e.id, mode: e.mode, url: e.url, status: e.status })) };
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
    const m = core.normalizeMerchant(get('merchants', ctx.params.id)), b = ctx.body, n = (v, label, max = 100) => { v = +v; if (!(v >= 0 && v <= max)) throw bad(`${label} is out of range.`); return v; };
    m.fees = { platPct: n(b.platPct, 'Platform fee %', 20), platFixedUSD: Math.round(n(b.platFixedUSD, 'Fixed platform fee', 10000)), disputeFeeUSD: Math.round(n(b.disputeFeeUSD, 'Dispute fee', 100000)) };
    m.reserve = { pct: n(b.reservePct, 'Reserve %', 50), days: Math.round(n(b.reserveDays, 'Reserve days', 365)) };
    if (b.captureMode) m.captureMode = b.captureMode === 'manual' ? 'manual' : 'auto';
    return saveM(m, c, 'merchant.pricing_update');
  });
  /** Register the merchant with Cash App Pay (Network API brand + merchant) in test or live. */
  A('POST', '/merchants/:id/cashapp/register', 'merchants.manage', async (ctx, c) => {
    const m = core.normalizeMerchant(get('merchants', ctx.params.id)), mode = ctx.body.mode === 'live' ? 'live' : 'test';
    if (ctx.body.details) m.cashapp.details = core.validateDetails(ctx.body.details);
    return require('./merchant').cashappStatus(m, mode, await core.registerCashApp(m, mode, c.actor));
  });
  A('POST', '/merchants/:id/cashapp/details', 'merchants.manage', (ctx, c) => { const m = core.normalizeMerchant(get('merchants', ctx.params.id)); m.cashapp.details = core.validateDetails(ctx.body); return saveM(m, c, 'cashapp.details_update_by_admin'); });
  A('POST', '/merchants/:id/live', 'merchants.live', (ctx, c) => {
    const m = get('merchants', ctx.params.id);
    core.normalizeMerchant(m);
    if (ctx.body.enabled) { if (m.status !== 'approved') throw bad('Approve the merchant first.'); if (!core.cashappReady(m, 'live')) throw bad('Register the merchant with Cash App Pay production (status ACTIVE) first.'); }
    m.live_enabled = !!ctx.body.enabled; return saveM(m, c, 'merchant.live_' + (m.live_enabled ? 'enable' : 'disable'));
  });
  A('POST', '/merchants/:id/hold', 'payouts.approve', (ctx, c) => {
    const m = get('merchants', ctx.params.id);
    if (ctx.body.release) { m.settlementHold = null; return saveM(m, c, 'merchant.hold_release'); }
    const reason = U.str(ctx.body.reason, 300); if (reason.length < 5) throw bad('Give a reason (shown to the merchant).');
    m.settlementHold = { reason, at: Date.now(), by: c.actor }; return saveM(m, c, 'merchant.hold_place', reason);
  });
  A('POST', '/merchants/:id/keys/:key/revoke', 'merchants.controls', (ctx, c) => { const k = get('api_keys', ctx.params.key); if (k.merchant_id !== ctx.params.id) throw bad('Key mismatch.'); k.status = 'revoked'; store.put('api_keys', k); core.audit(c.actor, 'api_key.revoke_by_admin', k.id, '', k.merchant_id); return { ok: true }; });
  A('POST', '/merchants/:id/users/:user/status', 'merchants.manage', (ctx, c) => { const u = get('users', ctx.params.user); if (u.merchant_id !== ctx.params.id) throw bad('User mismatch.'); u.status = ctx.body.active ? 'active' : 'disabled'; store.put('users', u); core.audit(c.actor, 'merchant_user.' + u.status, u.email, '', u.merchant_id); return auth.publicUser(u); });

  /* ---- payments, disputes, refunds ---- */
  A('GET', '/payments', null, (ctx, c) => {
    const q = ctx.query, s = String(q.q || '').toLowerCase();
    let rows = store.list('payments', { mode: c.mode, ...(q.merchant ? { merchant_id: q.merchant } : {}), ...(q.status ? { status: q.status } : {}) }, { limit: 3000 });
    if (q.method) rows = rows.filter(p => p.method === q.method);
    if (s) rows = rows.filter(p => [p.id, p.customer?.email, p.description, p.cashapp?.payment_id, p.cashapp?.request_id].some(x => String(x || '').toLowerCase().includes(s)));
    const names = Object.fromEntries(store.list('merchants', {}, { limit: 10000 }).map(m => [m.id, m.name]));
    return { total: rows.length, data: rows.slice(0, 200).map(p => ({ ...core.publicPayment(p), merchant: p.merchant_id, merchant_name: names[p.merchant_id] })) };
  });
  A('GET', '/payments/:id', null, (ctx, c) => {
    const p = get('payments', ctx.params.id);
    return { payment: core.publicPayment(p), merchant: merchantSummary(get('merchants', p.merchant_id), p.mode), events: p.events, ledger: L.entriesFor(p.id),
      refunds: store.list('refunds', { merchant_id: p.merchant_id }).filter(x => x.payment_id === p.id), dispute: store.list('disputes', { merchant_id: p.merchant_id }).find(d => d.payment_id === p.id) || null, api_logs: store.list('api_logs', { merchant_id: p.merchant_id }, { limit: 300 }).filter(l => l.created_at >= p.created_at - 1000).slice(0, 30),
      provider_events: store.list('provider_events', {}, { limit: 300 }).filter(e => e.payment_id === p.id) };
  });
  A('POST', '/payments/:id/sync', 'payments.manage', async (ctx, c) => { const p = get('payments', ctx.params.id); core.audit(c.actor, 'payment.sync', p.id, '', p.merchant_id); return core.publicPayment(await core.syncPayment(p, { force: true })); });
  A('POST', '/payments/:id/refund', 'payments.manage', async (ctx, c) => core.publicRefund(await core.refund(get('payments', ctx.params.id), ctx.body.amount == null ? null : Number(ctx.body.amount), { actor: c.actor, reason: ctx.body.reason || 'admin' })));
  A('GET', '/disputes', null, (ctx, c) => { const names = Object.fromEntries(store.list('merchants', {}, { limit: 10000 }).map(m => [m.id, m.name])); return store.list('disputes', { mode: c.mode }, { limit: 500 }).map(d => ({ ...core.publicDispute(d), merchant_name: names[d.merchant_id], evidence: d.evidence || [] })); });
  A('POST', '/disputes/:id/:action', 'payments.manage', async (ctx, c) => { const a = ctx.params.action; if (!['accept', 'challenge', 'evidence'].includes(a)) throw bad('Unknown dispute action.'); return core.publicDispute(await core.disputeAction(get('disputes', ctx.params.id), a, ctx.body, c.actor)); });
  A('GET', '/refunds', null, (ctx, c) => store.list('refunds', { mode: c.mode, ...(ctx.query.status ? { status: ctx.query.status } : {}) }, { limit: 500 }));
  /** Record a Cash App settlement (from the Cash App settlement report) so captured payments move from pending to available. */
  A('POST', '/settlements', 'payouts.execute', (ctx, c) => core.recordSettlement({ mode: c.mode, merchantId: ctx.body.merchant || null, before: ctx.body.before ? Date.parse(ctx.body.before) : null, reference: ctx.body.reference }, c.actor));
  A('GET', '/settlements', null, (ctx, c) => { const names = Object.fromEntries(store.list('merchants', {}, { limit: 10000 }).map(m => [m.id, m.name]));
    const pays = store.list('payments', { mode: c.mode }, { limit: 20000 }).filter(p => p.method === 'cashapp');
    return { unsettled: pays.filter(p => !p.settled && ['captured', 'partially_refunded', 'refunded', 'disputed'].includes(p.status)).map(p => ({ id: p.id, merchant_name: names[p.merchant_id], captured_at: p.captured_at, amount: p.amount, net: p.pendingRemaining, currency: p.currency })),
      settled: pays.filter(p => p.settled).slice(0, 200).map(p => ({ id: p.id, merchant_name: names[p.merchant_id], settled_at: p.settled_at, net: p.net, reserve: p.reserve, reference: p.settlement_ref || null })) }; });

  /* ---- payouts & destinations ---- */
  A('GET', '/payouts', null, (ctx, c) => { const names = Object.fromEntries(store.list('merchants', {}, { limit: 10000 }).map(m => [m.id, m.name])); return store.list('payouts', { mode: c.mode, ...(ctx.query.status ? { status: ctx.query.status.split(',') } : {}) }, { limit: 500 }).map(po => ({ ...core.publicPayout(po), merchant: po.merchant_id, merchant_name: names[po.merchant_id], reasons: po.reasons, events: po.events, requested_by: po.actor })); });
  A('POST', '/payouts/:id/approve', 'payouts.approve', (ctx, c) => core.publicPayout(core.approvePayout(get('payouts', ctx.params.id), c.actor)));
  A('POST', '/payouts/:id/reject', 'payouts.approve', (ctx, c) => { const note = U.str(ctx.body.note, 300); if (!note) throw bad('Add a note for the merchant.'); return core.publicPayout(core.rejectPayout(get('payouts', ctx.params.id), c.actor, note)); });
  A('POST', '/payouts/:id/complete', 'payouts.execute', (ctx, c) => core.publicPayout(core.completePayout(get('payouts', ctx.params.id), c.actor, ctx.body.reference)));
  A('GET', '/destinations', null, (ctx, c) => { const names = Object.fromEntries(store.list('merchants', {}, { limit: 10000 }).map(m => [m.id, m.name])); const st = ctx.query.status || 'pending_review';
    return store.list('banks', { status: st }).map(b => ({ ...b, account: undefined, kind: 'bank' })).map(d => ({ ...d, merchant_name: names[d.merchant_id] })); });
  A('POST', '/destinations/:id/decision', 'destinations.review', (ctx, c) => {
    const t = 'banks', d = get(t, ctx.params.id);
    d.status = ctx.body.approve ? 'verified' : 'rejected'; d.reviewed_by = c.actor; d.review_note = U.str(ctx.body.note, 300); store.put(t, d);
    core.audit(c.actor, `${t}.${d.status}`, d.id, d.review_note, d.merchant_id); return { ok: true };
  });
  /* ---- Cash App Pay integration (platform credentials live in the server environment) ---- */
  A('GET', '/cashapp', null, (ctx, c) => ({
    region: config.cashapp.region, live_payments: config.livePayments,
    environments: ['test', 'live'].map(mode => { const cr = mode === 'live' ? config.cashapp.live : config.cashapp.sandbox; return { mode, label: CA.environmentLabel(mode), configured: CA.configured(mode), simulated: CA.simulated(mode),
      client_id: cr.clientId || null, api_key_id: cr.keyId || null, signing_secret: !!cr.keySecret, webhook_secret: !!cr.webhookSecret, base: cr.base || (mode === 'live' ? 'https://api.cash.app' : 'https://sandbox.api.cash.app'),
      webhook_url: `${config.publicUrl}/hooks/cashapp/${mode === 'live' ? 'production' : 'sandbox'}`,
      env_names: mode === 'live' ? ['CASHAPP_CLIENT_ID', 'CASHAPP_API_KEY_ID', 'CASHAPP_API_KEY_SECRET', 'CASHAPP_WEBHOOK_SECRET'] : ['CASHAPP_SANDBOX_CLIENT_ID', 'CASHAPP_SANDBOX_API_KEY_ID', 'CASHAPP_SANDBOX_API_KEY_SECRET', 'CASHAPP_SANDBOX_WEBHOOK_SECRET'],
      merchants_active: store.list('merchants', {}, { limit: 10000 }).map(core.normalizeMerchant).filter(m => core.cashappReady(m, mode)).length }; }),
    logs: store.list('api_logs', { mode: c.mode }, { limit: 100 }),
    events: store.list('provider_events', {}, { limit: 100 }).filter(e => e.provider === 'cashapp'),
  }));
  A('POST', '/cashapp/test-connection', 'platform.settings', async (ctx, c) => {
    const mode = ctx.body.mode === 'live' ? 'live' : 'test', started = Date.now();
    if (!CA.configured(mode) && !CA.simulated(mode)) throw bad('Credentials for this environment are not configured.');
    try { await CA.client(mode).listMerchants({ op: 'test_connection' }); } catch (e) { core.audit(c.actor, 'cashapp.test_connection', mode, 'failed: ' + e.message); throw bad(`Cash App connection failed: ${e.message}`, e.code); }
    core.audit(c.actor, 'cashapp.test_connection', mode, 'ok'); return { ok: true, environment: CA.environmentLabel(mode), ms: Date.now() - started };
  });
  /** Management API: register this platform's webhook URL with Cash App and show the signing secret once. */
  A('POST', '/cashapp/webhook-endpoint', 'platform.settings', async (ctx, c) => {
    const mode = ctx.body.mode === 'live' ? 'live' : 'test', cr = mode === 'live' ? config.cashapp.live : config.cashapp.sandbox;
    if (!CA.configured(mode)) throw bad('Configure Cash App credentials for this environment first.');
    const url = `${config.publicUrl}/hooks/cashapp/${mode === 'live' ? 'production' : 'sandbox'}`;
    const types = ['customer_request.state.updated', 'payment.status.updated', 'refund.status.updated', 'dispute.created', 'dispute.state.updated', 'merchant.status.updated'];
    const ep = await CA.client(mode).createWebhookEndpoint({ idempotency_key: U.id('whe'), webhook_endpoint: { api_key_id: cr.keyId, url, event_configurations: types.map(event_type => ({ event_type, api_version: 'v1' })), reference_id: 'digitalhub' } }, { op: 'create_webhook_endpoint' }).catch(e => { throw bad(`Cash App: ${e.message}`, e.code); });
    core.audit(c.actor, 'cashapp.webhook_endpoint', mode, ep.id);
    return { endpoint: ep, note: 'Copy the API secret Cash App issued for this endpoint into the webhook secret environment variable, then redeploy.' };
  });
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
  A('GET', '/platform', null, () => ({ settings: core.platform(), config: { livePayments: config.livePayments, sandboxDayMs: config.sandboxDayMs, requireStaffMfa: config.requireStaffMfa, publicUrl: config.publicUrl } }));
  A('PATCH', '/platform', 'platform.settings', (ctx, c) => {
    const b = ctx.body, cur = core.platform();
    if (b.approvalThresholdUSD != null) { const v = Math.round(+b.approvalThresholdUSD); if (!(v >= 0)) throw bad('Invalid threshold.'); cur.approvalThresholdUSD = v; }
    if (b.risk) cur.risk = { declineCount: Math.max(1, Math.round(+b.risk.declineCount || 3)), highValueUSD: Math.max(100, Math.round(+b.risk.highValueUSD || 500000)) };
    if (b.defaults) for (const k of Object.keys(cur.defaults)) if (k in b.defaults) { const v = +b.defaults[k]; if (!(v >= 0)) throw bad(`Invalid ${k}.`); cur.defaults[k] = v; }
    core.setPlatform(cur); core.audit(c.actor, 'platform.update', 'platform', Object.keys(b).join(',')); return cur;
  });
  A('POST', '/jobs/run', 'platform.settings', async (ctx, c) => { await core.runCashAppSync(); const out = { test: core.runSettlement('test'), live: core.runSettlement('live') }; core.runExpiry(); core.runDeliveries(); core.audit(c.actor, 'jobs.run', 'jobs', JSON.stringify(out)); return out; });
}

module.exports = { routes };
