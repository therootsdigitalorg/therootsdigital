'use strict';
/* End-to-end test of the single-business platform (default mode): mandatory 2FA, retired multi-merchant areas,
   Authorize.Net credentials (sealed, never returned), Accept Hosted card checkout, server-side verification (a return
   redirect alone never marks anything paid), signed webhooks, auth-only + capture, void, refunds, disputes, settled-batch
   sync, bank reconciliation, manual USD→USDC conversion, USDC payout verified on (fake) Base Sepolia, WooCommerce API
   aliases and outgoing webhooks, reports, backup, readiness gates and secret hygiene.
   Runs against local fakes only (test/fake-anet.js, test/fake-chain.js): no real network, card or funds.
   Usage: npm test */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { fakeAnet } = require('./fake-anet');
const { fakeChain, wallet } = require('./fake-chain');

const LOGIN = 'TestLogin42', TKEY = 'Abcd1234Efgh5678', SIGKEY = 'AB12'.repeat(32);
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const anetFake = fakeAnet({ loginId: LOGIN, transactionKey: TKEY });
const sepolia = fakeChain({ chainId: 84532, usdc: SEPOLIA_USDC });

let BASE, passed = 0, failed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.error('  ✗', name, '\n   ', String(e.message).slice(0, 3000), '\n   ', e.stack?.split('\n').find(l => l.includes('console.js'))); process.exitCode = 1; } };
const seen = []; // every response body, scanned for secrets at the end
function client(extra = {}) {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'X-Requested-With': 'DigitalHub', ...(cookie ? { cookie } : {}), ...extra, ...headers }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('dh_session=')) cookie = c.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer()), text = buf.toString('utf8'); seen.push(text);
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers, buf };
  };
}
const ok = (r, msg = '') => { if (r.status !== 200) throw new Error(`${msg} HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await sleep(200); } }

(async () => {
  const [anetUrl, sepUrl] = [await anetFake.listen(), await sepolia.listen()];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-console-'));
  Object.assign(process.env, { MULTI_MERCHANT: '0', DB_PATH: path.join(tmp, 'test.db'), PORT: '0', SEED_DEMO: '1', ADMIN_PASSWORD: 'AdminPass12345', NODE_ENV: 'test', ALLOW_PRIVATE_WEBHOOKS: '1',
    BASE_SEPOLIA_RPC_URLS: sepUrl, CHAIN_POLL_MS: '3600000',
    ANET_SANDBOX_API_URL: anetUrl + '/xml/v1/request.api', ANET_SANDBOX_HOSTED_URL: anetUrl + '/payment/payment', ANET_SANDBOX_REST_URL: anetUrl + '/rest/v1',
    SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SECRET_KEY: '', SUPABASE_JWKS_URL: '', SUPABASE_JWKS: '' });
  for (const k of ['REQUIRE_STAFF_MFA', 'ANET_SANDBOX_LOGIN_ID', 'ANET_PRODUCTION_LOGIN_ID', 'INFURA_API_KEY', 'LIVE_PAYMENTS']) delete process.env[k];
  const { server, start } = require('../server/index');
  const store = require('../server/db'), U = require('../server/util'), L = require('../server/ledger'), auth = require('../server/auth'), DigitalHub = require('../sdk/node/digitalhub');
  await new Promise(r => { const orig = server.listen.bind(server); server.listen = (port, cb) => orig(0, () => { BASE = `http://127.0.0.1:${server.address().port}`; cb && cb(); r(); }); start(); });
  const a = client(), pub = client();
  const X = (method, p, body) => a(method, '/api/v1/admin' + p, body);
  let mfaSecret = ''; const code = () => U.totp(mfaSecret);
  console.log(`\nDIGITAL HUB single-business test on ${BASE} (fake Authorize.Net ${anetUrl}, fake Base Sepolia ${sepUrl})\n`);

  await step('Single-business mode: product name, signup closed, no demo merchants, one business record', async () => {
    const m = ok(await pub('GET', '/api/mode')); assert.equal(m.multi_merchant, false); assert.match(m.product, /DIGITAL HUB/);
    assert.equal((await pub('POST', '/auth/signup', { business_name: 'X Shop', country: 'US', email: 'x@shop.test', password: 'Passw0rd1234' })).status, 404);
    const ms = store.list('merchants', {}); assert.equal(ms.length, 1); assert.equal(ms[0].business, true); assert.equal(store.getMeta('business').merchant_id, ms[0].id);
    assert.ok(store.getMeta('migration:single_business'), 'migration record kept');
  });
  await step('2FA is mandatory: console refused until the admin enrolls; then it opens', async () => {
    ok(await a('POST', '/auth/login', { email: 'admin@digitalhub.local', password: 'AdminPass12345' }));
    const me = ok(await a('GET', '/auth/me')); assert.equal(me.config.requireStaffMfa, true); assert.equal(me.config.multiMerchant, false);
    const r = await X('GET', '/overview'); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'mfa_enrollment_required');
    mfaSecret = ok(await a('POST', '/auth/mfa/setup')).secret;
    assert.equal((await a('POST', '/auth/mfa/enable', { code: '000000' })).status, 400);
    ok(await a('POST', '/auth/mfa/enable', { code: code() }));
    const o = ok(await X('GET', '/overview')); assert.equal(o.integrations.authorize_net.configured, false); assert.equal(o.live.cards, false);
    const fresh = client(); const l = ok(await fresh('POST', '/auth/login', { email: 'admin@digitalhub.local', password: 'AdminPass12345' })); assert.equal(l.mfa_required, true);
    assert.equal((await fresh('GET', '/api/v1/admin/overview')).status, 401, 'password alone is not enough');
    ok(await fresh('POST', '/auth/mfa', { code: code() })); ok(await fresh('GET', '/api/v1/admin/overview'));
  });
  await step('Retired areas: merchant login refused, merchant API and legacy merchant admin pages gone; history untouched', async () => {
    const core = require('../server/core');
    const old = core.newMerchant({ name: 'Old Merchant', legal_name: 'Old', country: 'US', website: '', support_email: 'o@old.test' }); old.status = 'approved'; store.put('merchants', old);
    auth.createUser({ email: 'owner@old.test', name: 'Old', password: 'OldPassw0rd123', kind: 'merchant', role: 'owner', merchant_id: old.id });
    const r = await pub('POST', '/auth/login', { email: 'owner@old.test', password: 'OldPassw0rd123' }); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'merchant_login_retired');
    assert.equal((await a('GET', '/m-api/overview')).status, 404);
    assert.equal((await a('GET', '/a-api/merchants')).status, 404); assert.equal((await a('GET', '/a-api/payouts')).status, 404);
    ok(await a('GET', '/a-api/chain'), 'Infura & blockchain admin stays'); ok(await a('GET', '/a-api/audit'));
    const key = require('./../server/routes/merchant').issueKey(old, 'test', { name: 'old', scopes: ['*'] }, 'test');
    const r2 = await fetch(BASE + '/v1/checkout/sessions', { method: 'POST', headers: { authorization: 'Bearer ' + key.secret, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 1000, currency: 'USD' }) });
    assert.equal(r2.status, 403); assert.equal((await r2.json()).error.code, 'merchant_retired');
    assert.equal(store.get('merchants', old.id).status, 'approved', 'record not modified');
  });

  let wh = { secret: '', got: [] }, sk = '';
  const receiver = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { try { wh.got.push(DigitalHub.constructEvent(raw, req.headers['digitalhub-signature'], wh.secret)); res.end('ok'); } catch { res.statusCode = 400; res.end('bad'); } }); }).listen(0);
  const storeUrl = `http://127.0.0.1:${receiver.address().port}`;
  const woo = (method, p, body) => fetch(BASE + p, { method, headers: { authorization: 'Bearer ' + sk, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));

  await step('Without Authorize.Net credentials no checkout is possible (no fake success)', async () => {
    const c = ok(await X('POST', '/woocommerce/connect', { store_url: storeUrl })); sk = c.plugin_settings.secret_key; wh.secret = c.plugin_settings.webhook_secret;
    assert.match(sk, /^dh_test_sk_/); assert.equal(c.webhook_url, storeUrl + '/wc-api/digitalhub/');
    const r = await woo('POST', '/api/v1/woocommerce/checkout', { amount: 2500, currency: 'USD' }); assert.equal(r.status, 400); assert.equal(r.body.error.code, 'no_payment_method'); assert.match(r.body.error.message, /sandbox credentials are not configured/);
  });
  await step('Authorize.Net credentials: format-checked, need a 2FA code, sealed at rest, never returned; test connection', async () => {
    assert.equal((await X('POST', '/authorize-net/sandbox', { login_id: LOGIN, transaction_key: TKEY, signature_key: SIGKEY })).body.error.code, 'invalid_code');
    assert.equal((await X('POST', '/authorize-net/sandbox', { login_id: LOGIN, transaction_key: 'short', code: code() })).status, 400);
    const cfg = ok(await X('POST', '/authorize-net/sandbox', { login_id: LOGIN, transaction_key: TKEY, signature_key: SIGKEY, code: code() }));
    assert.equal(cfg.environments.sandbox.configured, true); assert.equal(cfg.environments.sandbox.signature_key, true); assert.ok(!JSON.stringify(cfg).includes(TKEY));
    const raw = JSON.stringify(store.getMeta('anet')); assert.ok(!raw.includes(TKEY) && !raw.includes(SIGKEY), 'sealed in the database');
    const t = ok(await X('POST', '/authorize-net/sandbox/test')); assert.equal(t.ok, true);
    const g = ok(await X('GET', '/authorize-net')); assert.equal(g.environments.sandbox.last_test.ok, true); const PU = require('../server/config').publicUrl; assert.equal(g.webhook_url, PU + '/api/v1/webhooks/authorize-net');
    const w = ok(await X('POST', '/authorize-net/sandbox/webhook')); assert.equal(w.url, PU + '/api/v1/webhooks/authorize-net');
    assert.equal(anetFake.st.webhooks.length, 1); assert.ok(anetFake.st.webhooks[0].eventTypes.includes('net.authorize.payment.authcapture.created'));
  });

  const startCheckout = async (amount, extra = {}) => {
    const s = (await woo('POST', '/api/v1/woocommerce/checkout', { amount, currency: 'USD', description: 'Order #' + amount, metadata: { order_id: String(amount) }, ...extra })).body;
    assert.deepEqual(s.payment_methods, ['card']);
    const st = ok(await pub('POST', `/c-api/sessions/${s.id}/anet/start`, { name: 'Jane Buyer', email: 'jane@example.com', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', country: 'US' }));
    return { s, st };
  };
  let paid;
  await step('Checkout: customer details only; card typed on the Authorize.Net hosted page; token posted there (CSP allows it)', async () => {
    assert.equal((await woo('POST', '/api/v1/woocommerce/checkout', { amount: 2500, currency: 'EUR' })).status, 400);
    const s = (await woo('POST', '/api/v1/woocommerce/checkout', { amount: 4999, currency: 'USD', description: 'Order 1001', metadata: { order_id: '1001' } })).body;
    const v = ok(await pub('GET', '/c-api/sessions/' + s.id)); assert.deepEqual(v.methods, ['card']); assert.equal(v.card.provider, 'authorize_net'); assert.equal(v.card.hosted, true); assert.deepEqual(v.card.test_cards, []);
    assert.equal((await pub('POST', `/c-api/sessions/${s.id}/anet/start`, { name: 'Jane Buyer', email: 'nope' })).status, 400);
    const st = ok(await pub('POST', `/c-api/sessions/${s.id}/anet/start`, { name: 'Jane Buyer', email: 'jane@example.com', zip: '78701', number: '4111111111111111', cvc: '123' }));
    assert.equal(st.form.action, anetUrl + '/payment/payment'); assert.ok(st.form.token.length > 20); assert.equal(st.payment.status, 'created');
    const p = store.get('payments', st.payment.id); assert.ok(!JSON.stringify(p).includes('4111111111111111') && !JSON.stringify(p).includes('"123"'), 'no card data stored'); assert.ok(p.anet.invoice.length <= 20);
    const csp = (await fetch(BASE + '/pay/' + s.id)).headers.get('content-security-policy'); assert.match(csp, /form-action 'self' [^;]*127\.0\.0\.1/);
    paid = { s, st };
  });
  await step('Return redirect alone changes nothing; the server lookup after a real payment captures it', async () => {
    const { s, st } = paid;
    let v = ok(await pub('GET', `/c-api/sessions/${s.id}?return=1`)); assert.equal(v.status, 'open'); assert.equal(v.payment.status, 'created');
    anetFake.pay(st.form.token, { card: '4111111111111111' });
    v = ok(await pub('GET', `/c-api/sessions/${s.id}?return=1`)); assert.equal(v.status, 'complete'); assert.equal(v.payment.status, 'captured');
    assert.equal(v.payment.card.last4, '1111'); assert.equal(v.payment.card.brand, 'Visa'); assert.ok(v.payment.trans_id);
    const p = store.get('payments', st.payment.id); assert.equal(p.settlement_status, 'pending');
    const led = L.entriesFor(p.id); assert.deepEqual(led.map(x => [x.account, x.amount]).sort(), [['acquirer_receivable', 4999], ['business_sales', -4999]]);
    const cus = ok(await X('GET', '/customers')).data; assert.equal(cus[0].email, 'jane@example.com'); assert.equal(cus[0].total, 4999);
    const ps = (await woo('GET', '/api/v1/woocommerce/payment-status?order_id=1001')).body; assert.equal(ps.paid, true); assert.deepEqual(ps.statuses, { card: 'captured', usd_settlement: 'pending', conversion: 'not_requested', usdc_payout: 'not_initiated' });
    await until(() => wh.got.some(e => e.type === 'checkout.session.completed' && e.data.object.id === s.id)); assert.ok(wh.got.some(e => e.type === 'payment.succeeded'));
  });
  await step('Amount mismatch is held for review, never completed', async () => {
    const { s, st } = await startCheckout(3000);
    anetFake.pay(st.form.token, { amountCents: 100 });
    const v = ok(await pub('GET', `/c-api/sessions/${s.id}?return=1`)); assert.equal(v.status, 'open'); assert.equal(v.payment.status, 'pending');
    assert.ok(store.list('alerts', {}).some(x => x.kind === 'card_amount_mismatch'));
  });
  let declined;
  await step('Webhooks: bad signature refused; signed webhook applies a decline via server lookup; duplicates ignored', async () => {
    const { s, st } = await startCheckout(3100); const t = anetFake.pay(st.form.token, { outcome: 'decline' });
    const url = BASE + '/api/v1/webhooks/authorize-net';
    assert.equal((await anetFake.webhook(url, SIGKEY, 'net.authorize.payment.authcapture.created', t.transId, { badSignature: true })).status, 401);
    assert.equal(store.get('payments', st.payment.id).status, 'created');
    const nid = 'n-' + Date.now();
    assert.equal((await anetFake.webhook(url, SIGKEY, 'net.authorize.payment.authcapture.created', t.transId, { notificationId: nid })).status, 200);
    assert.equal(store.get('payments', st.payment.id).status, 'declined');
    const dup = await anetFake.webhook(url, SIGKEY, 'net.authorize.payment.authcapture.created', t.transId, { notificationId: nid }); assert.equal(dup.body.duplicate, true);
    const v = ok(await pub('GET', '/c-api/sessions/' + s.id)); assert.equal(v.status, 'open', 'customer can try again');
    ok(await pub('POST', `/c-api/sessions/${s.id}/anet/start`, { name: 'Jane Buyer', email: 'jane@example.com' }), 'retry after decline');
    declined = st.payment.id;
    const logs = ok(await X('GET', '/webhook-logs')); assert.ok(logs.inbound.some(e => e.status === 'rejected')); assert.ok(logs.inbound.some(e => e.status === 'processed' && e.payment === declined));
  });
  await step('Auth-only flow: authorization emits payment.authorized; admin captures; void releases another', async () => {
    ok(await X('POST', '/settings/flow', { flow: 'authOnly' }));
    const one = await startCheckout(5000); anetFake.pay(one.st.form.token);
    let v = ok(await pub('GET', `/c-api/sessions/${one.s.id}?return=1`)); assert.equal(v.payment.status, 'authorized'); assert.equal(v.status, 'open');
    await until(() => wh.got.some(e => e.type === 'payment.authorized'));
    const c = ok(await X('POST', `/transactions/${one.st.payment.id}/capture`, {})); assert.equal(c.statuses.card, 'captured');
    assert.equal(ok(await pub('GET', '/c-api/sessions/' + one.s.id)).status, 'complete');
    const two = await startCheckout(5100); anetFake.pay(two.st.form.token); ok(await pub('GET', `/c-api/sessions/${two.s.id}?return=1`));
    const vd = ok(await X('POST', `/transactions/${two.st.payment.id}/void`, {})); assert.equal(vd.statuses.card, 'voided');
    assert.equal(L.entriesFor(two.st.payment.id).length, 0, 'nothing booked for an uncaptured authorization');
    ok(await X('POST', '/settings/flow', { flow: 'authCapture' }));
  });
  let toVoid;
  await step('Refund before settlement = full void (ledger reversed); partial refund before settlement refused', async () => {
    const { s, st } = await startCheckout(2200); anetFake.pay(st.form.token); ok(await pub('GET', `/c-api/sessions/${s.id}?return=1`));
    assert.equal((await X('POST', `/transactions/${st.payment.id}/refund`, { amount: '5.00' })).body.error.code, 'not_settled');
    const r = ok(await X('POST', `/transactions/${st.payment.id}/refund`, {})); assert.equal(r.voided, true); assert.equal(r.payment.statuses.card, 'voided');
    const sum = L.entriesFor(st.payment.id).reduce((t, x) => t + (x.account === 'acquirer_receivable' ? x.amount : 0), 0); assert.equal(sum, 0);
    toVoid = st.payment.id;
  });
  let batch, uss;
  await step('Settlement: batch sync matches transactions; USD settled; bank reconciliation with fee note', async () => {
    batch = anetFake.settle();
    const out = ok(await X('POST', '/settlements/sync', {})); assert.equal(out.created, 1);
    const S = ok(await X('GET', '/settlements')); uss = S.settlements[0];
    assert.equal(uss.status, 'settled'); assert.equal(uss.net, 4999 + 5000 + 100); assert.equal(uss.payments.length, 2); assert.equal(uss.unmatched.length, 1, 'the held amount-mismatch charge is not treated as a Digital Hub sale');
    assert.equal(store.get('payments', paid.st.payment.id).settlement_status, 'settled');
    assert.equal(ok(await X('POST', '/settlements/sync', {})).created, 0, 'idempotent');
    assert.equal((await X('POST', `/settlements/${uss.id}/reconcile`, { bank_amount: '99.00', reference: 'DEP-1' })).body.error.code, 'note_required');
    const rec = ok(await X('POST', `/settlements/${uss.id}/reconcile`, { bank_amount: '99.00', bank_date: '2026-11-12', reference: 'DEP-1', note: 'Processor fees withheld' }));
    assert.equal(rec.status, 'reconciled'); assert.equal(rec.bank.difference, 199);
    const sm = ok(await X('GET', '/settlements')).summary; assert.equal(sm.bank, 9900); assert.equal(sm.bank_clearing, 0);
    const csv = await a('GET', '/api/v1/admin/reports/transactions.csv'); assert.match(csv.buf.toString(), /reconciled/);
  });
  await step('Refunds after settlement go through the API (last 4 + XXXX); external refund via webhook booked once', async () => {
    const r = ok(await X('POST', `/transactions/${paid.st.payment.id}/refund`, { amount: '10.00', reason: 'damaged' })); assert.equal(r.voided, false); assert.equal(r.refund.status, 'succeeded'); assert.equal(r.payment.statuses.card, 'partially_refunded');
    const t = anetFake.add({ type: 'refundTransaction', status: 'refundPendingSettlement', invoice: '', authAmount: 500, settleAmount: 500, refTransId: store.get('payments', paid.st.payment.id).anet.transId, last4: '1111', brand: 'Visa' });
    const url = BASE + '/api/v1/webhooks/authorize-net';
    ok(await anetFake.webhook(url, SIGKEY, 'net.authorize.payment.refund.created', t.transId)); ok(await anetFake.webhook(url, SIGKEY, 'net.authorize.payment.refund.created', t.transId));
    const p = store.get('payments', paid.st.payment.id); assert.equal(p.refunded, 1500);
    const rf = ok(await X('GET', '/refunds')).refunds; assert.equal(rf.length, 2);
    const d = ok(await X('POST', `/transactions/${paid.st.payment.id}/dispute`, { amount: '20.00', reason: 'fraud', reference: 'CB-77' })); assert.equal(d.status, 'open');
    ok(await X('POST', `/disputes/${d.id}/resolve`, { won: true, note: 'evidence accepted' }));
    assert.equal(store.get('payments', paid.st.payment.id).status, 'partially_refunded');
  });
  let conv, po, bizWallet;
  await step('Conversion (Mode A manual): pending → processing (USD sent) → completed (USDC obtained); Mode B refused', async () => {
    assert.equal((await X('POST', '/settlement-mode', { mode: 'B', provider: 'bridge', code: code() })).body.error.code, 'provider_not_integrated');
    assert.equal((await pub('POST', '/api/v1/webhooks/settlement-provider', { any: 1 })).status, 501);
    conv = ok(await X('POST', '/conversions', { settlement_ids: [uss.id], venue: 'Exchange account' })); assert.equal(conv.status, 'pending'); assert.equal(conv.usd_amount, 9900);
    assert.equal((await X('POST', '/conversions', { settlement_ids: [uss.id] })).status, 400, 'one conversion per settlement');
    assert.equal((await X('POST', `/conversions/${conv.id}/completed`, { usdc_amount: '99' })).status, 400, 'must be processing first');
    ok(await X('POST', `/conversions/${conv.id}/processing`, { reference: 'WIRE-55' }));
    conv = ok(await X('POST', `/conversions/${conv.id}/completed`, { usdc_amount: '98.50', reference: 'TRADE-9' })); assert.equal(conv.usdc_amount, 9850);
    assert.equal(ok(await X('GET', '/settlements')).settlements[0].conversion_status, 'completed');
  });
  await step('Crypto wallet: MetaMask signature proves ownership (no keys asked); approval needs address suffix + 2FA code', async () => {
    assert.equal((await X('POST', '/payouts', { conversion_id: conv.id })).body.error.code, 'wallet_required');
    bizWallet = wallet();
    const w = ok(await X('POST', '/wallet', { address: bizWallet.address, label: 'Treasury MetaMask' }));
    const ch = ok(await X('POST', `/wallet/${w.id}/challenge`)); assert.match(ch.message, /does not move funds/);
    assert.equal((await X('POST', `/wallet/${w.id}/verify`, { signature: wallet().sign(ch.message) })).body.error.code, 'signature_mismatch');
    const v = ok(await X('POST', `/wallet/${w.id}/verify`, { signature: bizWallet.sign(ch.message) })); assert.equal(v.status, 'verified');
    assert.equal((await X('POST', `/wallet/${w.id}/approve`, { confirm: '000000', code: code() })).body.error.code, 'confirm_mismatch');
    assert.equal((await X('POST', `/wallet/${w.id}/approve`, { confirm: bizWallet.address.slice(-6) })).body.error.code, 'invalid_code');
    assert.equal(ok(await X('POST', `/wallet/${w.id}/approve`, { confirm: bizWallet.address.slice(-6), code: code() })).status, 'approved');
    const g = ok(await X('GET', '/wallet')); assert.equal(g.wallets[0].receiving_test, true); assert.match(g.note, /never asks for or stores private keys/);
  });
  await step('USDC payout: tx hash verified on Base Sepolia (token, recipient, exact amount, finality); wrong amount fails; replay blocked', async () => {
    po = ok(await X('POST', '/payouts', { conversion_id: conv.id, amount: '98.00', note: 'after withdrawal fee' })); assert.equal(po.status, 'pending'); assert.equal(po.recipient, bizWallet.address);
    const exchange = wallet();
    const wrong = sepolia.transfer({ from: exchange.address, to: bizWallet.address, value: '97000000' }); sepolia.mine(10);
    let r = ok(await X('POST', `/payouts/${po.id}/tx`, { hash: wrong })); assert.equal(r.status, 'failed'); assert.match(r.result.reason, /does not match/);
    po = ok(await X('POST', '/payouts', { conversion_id: conv.id, amount: '98.00' }));
    const other = sepolia.transfer({ from: exchange.address, to: wallet().address, value: '98000000' }); sepolia.mine(10);
    r = ok(await X('POST', `/payouts/${po.id}/tx`, { hash: other })); assert.equal(r.status, 'failed'); assert.match(r.result.reason, /not to the expected wallet/);
    po = ok(await X('POST', '/payouts', { conversion_id: conv.id, amount: '98.00' }));
    const good = sepolia.transfer({ from: exchange.address, to: bizWallet.address, value: '98000000' });
    r = ok(await X('POST', `/payouts/${po.id}/tx`, { hash: good })); assert.equal(r.status, 'submitted'); assert.ok(['confirming', 'pending'].includes(r.result.state));
    sepolia.mine(10); r = ok(await X('POST', `/payouts/${po.id}/check`)); assert.equal(r.status, 'confirmed'); assert.ok(r.explorer.includes(good));
    const po2 = await X('POST', '/payouts', { conversion_id: conv.id }); assert.equal(po2.status, 400, 'one confirmed payout per conversion');
    const sm = ok(await X('GET', '/settlements')); assert.equal(sm.settlements[0].payout_status, 'confirmed'); assert.equal(sm.summary.usdc_wallet, 9800); assert.equal(sm.summary.usdc_in_transit, 50);
    const p = store.get('payments', paid.st.payment.id); const stx = require('../server/cards').statuses(p);
    assert.deepEqual(stx, { card: 'partially_refunded', usd_settlement: 'reconciled', conversion: 'completed', usdc_payout: 'confirmed' });
  });
  await step('Ledger balances per currency; database refuses edits', async () => {
    for (const r of L.trialBalance('test')) assert.equal(r.debits, r.credits, r.currency);
    assert.throws(() => store.db.prepare('UPDATE ledger SET amount=1').run(), /append-only/);
  });
  await step('Production readiness: live cards and payouts stay off until every check passes', async () => {
    const r = ok(await X('GET', '/readiness')); assert.equal(r.ready_cards, false); assert.ok(r.checks.find(c => c.key === 'sandbox_flow').ok); assert.ok(r.checks.find(c => c.key === 'mfa').ok);
    assert.equal((await X('POST', '/readiness', { cards_live: true, code: code() })).body.error.code, 'not_ready');
    const live = await woo('POST', '/api/v1/woocommerce/checkout', { amount: 1000, currency: 'USD' }); assert.equal(live.status, 200, 'test key still works');
  });
  await step('Payment links (card only), reports, CSV, security log, backup download (gzipped, complete)', async () => {
    const l = ok(await X('POST', '/links', { amount: '15.00', description: 'Consulting hour', reusable: true })); assert.deepEqual(l.payment_methods, ['card']);
    const go = await pub('GET', new URL(l.url).pathname); assert.equal(go.status, 303);
    const rep = ok(await X('GET', '/reports')); assert.ok(rep.totals.captured >= 4999 + 5000); assert.ok(rep.by_status.captured >= 1);
    const sec = ok(await X('GET', '/security')); assert.ok(sec.audit.some(x => x.action === 'authorize_net.credentials_saved')); assert.equal(sec.policy.mfa, 'mandatory');
    const b = await a('GET', '/api/v1/admin/backup'); assert.equal(b.status, 200); const dump = JSON.parse(zlib.gunzipSync(b.buf).toString());
    assert.equal(dump.format, 'digitalhub-backup'); assert.ok(dump.tables.payments.length >= 6); assert.ok(dump.ledger.length > 10); assert.ok(!dump.tables.sessions);
    assert.ok(ok(await X('GET', '/settings')).backup.at);
    for (const p of ['/overview', '/transactions', `/transactions/${paid.st.payment.id}`, '/authorize-net', '/customers', '/links', '/woocommerce', '/settlements', '/wallet', '/payouts', '/webhook-logs', '/reports', '/security', '/settings', '/readiness']) ok(await X('GET', p), p);
  });
  await step('Adopt an existing store record as the business (keeps its keys); needs 2FA code', async () => {
    const old = store.list('merchants', {}).find(m => m.name === 'Old Merchant');
    const st = ok(await X('GET', '/settings')); assert.ok(st.adopt_candidates.some(c => c.id === old.id));
    assert.equal((await X('POST', '/settings/adopt', { merchant_id: old.id })).body.error.code, 'invalid_code');
    const prev = store.getMeta('business').merchant_id;
    ok(await X('POST', '/settings/adopt', { merchant_id: old.id, code: code() })); assert.equal(store.getMeta('business').merchant_id, old.id);
    ok(await X('POST', '/settings/adopt', { merchant_id: prev, code: code() })); assert.equal(store.getMeta('business').merchant_id, prev);
  });
  await step('WooCommerce plugin: "Digital Hub Payments", card only, no USDC/MetaMask wording', async () => {
    const r = await fetch(BASE + '/downloads/digitalhub-woocommerce.zip'); const b = Buffer.from(await r.arrayBuffer()).toString('latin1');
    assert.match(b, /Plugin Name:\s+Digital Hub Payments\n/); assert.match(b, /'payment_methods' => \['card'\]/); assert.ok(!/MetaMask|USDC/.test(b));
  });
  await step('Secrets never appear in any API response', async () => {
    const all = seen.join('\n'); for (const s of [TKEY, SIGKEY, LOGIN]) assert.ok(!all.includes(s), 'leaked ' + s.slice(0, 4));
  });

  console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}.`);
  receiver.close(); anetFake.server.close(); sepolia.server.close(); server.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
