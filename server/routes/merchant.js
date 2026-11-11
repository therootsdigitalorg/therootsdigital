'use strict';
/* Merchant dashboard API — /m-api. Session-authenticated; every query is scoped to the
   signed-in user's merchant and the selected mode (X-DH-Mode: test | live). */
const config = require('../config');
const store = require('../db');
const L = require('../ledger');
const U = require('../util');
const core = require('../core');
const P = require('../providers');
const auth = require('../auth');
const api = require('./api');
const usdc = require('../usdc');
const C = require('../chain');
const E = require('../evm');
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
    { key: 'wallet', label: 'Receiving wallet verified with MetaMask', done: !!usdc.receivingWallet(m, 'test'), detail: 'Receiving wallet → add your Base address and sign the ownership message.' },
    { key: 'test_payment', label: 'Complete a Base Sepolia test payment', done: store.list('payments', { merchant_id: m.id, mode: 'test', status: core.PAID }, { limit: 1 }).length > 0, detail: 'Open a payment link and pay with test USDC from MetaMask (faucet.circle.com).' },
    { key: 'wallet_live', label: 'Wallet approved by Digital Hub compliance', done: store.list('merchant_wallets', { merchant_id: m.id, status: 'approved' }, { limit: 1 }).length > 0, detail: 'Required before Base Mainnet payments.' },
    { key: 'live', label: 'Live mode activated', done: !core.liveReady(m), detail: core.liveReady(m) || 'Live payments enabled.' },
  ];
}

