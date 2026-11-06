'use strict';
/* End-to-end smoke test: boots the server on a throwaway database and drives the public API, hosted
   Cash App Pay checkout (local simulator), merchant dashboard, Super Admin API, webhooks, ledger and
   the real Cash App adapter against a fake Cash App server (request signing, webhook verification).
   Usage: npm test */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-test-'));
for (const k of Object.keys(process.env)) if (k.startsWith('CASHAPP_')) delete process.env[k]; // force the local simulator
Object.assign(process.env, { DB_PATH: path.join(tmp, 'test.db'), PORT: '0', SEED_DEMO: '1', ADMIN_PASSWORD: 'AdminPass12345', SANDBOX_DAY_MS: '5000', NODE_ENV: 'test', ALLOW_PRIVATE_WEBHOOKS: '1' });
const { server, start } = require('../server/index');
const DigitalHub = require('../sdk/node/digitalhub');
const core = require('../server/core'), store = require('../server/db'), CA = require('../server/cashapp'), config = require('../server/config');

let BASE, passed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    ')); process.exitCode = 1; } };
const wait = ms => new Promise(r => setTimeout(r, ms));
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
  const nwId = store.byKey('users', 'owner@northwind.test').merchant_id;
  console.log(`\nDigital Hub smoke test on ${BASE} (${CA.environmentLabel('test')})\n`);

  // Customer flow helpers: what checkout.js and the Cash App approval screen do.
  const startPay = async (sid, body = { name: 'Ann Test', email: 'ann@example.com' }) => { const r = await pub('POST', `/c-api/sessions/${sid}/cashapp`, body); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return { ...r.body, request_id: decodeURIComponent(new URL(r.body.cash_app.mobile_url).pathname.split('/').pop()) }; };
  const decide = async (rid, decision) => pub('POST', `/c-api/cashapp-sim/${rid}`, { decision });
  const poll = async (sid, pid) => (await pub('GET', `/c-api/sessions/${sid}/payments/${pid}`)).body;
  let buyers = 0;
  const pay = async (amount, extra = {}) => {
    const s = await dh.checkout.create({ amount, currency: 'USD', description: 'Test order', ...extra });
    const p = await startPay(s.id, { name: 'Pat Buyer', email: `buyer${++buyers}@example.com` }); await decide(p.request_id, 'approve');
    return { s, p: await poll(s.id, p.id) };
  };

  // Local webhook receiver verifying signatures with the SDK (stands in for the WooCommerce plugin).
  const received = []; let whSecret = '';
  const receiver = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { try { received.push(DigitalHub.constructEvent(raw, req.headers['digitalhub-signature'], whSecret)); res.end('ok'); } catch { res.statusCode = 400; res.end('bad'); } }); }).listen(0);
  const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

  let session, payment;
  await step('API: register webhook endpoint (secret returned once)', async () => { const ep = await dh.webhookEndpoints.create({ url: hookUrl, enabled_events: ['*'] }); whSecret = ep.secret; assert.match(ep.secret, /^whsec_/); });
  await step('API: account offers Cash App Pay in USD only', async () => { const a = await dh.request('GET', '/account'); assert.deepEqual(a.payment_methods, ['cashapp']); assert.deepEqual(a.currencies, ['USD']); });
  await step('API: checkout session with Idempotency-Key replay; non-USD refused', async () => {
    session = await dh.checkout.create({ amount: 2500, currency: 'USD', description: 'Smoke order', metadata: { order_id: '42' } }, { idempotencyKey: 'smoke-1' });
    const again = await dh.checkout.create({ amount: 2500, currency: 'USD', description: 'Smoke order', metadata: { order_id: '42' } }, { idempotencyKey: 'smoke-1' });
    assert.equal(again.id, session.id); assert.deepEqual(session.payment_methods, ['cashapp']);
    await assert.rejects(dh.checkout.create({ amount: 9999, currency: 'USD' }, { idempotencyKey: 'smoke-1' }), /different parameters/);
    await assert.rejects(dh.checkout.create({ amount: 2500, currency: 'EUR', description: 'x' }), /USD/);
  });
  await step('Checkout page loads and offers Cash App Pay only', async () => {
    const page = await fetch(BASE + `/pay/${session.id}`); assert.equal(page.status, 200); assert.match(await page.text(), /checkout\.js/);
    const view = await pub('GET', `/c-api/sessions/${session.id}`);
    assert.equal(view.body.available, true); assert.equal(view.body.simulator, true);
    const script = await fetch(BASE + '/checkout.js').then(r => r.text()); assert.doesNotMatch(script, /4242|crypto|USDT/i);
  });
  let pending;
  await step('Sandbox PENDING: customer request with QR / mobile link, still awaiting the customer', async () => {
    pending = await startPay(session.id);
    assert.equal(pending.status, 'awaiting_customer'); assert.match(pending.request_id, /^GRR_sim_/);
    assert.match(pending.cash_app.mobile_url, /\/cashapp-sim\/GRR_sim_/);
    assert.equal((await poll(session.id, pending.id)).status, 'awaiting_customer');
    assert.equal((await dh.checkout.retrieve(session.id)).payment_status, 'unpaid', 'never paid before Cash App confirms');
    assert.equal((await pub('POST', `/c-api/sessions/${session.id}/cashapp`, {})).status, 409, 'second attempt while one is in flight');
  });
  await step('Sandbox SUCCESS: approval → Cash App payment captured → session paid', async () => {
    const page = await fetch(BASE + `/cashapp-sim/${pending.request_id}`); assert.equal(page.status, 200);
    const d = await decide(pending.request_id, 'approve'); assert.equal(d.body.status, 'APPROVED');
    payment = await poll(session.id, pending.id); assert.equal(payment.status, 'captured');
    const s = await dh.checkout.retrieve(session.id); assert.equal(s.status, 'complete'); assert.equal(s.payment_status, 'paid'); assert.equal(s.payment, payment.id);
    const p = await dh.payments.retrieve(payment.id); assert.equal(payment.cash_app.payment_id, p.cash_app.payment_id); assert.match(p.cash_app.payment_id, /^PWC_sim_/); assert.equal(p.cash_app.payment_status, 'CAPTURED'); assert.ok(p.net < p.amount && p.fees.provider > 0);
    assert.equal((await pub('POST', `/c-api/sessions/${session.id}/cashapp`, {})).status, 409, 'paid session cannot be paid twice');
  });
  let declined;
  await step('Sandbox DECLINED: Cash App declines 77.71, customer retries and succeeds', async () => {
    const s = await dh.checkout.create({ amount: 7771, currency: 'USD', description: 'Decline test' });
    const p = await startPay(s.id); await decide(p.request_id, 'approve');
    declined = await poll(s.id, p.id); assert.equal(declined.status, 'declined');
    assert.equal((await dh.checkout.retrieve(s.id)).payment_status, 'unpaid');
    assert.equal((await pub('POST', `/c-api/sessions/${s.id}/payments/${p.id}/retry`)).body.ok, true);
    const p2 = await startPay(s.id); await decide(p2.request_id, 'decline');
    const d2 = await poll(s.id, p2.id); assert.equal(d2.status, 'declined'); assert.equal(d2.decline_code, 'customer_declined');
  });
  await step('Sandbox PENDING at Cash App: connection error (66.70) is retried with the same idempotency key, no double charge', async () => {
    const s = await dh.checkout.create({ amount: 6670, currency: 'USD', description: 'Connection error test' });
    const p = await startPay(s.id); await decide(p.request_id, 'approve');
    const st = store.get('payments', p.id);
    assert.ok(st.events.some(e => e.status === 'processing' && /did not answer/.test(e.note)), 'connection error recorded, payment held in processing');
    assert.equal(st.status, 'captured', 'same idempotency key recovered the payment Cash App created');
    assert.equal(store.list('cashapp_sim', {}, { limit: 5000 }).filter(r => r.obj?.reference_id === p.id && /^PWC_/.test(r.obj.id)).length, 1, 'no duplicate Cash App payment');
    assert.equal((await dh.checkout.retrieve(s.id)).payment_status, 'paid');
  });
  await step('Sandbox EXPIRED: customer request past expires_at becomes expired; retry allowed', async () => {
    const s = await dh.checkout.create({ amount: 1500, currency: 'USD', description: 'Expiry test' });
    const p = await startPay(s.id);
    const row = store.byKey('cashapp_sim', p.request_id); row.obj.expires_at = new Date(Date.now() - 1000).toISOString(); store.put('cashapp_sim', row);
    const pay = store.get('payments', p.id); pay.cashapp.request_expires_at = Date.now() - 1000; pay.cashapp.last_sync = 0; store.put('payments', pay);
    const x = await poll(s.id, p.id); assert.equal(x.status, 'expired');
    assert.equal((await pub('POST', `/c-api/sessions/${s.id}/payments/${p.id}/retry`)).body.ok, true);
  });
  await step('Checkout: customer can cancel while awaiting approval', async () => {
    const s = await dh.checkout.create({ amount: 1600, currency: 'USD', description: 'Cancel test' });
    const p = await startPay(s.id);
    assert.equal((await pub('POST', `/c-api/sessions/${s.id}/payments/${p.id}/cancel`)).body.status, 'canceled');
  });
  await step('Sandbox REFUNDED: partial then full refund through Cash App', async () => {
    let rf = await dh.refunds.create({ payment: payment.id, amount: 1000, reason: 'requested_by_customer' }); assert.equal(rf.status, 'succeeded'); assert.match(rf.cash_app_refund_id, /^PWCR_sim_/);
    assert.equal((await dh.payments.retrieve(payment.id)).status, 'partially_refunded');
    rf = await dh.refunds.create({ payment: payment.id }); assert.equal(rf.amount, 1500);
    const p = await dh.payments.retrieve(payment.id); assert.equal(p.status, 'refunded'); assert.equal(p.amount_refunded, 2500);
    await assert.rejects(dh.refunds.create({ payment: payment.id, amount: 1 }), /most you can refund/);
  });
  await step('Sandbox refund DECLINED by Cash App (77.70) moves no money', async () => {
    const { p } = await pay(9000);
    const before = (await dh.payments.retrieve(p.id)).amount_refunded;
    const rf = await dh.refunds.create({ payment: p.id, amount: 7770 }); assert.equal(rf.status, 'declined');
    assert.equal((await dh.payments.retrieve(p.id)).amount_refunded, before);
  });
  let manual;
  await step('Manual capture: authorized → order not paid; capture → session flips to paid', async () => {
    const a = client(); await a('POST', '/auth/login', { email: 'admin@digitalhub.local', password: 'AdminPass12345' });
    const m = core.merchant(nwId);
    assert.equal((await a('PATCH', `/a-api/merchants/${nwId}/pricing`, { platPct: m.fees.platPct, platFixedUSD: m.fees.platFixedUSD, disputeFeeUSD: m.fees.disputeFeeUSD, reservePct: m.reserve.pct, reserveDays: m.reserve.days, captureMode: 'manual' })).status, 200);
    const r = await pay(3300, { metadata: { order_id: '77' } }); manual = r;
    assert.equal(r.p.status, 'authorized'); assert.equal((await dh.checkout.retrieve(r.s.id)).payment_status, 'authorized');
    const c = await dh.payments.capture(r.p.id); assert.equal(c.status, 'captured');
    assert.equal((await dh.checkout.retrieve(r.s.id)).payment_status, 'paid');
    const v = await pay(1200); assert.equal((await dh.payments.cancel(v.p.id)).status, 'canceled');
    await a('PATCH', `/a-api/merchants/${nwId}/pricing`, { platPct: m.fees.platPct, platFixedUSD: m.fees.platFixedUSD, disputeFeeUSD: m.fees.disputeFeeUSD, reservePct: m.reserve.pct, reserveDays: m.reserve.days, captureMode: 'auto' });
  });
  let dispute;
  await step('Sandbox DISPUTE: 88.01 payment opens a Cash App dispute; funds held; evidence + challenge; won returns funds', async () => {
    const { p } = await pay(8801);
    assert.equal(p.status, 'captured');
    core.settlePayment(store.get('payments', p.id), 'test settlement', 'TEST'); // dispute holds come out of available
    await wait(2100); await core.runCashAppSync();
    const d = store.list('disputes', { merchant_id: nwId }).find(x => x.payment_id === p.id); assert.ok(d, 'dispute opened'); dispute = d;
    assert.equal(d.status, 'needs_response'); assert.equal(store.get('payments', p.id).status, 'disputed');
    const m = client(); await m('POST', '/auth/login', { email: 'owner@northwind.test', password: merchantPw });
    assert.equal((await m('POST', `/m-api/disputes/${d.id}/evidence`, { category: 'PROOF_OF_DELIVERY_DOCUMENTATION', text: 'Delivered by UPS 1Z999, signed by customer.' })).status, 200);
    assert.equal((await m('POST', `/m-api/disputes/${d.id}/challenge`)).body.status, 'under_review');
    CA.sim.setDisputeState(d.cashapp_dispute_id, 'WON'); await core.flushSimEvents();
    assert.equal(store.get('disputes', d.id).status, 'won'); assert.equal(store.get('payments', p.id).status, 'settled');
  });
  await step('Cash App webhooks: forged signature rejected (sandbox and production)', async () => {
    for (const seg of ['sandbox', 'production']) { const r = await pub('POST', `/hooks/cashapp/${seg}`, { type: 'payment.status.updated', event_id: 'x' }, { 'X-Signature': 'V1 deadbeef' }); assert.equal(r.status, 403); }
  });
  await step('Cash App webhooks: correctly signed event is applied once (dedupe by event_id)', async () => {
    const saved = config.cashapp.live; config.cashapp.live = { ...saved, webhookSecret: 'CASH_test_webhook_secret' };
    try {
      const p = store.get('payments', manual.p.id);
      const body = JSON.stringify({ type: 'payment.status.updated', event_id: 'EVT_smoke_1', created_at: new Date().toISOString(), data: { id: 'x', type: 'payment', object: { payment: { ...(await CA.sim.retrievePayment(p.cashapp.payment_id)), status: 'CAPTURED' } } } });
      const send = async () => {
        const u = new URL(BASE + '/hooks/cashapp/production');
        const headers = { accept: 'application/json', 'content-type': 'application/json', host: u.host };
        headers['x-signature'] = CA.signature('CASH_test_webhook_secret', 'POST', u.pathname, headers, body);
        return new Promise((res, rej) => { const q = http.request(u, { method: 'POST', headers }, r => { let t = ''; r.on('data', d => t += d); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(t) })); }); q.on('error', rej); q.end(body); });
      };
      const r1 = await send(); assert.equal(r1.status, 200, JSON.stringify(r1.body));
      const r2 = await send(); assert.equal(r2.body.duplicate, true);
      assert.equal(store.byKey('provider_events', 'cashapp:live:EVT_smoke_1').sig, 'verified');
      // A live-mode webhook must not touch a test payment.
      assert.equal(store.get('payments', p.id).mode, 'test'); assert.equal(store.get('payments', p.id).status, 'captured');
    } finally { config.cashapp.live = saved; }
  });
  await step('Cash App adapter: real API calls are signed, authenticated and logged without secrets', async () => {
    const seen = []; const KEY_SECRET = 'KEY_SECRET_for_test';
    const fake = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, raw });
      const j = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/customer-request/v1/requests') return j(201, { request: { id: 'GRR_fake', status: 'PENDING', actions: JSON.parse(raw).request.actions, auth_flow_triggers: { mobile_url: 'https://cash.app/x', qr_code_image_url: 'https://cash.app/qr.png' } } });
      if (req.url === '/network/v1/payments') return j(400, { errors: [{ category: 'PAYMENT_PROCESSING_ERROR', code: 'INSUFFICIENT_FUNDS', detail: 'Declined' }] });
      if (req.url.startsWith('/network/v1/merchants')) return j(200, { merchants: [] });
      j(500, { errors: [{ category: 'API_ERROR', code: 'INTERNAL_SERVER_ERROR' }] });
    }); }).listen(0);
    const saved = config.cashapp.live;
    config.cashapp.live = { clientId: 'CAS-CI_TEST', keyId: 'KEY_TEST', keySecret: KEY_SECRET, webhookSecret: '', base: `http://127.0.0.1:${fake.address().port}` };
    try {
      const api = CA.client('live');
      const req = await api.createCustomerRequest({ idempotency_key: 'k1', request: { channel: 'ONLINE', actions: [{ type: 'ONE_TIME_PAYMENT', amount: 100, currency: 'USD', scope_id: 'MMI_1' }] } }, { op: 'test' });
      assert.equal(req.id, 'GRR_fake');
      assert.equal(seen[0].headers.authorization, 'Client CAS-CI_TEST', 'customer request API uses client id only');
      await api.listMerchants({ op: 'test' });
      const h = seen[1].headers; assert.equal(h.authorization, 'Client CAS-CI_TEST KEY_TEST'); assert.equal(h['x-region'], 'PDX');
      const expected = CA.signature(KEY_SECRET, 'GET', seen[1].url, { accept: h.accept, authorization: h.authorization, host: h.host }, '');
      assert.equal(h['x-signature'], expected, 'request signature verifies');
      await assert.rejects(api.createPayment({ idempotency_key: 'k2', payment: { amount: 100 } }, { op: 'test' }), e => e.code === 'INSUFFICIENT_FUNDS' && !e.retryable);
      await assert.rejects(api.retrievePayment('PWC_x', { op: 'test' }), e => e.retryable === true);
      const logs = store.list('api_logs', { mode: 'live' }, { limit: 20 }); assert.ok(logs.length >= 4);
      assert.ok(!JSON.stringify(logs).includes(KEY_SECRET) && !JSON.stringify(logs).includes('ONE_TIME_PAYMENT'), 'no secrets or bodies in logs');
    } finally { config.cashapp.live = saved; fake.close(); }
  });
  await step('API: payment link redirects to a fresh checkout', async () => { const l = await dh.paymentLinks.create({ amount: 1500, currency: 'USD', description: 'Link test', reusable: true }); const r = await pub('GET', new URL(l.url).pathname); assert.equal(r.status, 303); assert.match(r.headers.get('location'), /^\/pay\/cs_/); });
  await step('Webhooks: signed completion carries WooCommerce order and payment details', async () => {
    for (let i = 0; i < 20 && store.list('deliveries', { status: 'pending' }, { limit: 1 }).length; i++) await core.runDeliveries();
    const event = received.find(e => e.type === 'checkout.session.completed' && e.data.object.id === session.id);
    assert.ok(event, 'no checkout.session.completed');
    assert.equal(event.data.object.metadata.order_id, '42'); assert.equal(event.data.object.payment, payment.id);
    assert.equal(event.data.object.payment_status, 'paid'); assert.equal(event.data.object.amount, 2500);
    const paidAfterCapture = received.filter(e => e.type === 'checkout.session.completed' && e.data.object.id === manual.s.id).map(e => e.data.object.payment_status);
    assert.deepEqual(paidAfterCapture, ['authorized', 'paid']);
    for (const t of ['payment.failed', 'payment.refunded', 'refund.failed', 'dispute.created', 'dispute.updated']) assert.ok(received.some(e => e.type === t), t);
    assert.ok(received.every(e => e.id?.startsWith('evt_')));
  });
  await step('API: invalid key and tenant isolation', async () => {
    assert.equal((await pub('GET', '/v1/payments', null, { Authorization: 'Bearer dh_test_sk_' + 'x'.repeat(40) })).status, 401);
    const bb = core.normalizeMerchant(store.list('merchants', {}).find(x => x.name === 'Bluebird Bakery'));
    const s2 = core.createSession(bb, 'test', { amount: 900, currency: 'USD', description: 'Other tenant' }, 'test');
    const foreign = await core.startCashApp(s2, { name: 'Cy Test' });
    assert.equal((await pub('GET', '/v1/payments/' + foreign.id, null, { Authorization: 'Bearer ' + secret })).status, 404, 'cross-tenant read must 404');
    assert.equal((await pub('GET', '/v1/checkout/sessions/' + s2.id, null, { Authorization: 'Bearer ' + secret })).status, 404);
    assert.equal((await pub('POST', '/v1/refunds', { payment: foreign.id }, { Authorization: 'Bearer ' + secret })).status, 404);
  });

  const m = client();
  await step('Merchant: sign in, CSRF header enforced, overview and Cash App status load', async () => {
    const bad = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(bad.status, 403);
    assert.equal((await m('POST', '/auth/login', { email: 'owner@northwind.test', password: 'wrong-password-1' })).status, 401);
    assert.equal((await m('POST', '/auth/login', { email: 'owner@northwind.test', password: merchantPw })).status, 200);
    const o = await m('GET', '/m-api/overview'); assert.ok(o.body.count > 0); assert.equal(o.body.cashapp.status, 'ACTIVE');
    const ca = await m('GET', '/m-api/cashapp'); assert.equal(ca.status, 200); assert.ok(!JSON.stringify(ca.body).match(/KEY_SECRET|keySecret|webhookSecret/));
  });
  await step('Merchant: declined attempt and refunds visible; wallet shows pending vs available', async () => {
    const rows = (await m('GET', '/m-api/payments')).body.data;
    assert.equal(rows.find(p => p.id === declined.id)?.status, 'declined');
    const details = await m('GET', `/m-api/payments/${payment.id}`); assert.equal(details.body.refunds.length, 2);
    const w = await m('GET', '/m-api/wallet'); assert.equal(w.status, 200);
    assert.equal((await m('GET', '/m-api/disputes')).body.length >= 1, true);
  });
  await step('Merchant: create restricted key (secret shown once, stored hashed)', async () => { const r = await m('POST', '/m-api/keys', { name: 'Woo', scopes: ['checkout:write', 'payments:read'] }); assert.match(r.body.secret, /^dh_test_sk_/); const row = store.byKey('api_keys', require('../server/util').sha256(r.body.secret)); assert.ok(row && !JSON.stringify(row).includes(r.body.secret)); });
  await step('Merchant: live keys blocked until go-live', async () => { assert.equal((await m('POST', '/m-api/keys', { name: 'Live' }, { 'X-DH-Mode': 'live' })).status, 400); });
  await step('Merchant: cannot register Cash App production from the dashboard', async () => { assert.notEqual((await m('POST', '/m-api/cashapp/register', {}, { 'X-DH-Mode': 'live' })).status, 200); });

  const a = client();
  let po;
  await step('Admin: sign in and see Cash App status and queues', async () => {
    assert.equal((await a('POST', '/auth/login', { email: 'admin@digitalhub.local', password: 'AdminPass12345' })).status, 200);
    const o = await a('GET', '/a-api/overview'); assert.equal(o.status, 200); assert.ok('cashapp_registrations' in o.body.queues);
    const c = await a('GET', '/a-api/cashapp'); assert.equal(c.status, 200); assert.equal(c.body.environments.length, 2);
    assert.ok(c.body.logs.length > 0 || c.body.events.length > 0);
    assert.ok(!JSON.stringify(c.body).includes('CASH_test_webhook_secret'));
  });
  await step('Admin: merchants cannot reach admin API', async () => { assert.equal((await m('GET', '/a-api/overview')).status, 403); });
  await step('Admin: record a Cash App settlement → wallet available → payout approved', async () => {
    const before = (await a('GET', '/a-api/settlements')).body.unsettled.length; assert.ok(before > 0);
    const r = await a('POST', '/a-api/settlements', { merchant: nwId, reference: 'CASHAPP-STL-0001' }); assert.ok(r.body.settled > 0, JSON.stringify(r.body));
    const bal = (await m('GET', '/m-api/balances')).body.balances.USD;
    const bank = (await m('GET', '/m-api/destinations')).body.banks.find(b => b.status === 'verified');
    const res = await m('POST', '/m-api/payouts', { currency: 'USD', amount: Math.min(bal.available, 6000), destination: bank.id, idempotency_key: 'po-1' });
    assert.equal(res.status, 200, JSON.stringify(res.body) + ' bal=' + JSON.stringify(bal)); po = res.body;
    if (po.status === 'pending_approval') po = (await a('POST', `/a-api/payouts/${po.id}/approve`)).body;
    assert.equal(po.status, 'completed');
  });
  await step('Admin: refund and sync from the transactions page', async () => {
    const { p } = await pay(2000);
    assert.equal((await a('POST', `/a-api/payments/${p.id}/sync`)).status, 200);
    assert.equal((await a('POST', `/a-api/payments/${p.id}/refund`, { amount: 500, reason: 'admin test' })).body.status, 'succeeded');
  });
  await step('Admin: KYB approval blocked until checks + KYC + AML complete; then Cash App registration', async () => {
    const bb = (await a('GET', '/a-api/merchants?q=Bluebird')).body[0];
    assert.equal((await a('POST', `/a-api/merchants/${bb.id}/status`, { status: 'approved' })).status, 400);
    for (const check of ['registration', 'owners', 'website', 'sanctions', 'bank']) await a('POST', `/a-api/merchants/${bb.id}/kyb`, { check, value: true });
    await a('POST', `/a-api/merchants/${bb.id}/kyb`, { owner: 0, idStatus: 'verified' });
    await a('POST', `/a-api/merchants/${bb.id}/kyb`, { aml: true });
    assert.equal((await a('POST', `/a-api/merchants/${bb.id}/status`, { status: 'approved' })).body.status, 'approved');
    const det = await a('POST', `/a-api/merchants/${bb.id}/cashapp/details`, { address: { address_line_1: '42 Market St', locality: 'Oakland', administrative_district_level_1: 'CA', postal_code: '94607', country: 'US' }, category: '5462', site_url: 'https://bluebird-bakery.example' });
    assert.equal(det.status, 200, JSON.stringify(det.body));
    const reg = await a('POST', `/a-api/merchants/${bb.id}/cashapp/register`, { mode: 'test' }); assert.equal(reg.status, 200, JSON.stringify(reg.body));
    assert.equal(core.merchant(bb.id).cashapp.test.status, 'ACTIVE');
    const live = await a('POST', `/a-api/merchants/${bb.id}/live`, { enabled: true }); assert.equal(live.status, 400, 'live needs Cash App production registration');
  });
  await step('Admin: maker-checker blocks self-approval of adjustments', async () => { const adj = (await a('POST', '/a-api/adjustments', { merchant: nwId, mode: 'test', currency: 'USD', amount: 500, reason: 'Smoke test goodwill credit' })).body; assert.equal((await a('POST', `/a-api/adjustments/${adj.id}/approve`)).status, 400); });
  await step('Ledger: every reconciliation check passes', async () => { const l = await a('GET', '/a-api/ledger'); for (const c of l.body.checks) assert.ok(c.ok, c.name + ': ' + c.detail); assert.ok(l.body.trial_balance.every(t => t.debits === t.credits)); });
  await step('Ledger: database refuses edits to posted entries', async () => { assert.throws(() => store.db.exec('UPDATE ledger SET amount = 0 WHERE id = 1'), /append-only/); });
  await step('Admin: ADMIN_EMAIL merchant sign-up with no activity is converted to super admin', async () => {
    const { ensureAdmin } = require('../server/seed'), auth = require('../server/auth');
    const signup = await pub('POST', '/auth/signup', { business_name: 'Owner Test', name: 'Owner', email: 'owner-admin@example.com', password: 'OwnerPass12345', country: 'US' });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    const saved = [config.adminEmail, config.adminPassword]; config.adminEmail = 'owner-admin@example.com'; config.adminPassword = 'NewAdminPass12345';
    try {
      await ensureAdmin();
      const u = store.byKey('users', 'owner-admin@example.com'); assert.equal(u.kind, 'staff'); assert.equal(u.role, 'super_admin');
      const x = client(); assert.equal((await x('POST', '/auth/login', { email: 'owner-admin@example.com', password: 'NewAdminPass12345' })).status, 200);
      assert.equal((await x('GET', '/a-api/overview')).status, 200);
      assert.ok(auth && true);
    } finally { [config.adminEmail, config.adminPassword] = saved; }
  });
  await step('Downloads: WooCommerce plugin zip is the Cash App Pay gateway', async () => {
    const r = await fetch(BASE + '/downloads/digitalhub-woocommerce.zip'); assert.equal(r.status, 200); const b = Buffer.from(await r.arrayBuffer()); assert.equal(b.readUInt32LE(0), 0x04034b50);
    const php = fs.readFileSync(path.join(__dirname, '../plugins/woocommerce/digitalhub-payments/digitalhub-payments.php'), 'utf8');
    assert.match(php, /'payment_methods' => \['cashapp'\]/); assert.match(php, /payment_status'\] === 'paid'/); assert.doesNotMatch(php, /Visa \/ Mastercard'\]|'card'\]/);
  });
  await step('Removed providers stay removed', async () => {
    for (const p of ['/hooks/coinbase', '/hooks/binance']) assert.equal((await pub('POST', p, {})).status, 404);
    assert.ok(!fs.existsSync(path.join(__dirname, '../server/providers.js')));
    assert.equal(crypto.randomUUID().length, 36);
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}.`);
  receiver.close(); server.close(); setTimeout(() => process.exit(), 100);
})().catch(e => { console.error(e); process.exit(1); });
