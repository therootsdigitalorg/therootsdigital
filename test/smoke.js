'use strict';
/* End-to-end smoke test: boots the server on a throwaway database and drives the public API,
   hosted checkout, merchant dashboard, Super Admin API, webhooks and reconciliation.
   Usage: npm test */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-test-'));
Object.assign(process.env, { DB_PATH: path.join(tmp, 'test.db'), PORT: '0', SEED_DEMO: '1', ADMIN_PASSWORD: 'AdminPass12345', SANDBOX_DAY_MS: '5000', NODE_ENV: 'test', ALLOW_PRIVATE_WEBHOOKS: '1' });
const { server, start } = require('../server/index');
const DigitalHub = require('../sdk/node/digitalhub');

let BASE, passed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; } };
function client(extra = {}) {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'X-Requested-With': 'DigitalHub', ...(cookie ? { cookie } : {}), ...extra, ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.getSetCookie?.() || []; for (const c of sc) if (c.startsWith('dh_session=')) cookie = c.split(';')[0];
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  };
}

(async () => {
  await new Promise(r => { const orig = server.listen.bind(server); server.listen = (port, cb) => orig(0, () => { BASE = `http://127.0.0.1:${server.address().port}`; cb && cb(); r(); }); start(); });
  const creds = fs.readFileSync(path.join(tmp, 'first-run-credentials.txt'), 'utf8');
  const merchantPw = creds.match(/owner@northwind\.test\s+password: (\S+)/)[1], secret = creds.match(/dh_test_sk_\w+/)[0];
  const dh = new DigitalHub(secret, { baseUrl: BASE });
  const pub = client();
  console.log(`\nDigital Hub smoke test on ${BASE}\n`);

  // Local webhook receiver verifying signatures with the SDK
  const received = []; let whSecret = '';
  const receiver = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { try { received.push(DigitalHub.constructEvent(raw, req.headers['digitalhub-signature'], whSecret)); res.end('ok'); } catch { res.statusCode = 400; res.end('bad'); } }); }).listen(0);
  const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

  let session, payment;
  await step('API: register webhook endpoint (secret returned once)', async () => { const ep = await dh.webhookEndpoints.create({ url: hookUrl, enabled_events: ['*'] }); whSecret = ep.secret; assert.match(ep.secret, /^whsec_/); });
  await step('API: create checkout session with Idempotency-Key replay', async () => {
    session = await dh.checkout.create({ amount: 2500, currency: 'USD', description: 'Smoke order', metadata: { order_id: '42' } }, { idempotencyKey: 'smoke-1' });
    const again = await dh.checkout.create({ amount: 2500, currency: 'USD', description: 'Smoke order', metadata: { order_id: '42' } }, { idempotencyKey: 'smoke-1' });
    assert.equal(again.id, session.id);
    await assert.rejects(dh.checkout.create({ amount: 9999, currency: 'USD' }, { idempotencyKey: 'smoke-1' }), /different parameters/);
  });
  await step('Checkout: real card numbers are refused in sandbox', async () => { const r = await pub('POST', `/c-api/sessions/${session.id}/card`, { number: '4111111111111111', exp: '12/34', cvc: '123', name: 'Ann Test', email: 'ann@example.com', country: 'US' }); assert.equal(r.body.error.code, 'test_card_required'); });
  await step('Checkout: 3DS challenge then success', async () => {
    let r = await pub('POST', `/c-api/sessions/${session.id}/card`, { number: '4000000000003220', exp: '12/34', cvc: '123', name: 'Ann Test', email: 'ann@example.com', country: 'GB' });
    assert.equal(r.body.status, 'requires_action');
    r = await pub('POST', `/c-api/sessions/${session.id}/payments/${r.body.id}/3ds`, { code: '123456' });
    assert.equal(r.body.status, 'captured'); payment = r.body;
  });
  await step('Checkout: paid session cannot be paid twice', async () => { const r = await pub('POST', `/c-api/sessions/${session.id}/card`, { number: '4242424242424242', exp: '12/34', cvc: '123', name: 'Ann Test', email: 'ann@example.com', country: 'US' }); assert.equal(r.status, 409); });
  await step('API: session complete, payment captured with fees', async () => { const s = await dh.checkout.retrieve(session.id); assert.equal(s.status, 'complete'); const p = await dh.payments.retrieve(payment.id); assert.equal(p.status, 'captured'); assert.ok(p.net < p.amount); });
  await step('Crypto: sandbox USDT via Binance Pay route confirms after webhook-equivalent events', async () => {
    const s = await dh.checkout.create({ amount: 5000, currency: 'USD', description: 'Crypto order' });
    let r = await pub('POST', `/c-api/sessions/${s.id}/crypto`, { asset: 'USDT', network: 'BINANCE_PAY', name: 'Bo Test', email: 'bo@example.com', country: 'AE' });
    assert.equal(r.body.status, 'awaiting_payment');
    r = await pub('POST', `/c-api/sessions/${s.id}/payments/${r.body.id}/simulate`, { kind: 'exact' });
    assert.equal(r.body.status, 'confirming');
    require('../server/core').runSandboxConfirmations();
    const p = await dh.payments.retrieve(r.body.id); assert.equal(p.status, 'confirmed');
  });
  await step('Hooks: forged provider webhooks are rejected', async () => { const r = await pub('POST', '/hooks/coinbase', { event: {} }, { 'X-CC-Webhook-Signature': 'deadbeef' }); assert.equal(r.status, 400); });
  await step('API: partial refund', async () => { const rf = await dh.refunds.create({ payment: payment.id, amount: 1000, reason: 'requested_by_customer' }); assert.equal(rf.status, 'succeeded'); assert.equal((await dh.payments.retrieve(payment.id)).amount_refunded, 1000); });
  await step('API: payment link redirects to a fresh checkout', async () => { const l = await dh.paymentLinks.create({ amount: 1500, currency: 'EUR', description: 'Link test', reusable: true }); const r = await pub('GET', new URL(l.url).pathname); assert.equal(r.status, 303); assert.match(r.headers.get('location'), /^\/pay\/cs_/); });
  await step('Webhooks: signed deliveries reach the merchant endpoint', async () => { await require('../server/core').runDeliveries(); assert.ok(received.some(e => e.type === 'checkout.session.completed'), 'no checkout.session.completed'); assert.ok(received.every(e => e.id?.startsWith('evt_'))); });
  await step('API: invalid key and tenant isolation', async () => {
    const r = await pub('GET', '/v1/payments', null, { Authorization: 'Bearer dh_test_sk_' + 'x'.repeat(40) }); assert.equal(r.status, 401);
    const core = require('../server/core'), store = require('../server/db');
    const indus = store.list('merchants', {}).find(x => x.name === 'Indus Crafts');
    const s2 = core.createSession(indus, 'test', { amount: 900, currency: 'USD', description: 'Other tenant' }, 'test');
    const foreign = core.cardPay(s2, { number: '4242424242424242', exp: '12/34', cvc: '123', name: 'Cy Test', email: 'cy@example.com', country: 'US' });
    const r2 = await pub('GET', '/v1/payments/' + foreign.id, null, { Authorization: 'Bearer ' + secret }); assert.equal(r2.status, 404, 'cross-tenant read must 404');
    const r3 = await pub('GET', '/v1/checkout/sessions/' + s2.id, null, { Authorization: 'Bearer ' + secret }); assert.equal(r3.status, 404);
  });

  const m = client();
  await step('Merchant: sign in, CSRF header enforced, overview loads', async () => {
    const bad = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(bad.status, 403);
    assert.equal((await m('POST', '/auth/login', { email: 'owner@northwind.test', password: 'wrong-password-1' })).status, 401);
    assert.equal((await m('POST', '/auth/login', { email: 'owner@northwind.test', password: merchantPw })).status, 200);
    const o = await m('GET', '/m-api/overview'); assert.ok(o.body.count > 0); assert.ok(o.body.onboarding.length >= 8);
  });
  await step('Merchant: create restricted key (secret shown once, stored hashed)', async () => { const r = await m('POST', '/m-api/keys', { name: 'Woo', scopes: ['checkout:write', 'payments:read'] }); assert.match(r.body.secret, /^dh_test_sk_/); const row = require('../server/db').byKey('api_keys', require('../server/util').sha256(r.body.secret)); assert.ok(row && !JSON.stringify(row).includes(r.body.secret)); });
  await step('Merchant: live keys blocked until go-live', async () => { const r = await m('POST', '/m-api/keys', { name: 'Live' }, { 'X-DH-Mode': 'live' }); assert.equal(r.status, 400); });
  let po;
  await step('Merchant: stablecoin payout needs admin approval', async () => {
    const dest = (await m('GET', '/m-api/destinations')).body.wallets.find(w => w.status === 'verified');
    const bal = (await m('GET', '/m-api/balances')).body.balances.USDT;
    const res = await m('POST', '/m-api/payouts', { currency: 'USDT', amount: Math.min(bal.available, 6000), destination: dest.id, idempotency_key: 'po-1' }); po = res.body; if (res.status !== 200) throw new Error(JSON.stringify(res.body) + ' bal=' + JSON.stringify(bal));
    assert.equal(po.status, 'pending_approval');
  });

  const a = client();
  await step('Admin: sign in and see queues', async () => { assert.equal((await a('POST', '/auth/login', { email: 'admin@digitalhub.local', password: 'AdminPass12345' })).status, 200); const o = await a('GET', '/a-api/overview'); assert.ok(o.body.queues.payouts >= 1); });
  await step('Admin: merchants cannot reach admin API', async () => { assert.equal((await m('GET', '/a-api/overview')).status, 403); });
  await step('Admin: approve payout → completed in test mode', async () => { const r = await a('POST', `/a-api/payouts/${po.id}/approve`); assert.equal(r.body.status, 'completed'); });
  await step('Admin: KYB approval blocked until checks + KYC + AML complete', async () => {
    const indus = (await a('GET', '/a-api/merchants?q=Indus')).body[0];
    assert.equal((await a('POST', `/a-api/merchants/${indus.id}/status`, { status: 'approved' })).status, 400);
    for (const check of ['registration', 'website', 'bank']) await a('POST', `/a-api/merchants/${indus.id}/kyb`, { check, value: true });
    await a('POST', `/a-api/merchants/${indus.id}/kyb`, { owner: 0, idStatus: 'verified' }); await a('POST', `/a-api/merchants/${indus.id}/kyb`, { owner: 1, idStatus: 'verified' });
    await a('POST', `/a-api/merchants/${indus.id}/kyb`, { aml: true });
    assert.equal((await a('POST', `/a-api/merchants/${indus.id}/status`, { status: 'approved' })).body.status, 'approved');
  });
  await step('Admin: non-3DS requires an acquirer reference', async () => { const nw = (await a('GET', '/a-api/merchants?q=Northwind')).body[0]; assert.equal((await a('POST', `/a-api/merchants/${nw.id}/non3ds`, { ref: 'x' })).status, 400); assert.equal((await a('POST', `/a-api/merchants/${nw.id}/non3ds`, { ref: 'ACQ-N3DS-2026-0001', scope: 'test' })).status, 200); });
  await step('Admin: maker-checker blocks self-approval of adjustments', async () => { const nw = (await a('GET', '/a-api/merchants?q=Northwind')).body[0]; const adj = (await a('POST', '/a-api/adjustments', { merchant: nw.id, mode: 'test', currency: 'USD', amount: 500, reason: 'Smoke test goodwill credit' })).body; assert.equal((await a('POST', `/a-api/adjustments/${adj.id}/approve`)).status, 400); });
  await step('Ledger: every reconciliation check passes', async () => { const l = await a('GET', '/a-api/ledger'); for (const c of l.body.checks) assert.ok(c.ok, c.name); assert.ok(l.body.trial_balance.every(t => t.debits === t.credits)); });
  await step('Ledger: database refuses edits to posted entries', async () => { assert.throws(() => require('../server/db').db.exec('UPDATE ledger SET amount = 0 WHERE id = 1'), /append-only/); });
  await step('Downloads: WooCommerce plugin zip', async () => { const r = await fetch(BASE + '/downloads/digitalhub-woocommerce.zip'); assert.equal(r.status, 200); const b = Buffer.from(await r.arrayBuffer()); assert.equal(b.readUInt32LE(0), 0x04034b50); });

  console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}.`);
  receiver.close(); server.close(); setTimeout(() => process.exit(), 100);
})().catch(e => { console.error(e); process.exit(1); });