function routes(r) {
  const M = (method, path, perm, fn) => r(method, '/m-api' + path, async ctx => {
    const a = auth.requireUser(ctx, 'merchant'); auth.needMerchant(a.user, perm);
    const m = store.get('merchants', a.user.merchant_id); if (!m) throw new HttpError(404, 'not_found', 'Merchant missing');
    const mode = ctx.headers['x-dh-mode'] === 'live' ? 'live' : 'test';
    return fn(ctx, { user: a.user, m, mode, actor: a.user.email });
  });
  const mine = (table, idv, c, modeScoped = true) => { const o = store.get(table, idv); if (!o || o.merchant_id !== c.m.id || (modeScoped && o.mode !== c.mode)) throw new HttpError(404, 'not_found', 'Not found'); return o; };

  M('GET', '/overview', 'read', (ctx, c) => {
    const pays = store.list('payments', { merchant_id: c.m.id, mode: c.mode, since: Date.now() - 30 * DAY }, { limit: 5000 });
    const ok = pays.filter(p => core.PAID.includes(p.status)), tried = pays.filter(p => !['created', 'awaiting_payment', 'requires_action'].includes(p.status));
    const usd = p => U.toUSD(p.method === 'card' ? p.amount : (p.creditedAmount ?? p.crypto?.received ?? 0), p.method === 'card' ? p.currency : p.crypto.asset);
    const series = []; const end = new Date(); end.setHours(23, 59, 59, 999);
    for (let i = 13; i >= 0; i--) { const e = end.getTime() - i * DAY, s = e - DAY; const day = ok.filter(p => p.created_at > s && p.created_at <= e); series.push({ label: new Date(e).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), card: day.filter(p => p.method === 'card').reduce((t, p) => t + usd(p), 0), crypto: day.filter(p => p.method !== 'card').reduce((t, p) => t + usd(p), 0) }); }
    const balances = L.merchantBalances(c.m.id, c.mode);
    const attention = [
      ...store.list('payments', { merchant_id: c.m.id, mode: c.mode, status: ['authorized', 'underpaid', 'overpaid', 'wrong_network'] }, { limit: 20 }).map(p => ({ payment: p.id, status: p.status, amount: p.amount, currency: p.currency })),
      ...store.list('disputes', { merchant_id: c.m.id, mode: c.mode, status: 'needs_response' }, { limit: 20 }).map(d => ({ payment: d.payment_id, status: 'dispute', amount: d.amount, currency: d.currency })),
    ];
    const w = usdc.receivingWallet(c.m, c.mode);
    return { direct: usdc.directBalances(c.m.id, c.mode), wallet: w ? usdc.publicWallet(w) : null, in_flight: pays.filter(p => usdc.ACTIVE.includes(p.status)).length,
      network: C.walletParams(C.networkFor(c.mode)), gross_usd: ok.reduce((t, p) => t + usd(p), 0), count: ok.length, attempts: tried.length, fees_usd: ok.reduce((t, p) => t + (p.fees ? U.toUSD(p.fees.provider + p.fees.platform, p.method === 'card' ? p.currency : p.crypto.asset) : 0), 0),
      available_usd: Object.entries(balances).reduce((t, [cur, b]) => t + U.toUSD(b.available, cur), 0), balances, series, attention,
      recent: store.list('payments', { merchant_id: c.m.id, mode: c.mode }, { limit: 8 }).map(core.publicPayment), onboarding: onboarding(c.m), live_ready: core.liveReady(c.m) };
  });

  /* ---- payments ---- */
  M('GET', '/payments', 'read', (ctx, c) => {
    const q = ctx.query, s = String(q.q || '').toLowerCase();
    let rows = store.list('payments', { merchant_id: c.m.id, mode: c.mode, ...(q.status ? { status: q.status } : {}) }, { limit: 2000 });
    if (q.method) rows = rows.filter(p => p.method === q.method);
    if (s) rows = rows.filter(p => [p.id, p.customer?.email, p.customer?.name, p.card?.last4, p.description, p.metadata && JSON.stringify(p.metadata)].some(x => String(x || '').toLowerCase().includes(s)));
    return { total: rows.length, data: rows.slice(+q.offset || 0, (+q.offset || 0) + 50).map(core.publicPayment) };
  });
  M('GET', '/payments/:id', 'read', async (ctx, c) => {
    const p = await usdc.refreshPayment(mine('payments', ctx.params.id, c));
    return { payment: core.publicPayment(p), events: p.events, risk: p.risk || null, three_ds: p.card?.threeDS || null, crypto: p.crypto ? { ...p.crypto, tradeNo: undefined } : null,
      ledger: L.entriesFor(p.id), refunds: store.list('refunds', { merchant_id: c.m.id }).filter(x => x.payment_id === p.id).map(r => r.network ? usdc.publicRefund(r) : core.publicRefund(r)),
      dispute: store.list('disputes', { merchant_id: c.m.id }).find(d => d.payment_id === p.id) || null, refundable: usdc.refundable(p),
      explorer: p.crypto?.chain_id ? C.NETWORKS[p.crypto.network].explorer : null,
      webhooks: store.list('events', { merchant_id: c.m.id, mode: c.mode }, { limit: 300 }).filter(e => e.data.object.id === p.id).map(e => ({ id: e.id, type: e.type, created: e.created_at })) };
  });
  M('POST', '/payments/:id/capture', 'payments', (ctx, c) => core.publicPayment(core.capture(mine('payments', ctx.params.id, c), c.actor)));
  M('POST', '/payments/:id/cancel', 'payments', (ctx, c) => core.publicPayment(core.cancel(mine('payments', ctx.params.id, c), c.actor)));
  M('POST', '/payments/:id/refund', 'refunds', async (ctx, c) => {
    const p = mine('payments', ctx.params.id, c), b = ctx.body;
    const out = await core.idempotent(c.m.id, c.mode, b.idempotency_key, U.sha256(JSON.stringify([p.id, b.amount, b.address, b.network])), async () => ({ status: 200, body: p.method === 'usdc'
      ? usdc.publicRefund(await usdc.createRefund(p, b.amount == null || b.amount === '' ? null : Number(b.amount), { actor: c.actor, reason: b.reason, address: U.str(b.address, 120) || null }))
      : core.publicRefund(core.refund(p, b.amount == null ? null : Number(b.amount), { actor: c.actor, reason: b.reason, address: U.str(b.address, 120), network: b.network })) }));
    return { ...out.body, replayed: !!out.replay };
  });
  M('POST', '/payments/:id/accept-partial', 'payments', (ctx, c) => core.publicPayment(usdc.acceptPartial(mine('payments', ctx.params.id, c), c.actor)));
  M('POST', '/payments/:id/check', 'read', async (ctx, c) => core.publicPayment(await usdc.refreshPayment(mine('payments', ctx.params.id, c), { force: true })));

  /* ---- USDC refunds (sent by the merchant from the receiving wallet with MetaMask) ---- */
  const refundOut = r => ({ ...usdc.publicRefund(r), events: r.events || [], action: r.status === 'requires_action' ? usdc.refundAction(r) : null, last_error: r.last_error || null, explorer: r.tx?.hash ? C.explorerTx(r.network, r.tx.hash) : null });
  M('GET', '/refunds', 'read', (ctx, c) => store.list('refunds', { merchant_id: c.m.id, mode: c.mode }, { limit: 300 }).map(r => r.network ? refundOut(r) : core.publicRefund(r)));
  M('GET', '/refunds/:id', 'read', async (ctx, c) => refundOut(await usdc.refreshRefund(mine('refunds', ctx.params.id, c))));
  M('POST', '/refunds/:id/tx', 'refunds', async (ctx, c) => refundOut(await usdc.submitRefundTx(mine('refunds', ctx.params.id, c), String(ctx.body.hash || ''), c.actor)));
  M('POST', '/refunds/:id/cancel', 'refunds', (ctx, c) => refundOut(usdc.cancelRefund(mine('refunds', ctx.params.id, c), c.actor)));

  /* ---- receiving wallets (shared by test and live; ownership proven by signature) ---- */
  M('GET', '/wallets', 'read', (ctx, c) => ({ wallets: store.list('merchant_wallets', { merchant_id: c.m.id }, { limit: 100 }).filter(w => w.status !== 'disabled').map(usdc.publicWallet), receiving: c.m.receiving || {},
    chain: C.walletParams(C.networkFor(c.mode)), mode: c.mode }));
  M('POST', '/wallets', 'settings', (ctx, c) => usdc.publicWallet(usdc.addWallet(c.m, ctx.body, c.actor)));
  M('POST', '/wallets/:id/challenge', 'settings', (ctx, c) => usdc.walletChallenge(c.m, mine('merchant_wallets', ctx.params.id, c, false), c.mode, c.actor));
  M('POST', '/wallets/:id/verify', 'settings', (ctx, c) => usdc.publicWallet(usdc.verifyWalletSignature(c.m, mine('merchant_wallets', ctx.params.id, c, false), String(ctx.body.signature || ''), { actor: c.actor, ip: ctx.ip })));
  M('POST', '/wallets/:id/receiving', 'settings', (ctx, c) => { usdc.setReceiving(c.m, mine('merchant_wallets', ctx.params.id, c, false), ctx.body.mode === 'live' ? 'live' : 'test', c.actor); return { ok: true }; });
  M('DELETE', '/wallets/:id', 'settings', (ctx, c) => usdc.publicWallet(usdc.removeWallet(c.m, mine('merchant_wallets', ctx.params.id, c, false), c.actor)));

  /* ---- platform fee statements (merchant pays Digital Hub's fee from MetaMask; verified on-chain) ---- */
  M('GET', '/settlements', 'read', (ctx, c) => { const fw = C.settings().feeWallet, key = C.networkFor(c.mode);
    return { fee_wallet: fw, chain: C.walletParams(key), fees_due: usdc.feeDue(c.m.id, c.mode),
      statements: store.list('settlements', { merchant_id: c.m.id, mode: c.mode }, { limit: 200 }).map(s => ({ ...s, explorer: s.tx?.hash ? C.explorerTx(key, s.tx.hash) : null,
        action: s.status === 'open' && fw ? { token: C.net(key).usdc, to: fw, amount_units: s.amountUnits, data: E.transferData(fw, s.amountUnits) } : null })) }; });
  M('POST', '/settlements/:id/tx', 'payouts', async (ctx, c) => usdc.submitSettlementTx(mine('settlements', ctx.params.id, c), String(ctx.body.hash || ''), c.actor));
  M('POST', '/payments/:id/simulate-dispute', 'payments', (ctx, c) => core.openDispute(mine('payments', ctx.params.id, c), U.str(ctx.body.reason, 40) || 'fraudulent', c.actor));
  M('POST', '/disputes/:id/evidence', 'payments', (ctx, c) => { const d = mine('disputes', ctx.params.id, c); const t = U.str(ctx.body.text, 4000); if (t.length < 20) throw bad('Describe your evidence (20+ characters).'); if (d.status !== 'needs_response') throw bad('Evidence already submitted.'); Object.assign(d, { status: 'under_review', evidence: t, evidence_at: Date.now() }); store.put('disputes', d); core.audit(c.actor, 'dispute.evidence', d.id, '', c.m.id); return d; });

  /* ---- subscriptions ---- */
  const SUB = require('../subscriptions');
  M('GET', '/subscriptions', 'read', (ctx, c) => store.list('subscriptions', { merchant_id: c.m.id, mode: c.mode }, { limit: 500 }).map(SUB.publicSubscription));
  M('GET', '/subscriptions/:id', 'read', (ctx, c) => { const s = mine('subscriptions', ctx.params.id, c); return { ...SUB.publicSubscription(s), events: s.events, invoices: s.invoices }; });
  M('POST', '/subscriptions', 'payments', (ctx, c) => SUB.publicSubscription(SUB.create(c.m, c.mode, ctx.body, c.actor)));
  M('POST', '/subscriptions/:id/update', 'payments', (ctx, c) => SUB.publicSubscription(SUB.update(mine('subscriptions', ctx.params.id, c), ctx.body, c.actor)));
  M('POST', '/subscriptions/:id/cancel', 'payments', (ctx, c) => SUB.publicSubscription(SUB.cancel(mine('subscriptions', ctx.params.id, c), c.actor)));
  M('POST', '/subscriptions/:id/bill-now', 'payments', (ctx, c) => { if (c.mode !== 'test') throw bad('Billing ahead of schedule is available in test mode only.'); const s = mine('subscriptions', ctx.params.id, c); s.next_at = Date.now(); store.put('subscriptions', s); return SUB.publicSubscription(SUB.bill(s)); });

  /* ---- payment links ---- */
  M('GET', '/links', 'read', (ctx, c) => store.list('links', { merchant_id: c.m.id, mode: c.mode }).map(l => ({ ...core.publicLink(l), status: core.linkActive(l) ? 'active' : (l.status === 'active' ? 'expired' : l.status), paid: l.payments.length })));
  M('POST', '/links', 'payments', (ctx, c) => core.publicLink(core.createLink(c.m, c.mode, ctx.body, c.actor)));
  M('POST', '/links/:id/status', 'payments', (ctx, c) => { const l = mine('links', ctx.params.id, c); l.status = ctx.body.active ? 'active' : 'deactivated'; store.put('links', l); core.audit(c.actor, 'payment_link.' + l.status, l.id, '', c.m.id); return core.publicLink(l); });

  /* ---- balances & payouts ---- */
  M('GET', '/balances', 'read', (ctx, c) => ({ direct: usdc.directBalances(c.m.id, c.mode), balances: L.merchantBalances(c.m.id, c.mode), payouts: store.list('payouts', { merchant_id: c.m.id, mode: c.mode }, { limit: 100 }).map(po => ({ ...core.publicPayout(po), events: po.events, reasons: po.reasons })), hold: c.m.settlementHold, min_payout: c.m.minPayout }));
  M('POST', '/payouts/quote', 'payouts', (ctx, c) => { const q = core.payoutQuote(c.m, c.mode, String(ctx.body.currency || '').toUpperCase(), Number(ctx.body.amount), ctx.body.destination); return { ...q, dest: undefined, available: L.balance(c.m.id, c.mode, L.ACCT.M_AVAIL, q.sourceCur) }; });
  M('POST', '/payouts', 'payouts', async (ctx, c) => {
    if (c.mode === 'live' && !c.user.mfa_enabled) throw new HttpError(403, 'mfa_required', 'Enable two-factor authentication before requesting live payouts.');
    const b = ctx.body;
    const out = await core.idempotent(c.m.id, c.mode, b.idempotency_key, U.sha256(JSON.stringify([b.currency, b.amount, b.destination])), () => ({ status: 200, body: core.publicPayout(core.requestPayout(c.m, c.mode, { currency: b.currency, amount: Number(b.amount), destination: b.destination }, c.actor)) }));
    return { ...out.body, replayed: !!out.replay };
  });

  /* ---- payout destinations (shared by test and live) ---- */
  M('GET', '/destinations', 'read', (ctx, c) => ({ wallets: store.list('wallets', { merchant_id: c.m.id }), banks: store.list('banks', { merchant_id: c.m.id }).map(b => ({ ...b, account: undefined })), networks: P.NETWORKS }));
  M('POST', '/wallets', 'payouts', (ctx, c) => {
    const asset = String(ctx.body.asset || '').toUpperCase(), network = String(ctx.body.network || '').toUpperCase(), address = U.str(ctx.body.address, 120);
    if (!P.NETWORKS[network]?.assets.includes(asset)) throw bad(`${asset} is not supported on that network.`);
    if (!P.validAddress(network, address)) throw bad(`That ${network === 'BINANCE_PAY' ? 'Binance Pay ID' : 'address'} is not valid for ${P.NETWORKS[network].label}.`);
    if (store.list('wallets', { merchant_id: c.m.id }).some(w => w.address === address && w.network === network)) throw bad('This wallet is already on file.');
    const w = store.put('wallets', { id: U.id('wal'), merchant_id: c.m.id, status: 'pending_review', asset, network, address, label: U.str(ctx.body.label, 60) || `${asset} wallet`, ownership_attested: !!ctx.body.attest });
    core.audit(c.actor, 'wallet.add', w.id, `${asset}/${network}`, c.m.id); return w;
  });
  M('POST', '/banks', 'payouts', (ctx, c) => {
    const currency = String(ctx.body.currency || '').toUpperCase(), acct = String(ctx.body.account || '').replace(/\s/g, '').toUpperCase(), holder = U.str(ctx.body.holder, 120);
    if (!U.FIAT.includes(currency)) throw bad('Choose a currency.');
    if (currency === 'PKR' ? !/^PK\d{2}[A-Z]{4}\d{16}$/.test(acct) : !/^[A-Z0-9]{6,34}$/.test(acct)) throw bad(currency === 'PKR' ? 'Enter a valid Pakistani IBAN (PK + 22 characters).' : 'Enter a valid IBAN or account number.');
    if (holder.toLowerCase() !== String(c.m.legal_name).toLowerCase()) throw bad('Account holder must match your legal business name.');
    const b = store.put('banks', { id: U.id('bnk'), merchant_id: c.m.id, status: 'pending_review', currency, bank_name: U.str(ctx.body.bank_name, 100), holder, last4: acct.slice(-4), account: U.seal(acct), routing: U.str(ctx.body.routing, 40), rail: currency === 'PKR' ? 'Raast · Soneri Bank' : '' });
    core.audit(c.actor, 'bank.add', b.id, currency, c.m.id); return { ...b, account: undefined };
  });
  M('DELETE', '/destinations/:id', 'payouts', (ctx, c) => { const t = ctx.params.id.startsWith('wal_') ? 'wallets' : 'banks'; const d = mine(t, ctx.params.id, c, false); store.del(t, d.id); core.audit(c.actor, t + '.remove', d.id, '', c.m.id); return { ok: true }; });

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

  /* ---- verification documents (KYB / KYC) ---- */
  const DOCS = require('../documents');
  M('GET', '/documents', 'read', (ctx, c) => ({ ...DOCS.requirements(c.m), types: Object.entries(DOCS.TYPES).map(([k, t]) => ({ type: k, ...t })), owners: c.m.kyb.owners.map((o, i) => ({ index: i, name: o.name })), max_bytes: DOCS.MAX_BYTES }));
  M('POST', '/documents', 'settings', (ctx, c) => DOCS.publicDoc(DOCS.upload(c.m, ctx.body, c.actor)));
  M('GET', '/documents/:id/file', 'read', (ctx, c) => { const d = mine('documents', ctx.params.id, c, false); if (!d.data) throw new HttpError(404, 'not_found', 'File deleted.'); return { ...DOCS.file(d), inline: ctx.query.inline === '1', private: true }; });
  M('DELETE', '/documents/:id', 'settings', (ctx, c) => DOCS.publicDoc(DOCS.remove(mine('documents', ctx.params.id, c, false), c.actor)));

  /* ---- go live ---- */
  M('GET', '/onboarding', 'read', (ctx, c) => ({ steps: onboarding(c.m), kyb: c.m.kyb, status: c.m.status, providers: c.m.providers, provider_info: P.PROVIDER_INFO, live_ready: core.liveReady(c.m), non3ds: c.m.non3ds,
    requests: store.list('provider_requests', { merchant_id: c.m.id }) }));
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
  M('POST', '/provider-requests', 'settings', (ctx, c) => {
    const provider = String(ctx.body.provider || ''), type = ctx.body.type === 'non3ds' ? 'non3ds' : 'connection';
    if (!P.PROVIDER_INFO.some(p => p.id === provider)) throw bad('Unknown provider.');
    if (type === 'non3ds' && provider !== 'card_acquirer') throw bad('Non-3DS is requested from the card acquirer.');
    if (store.list('provider_requests', { merchant_id: c.m.id, status: ['requested', 'submitted'] }).some(x => x.provider === provider && x.type === type)) throw bad('A request is already open.');
    const use = U.str(ctx.body.use_case, 500); if (use.length < 10) throw bad('Describe your use case (10+ characters).');
    const req = store.put('provider_requests', { id: U.id('preq'), merchant_id: c.m.id, status: 'requested', provider, type, use_case: use, monthly_volume_usd: Math.max(0, +ctx.body.monthly_volume_usd || 0), events: [{ at: Date.now(), status: 'requested', by: c.actor }] });
    if (type === 'connection') { c.m.providers[provider] = 'requested'; store.put('merchants', c.m); }
    core.audit(c.actor, 'provider_request.create', req.id, `${provider} ${type}`, c.m.id); return req;
  });

  /* ---- settings & team ---- */
  M('PATCH', '/settings', 'settings', (ctx, c) => {
    const b = ctx.body, m = c.m;
    if (b.name !== undefined) m.name = U.str(b.name, 120) || m.name;
    if (b.support_email !== undefined) { if (b.support_email && !U.isEmail(b.support_email)) throw bad('Support email is invalid.'); m.support_email = b.support_email; }
    if (b.website !== undefined) m.website = U.str(b.website, 200);
    if (b.captureMode) m.captureMode = b.captureMode === 'manual' ? 'manual' : 'auto';
    if (b.threeDS) {
      const mode = b.threeDS.mode === 'risk' ? 'risk' : 'always';
      if (mode === 'risk' && !core.non3dsAuthorized(m)) throw bad('Risk-based 3DS needs acquirer authorization for non-3DS.');
      m.threeDS = { mode, riskThreshold: Math.min(90, Math.max(10, +b.threeDS.riskThreshold || 45)), lowValueExemption: !!b.threeDS.lowValueExemption };
    }
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
  /* No simulated payments: test mode is the real Base Sepolia testnet. */
}

module.exports = { routes, issueKey, publicKey, ensurePublishable, onboarding };
