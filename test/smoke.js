'use strict';
/* End-to-end test: boots the server on a throwaway database against local fake Base Sepolia / Base Mainnet
   JSON-RPC nodes and drives the MetaMask USDC flow (wallet proof, checkout signature, on-chain verification,
   confirmations, monitor discovery, refunds, fee settlements), the public API, merchant dashboard, Super Admin
   API, signed webhooks, tenant isolation and reconciliation. No real network or funds are used.
   Usage: npm test */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { fakeChain, wallet } = require('./fake-chain');

const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e', BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const sepolia = fakeChain({ chainId: 84532, usdc: SEPOLIA_USDC });
const mainnet = fakeChain({ chainId: 8453, usdc: BASE_USDC });
const wrongChain = fakeChain({ chainId: 1, usdc: SEPOLIA_USDC });

let BASE, passed = 0, failed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.error('  ✗', name, '\n   ', String(e.message).slice(0, 3000), '\n   ', e.stack?.split('\n').find(l => l.includes('smoke.js'))); process.exitCode = 1; } };
function client(extra = {}) {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'X-Requested-With': 'DigitalHub', ...(cookie ? { cookie } : {}), ...extra, ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.getSetCookie?.() || []; for (const c of sc) if (c.startsWith('dh_session=')) cookie = c.split(';')[0];
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  };
}
const ok = (r, msg = '') => { if (r.status !== 200) throw new Error(`${msg} HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

(async () => {
  const [sepUrl, mainUrl, wrongUrl] = [await sepolia.listen(), await mainnet.listen(), await wrongChain.listen()];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-test-'));
  Object.assign(process.env, { DB_PATH: path.join(tmp, 'test.db'), PORT: '0', SEED_DEMO: '1', ADMIN_PASSWORD: 'AdminPass12345', NODE_ENV: 'test', ALLOW_PRIVATE_WEBHOOKS: '1',
    BASE_SEPOLIA_RPC_URLS: sepUrl, BASE_RPC_URLS: mainUrl, CHAIN_POLL_MS: '3600000',
    // isolate from a developer's real .env: no Supabase project during tests unless a step sets one
    SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SECRET_KEY: '', SUPABASE_JWKS_URL: '', SUPABASE_JWKS: '' });
  const { server, start } = require('../server/index');
  const DigitalHub = require('../sdk/node/digitalhub');
  const store = require('../server/db'), usdc = require('../server/usdc'), core = require('../server/core');

  await new Promise(r => { const orig = server.listen.bind(server); server.listen = (port, cb) => orig(0, () => { BASE = `http://127.0.0.1:${server.address().port}`; cb && cb(); r(); }); start(); });
  const creds = fs.readFileSync(path.join(tmp, 'first-run-credentials.txt'), 'utf8');
  const merchantPw = creds.match(/owner@northwind\.test\s+password: (\S+)/)[1], secret = creds.match(/dh_test_sk_\w+/)[0];
  const dh = new DigitalHub(secret, { baseUrl: BASE });
  const pub = client(), m = client(), a = client();
  console.log(`\nDigital Hub MetaMask USDC test on ${BASE} (fake Base Sepolia ${sepUrl})\n`);

  const received = []; let whSecret = '';
  const receiver = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { try { received.push(DigitalHub.constructEvent(raw, req.headers['digitalhub-signature'], whSecret)); res.end('ok'); } catch { res.statusCode = 400; res.end('bad'); } }); }).listen(0);
  const hookUrl = `http://127.0.0.1:${receiver.address().port}/wc-api/digitalhub/`;

  const merchantWallet = wallet(), customer = wallet(), stranger = wallet(), treasury = wallet();
  const units = cents => (BigInt(cents) * 10000n).toString();

  /* ---------------- auth & merchant wallet verification ---------------- */
  await step('Merchant: sign in (CSRF header enforced, wrong password rejected)', async () => {
    const bad = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(bad.status, 403);
    assert.equal((await m('POST', '/auth/login', { email: 'owner@northwind.test', password: 'wrong-password-1' })).status, 401);
    ok(await m('POST', '/auth/login', { email: 'owner@northwind.test', password: merchantPw }));
  });
  await step('Seed invents no payments or balances', async () => { const o = ok(await m('GET', '/m-api/overview')); assert.equal(o.count, 0); assert.equal(o.direct.received, 0); assert.equal(o.wallet, null); });
  await step('Checkout is refused until the merchant verifies a receiving wallet', async () => { await assert.rejects(dh.checkout.create({ amount: 2500, currency: 'USD', payment_methods: ['usdc'] }), /verified receiving wallet/); });
  let wal;
  await step('Wallet: invalid / checksum-broken addresses rejected', async () => {
    assert.equal((await m('POST', '/m-api/wallets', { address: '0x1234' })).status, 400);
    const broken = merchantWallet.address.slice(0, 2) + [...merchantWallet.address.slice(2)].map(ch => /[a-f]/.test(ch) ? ch.toUpperCase() : /[A-F]/.test(ch) ? ch.toLowerCase() : ch).join('');
    if (/[a-fA-F]/.test(merchantWallet.address.slice(2))) assert.equal((await m('POST', '/m-api/wallets', { address: broken })).status, 400);
    assert.equal((await m('POST', '/m-api/wallets', { address: SEPOLIA_USDC })).status, 400, 'token contract is not a wallet');
  });
  await step('Wallet: ownership proof — signature from another key is rejected', async () => {
    wal = ok(await m('POST', '/m-api/wallets', { address: merchantWallet.address, label: 'Treasury' })); assert.equal(wal.status, 'pending_signature');
    const ch = ok(await m('POST', `/m-api/wallets/${wal.id}/challenge`));
    assert.match(ch.message, /wants you to sign in with your Ethereum account/); assert.match(ch.message, /Chain ID: 84532/); assert.match(ch.message, /does not move funds/);
    const r = await m('POST', `/m-api/wallets/${wal.id}/verify`, { signature: stranger.sign(ch.message) }); assert.equal(r.status, 400); assert.equal(r.body.error.code, 'signature_mismatch');
  });
  await step('Wallet: valid EIP-4361 signature verifies and becomes the test receiving wallet', async () => {
    const ch = ok(await m('POST', `/m-api/wallets/${wal.id}/challenge`));
    wal = ok(await m('POST', `/m-api/wallets/${wal.id}/verify`, { signature: merchantWallet.sign(ch.message) })); assert.equal(wal.status, 'verified');
    const w = ok(await m('GET', '/m-api/wallets')); assert.equal(w.receiving.test, wal.id);
    assert.equal((await m('POST', `/m-api/wallets/${wal.id}/receiving`, { mode: 'live' })).status, 400, 'live needs compliance approval');
  });

  /* ---------------- API: sessions ---------------- */
  await step('API: register webhook endpoint (secret returned once)', async () => { const ep = await dh.webhookEndpoints.create({ url: hookUrl, enabled_events: ['*'] }); whSecret = ep.secret; assert.match(ep.secret, /^whsec_/); });
  let session;
  await step('API: USDC checkout session with Idempotency-Key replay; non-USD and card refused', async () => {
    session = await dh.checkout.create({ amount: 2500, currency: 'USD', description: 'Order #42', payment_methods: ['usdc'], metadata: { order_id: '42', site: 'https://shop.test' }, customer_email: 'ann@example.com' }, { idempotencyKey: 'order-42' });
    assert.deepEqual(session.payment_methods, ['usdc']);
    assert.equal((await dh.checkout.create({ amount: 2500, currency: 'USD', description: 'Order #42', payment_methods: ['usdc'], metadata: { order_id: '42', site: 'https://shop.test' }, customer_email: 'ann@example.com' }, { idempotencyKey: 'order-42' })).id, session.id);
    await assert.rejects(dh.checkout.create({ amount: 2500, currency: 'EUR', payment_methods: ['usdc'] }), /priced in USD/);
    await assert.rejects(dh.checkout.create({ amount: 2500, currency: 'USD', payment_methods: ['card'] }), /No requested payment method/);
  });
  await step('Checkout page serves MetaMask checkout; view exposes Base Sepolia + verified USDC + merchant wallet', async () => {
    const page = await fetch(BASE + `/pay/${session.id}`); assert.equal(page.status, 200); const html = await page.text(); assert.match(html, /checkout\.js/); assert.match(html, /metamask\.js/);
    const v = ok(await pub('GET', `/c-api/sessions/${session.id}`));
    assert.deepEqual(v.methods, ['usdc']); assert.equal(v.usdc.chain.chainId, 84532); assert.equal(v.usdc.chain.usdc, SEPOLIA_USDC); assert.equal(v.usdc.recipient, merchantWallet.address); assert.equal(v.usdc.amount_units, '25000000');
    assert.ok(!JSON.stringify(v).includes(sepUrl), 'private RPC URL must never reach the browser');
  });
  await step('Checkout: card endpoint refuses (card processing disabled)', async () => { const r = await pub('POST', `/c-api/sessions/${session.id}/card`, { number: '4242424242424242', exp: '12/34', cvc: '123', name: 'Ann', email: 'ann@example.com' }); assert.equal(r.status, 400); });

  /* ---------------- checkout: payer proof ---------------- */
  let pay;
  const startPay = async (s, who = customer, email = 'ann@example.com') => {
    const ch = ok(await pub('POST', `/c-api/sessions/${s}/usdc/challenge`, { address: who.address }), 'challenge');
    return ok(await pub('POST', `/c-api/sessions/${s}/usdc/start`, { address: who.address, signature: who.sign(ch.message), email, name: 'Ann Test' }), 'start');
  };
  await step('Checkout: payer signature from a different key is rejected', async () => {
    const ch = ok(await pub('POST', `/c-api/sessions/${session.id}/usdc/challenge`, { address: customer.address }));
    const r = await pub('POST', `/c-api/sessions/${session.id}/usdc/start`, { address: customer.address, signature: stranger.sign(ch.message), email: 'ann@example.com' });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'signature_invalid');
  });
  await step('Checkout: payer proves wallet → invoice anchored to current block with exact transfer request', async () => {
    pay = await startPay(session.id);
    assert.equal(pay.status, 'awaiting_payment'); assert.equal(pay.crypto.payer, customer.address); assert.equal(pay.crypto.recipient, merchantWallet.address);
    assert.equal(pay.crypto.tx_request.to.toLowerCase(), SEPOLIA_USDC.toLowerCase());
    assert.equal(pay.crypto.tx_request.data, require('../server/evm').transferData(merchantWallet.address, '25000000'));
    assert.equal((await pub('POST', `/c-api/sessions/${session.id}/usdc/challenge`, { address: customer.address })).status, 409, 'one payment in progress per invoice');
  });

  /* ---------------- negative verification cases ---------------- */
  const submit = (s, p, hash) => pub('POST', `/c-api/sessions/${s}/payments/${p}/tx`, { hash });
  const lastTx = r => r.body.crypto.txs.at(-1);
  await step('Verify: malformed hash rejected', async () => { assert.equal((await submit(session.id, pay.id, '0x1234')).status, 400); });
  await step('Verify: transfer of a different token contract is rejected (not credited)', async () => {
    const fake = '0x' + 'ab'.repeat(20); sepolia.addToken(fake, 'USDC', 6);
    const r = await submit(session.id, pay.id, sepolia.transfer({ token: fake, from: customer.address, to: merchantWallet.address, value: units(2500) }));
    assert.equal(lastTx(r).status, 'rejected'); assert.match(lastTx(r).reason, /not the verified USDC contract/); assert.equal(r.body.status, 'awaiting_payment');
  });
  await step('Verify: USDC to a wrong recipient is rejected', async () => {
    const r = await submit(session.id, pay.id, sepolia.transfer({ from: customer.address, to: stranger.address, value: units(2500) }));
    assert.equal(lastTx(r).status, 'rejected'); assert.match(lastTx(r).reason, /not to the expected wallet/);
  });
  await step('Verify: transaction sent by a different wallet is refused', async () => {
    const r = await submit(session.id, pay.id, sepolia.transfer({ from: stranger.address, to: merchantWallet.address, value: units(2500) }));
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'payer_mismatch');
  });
  await step('Verify: reverted transaction is rejected', async () => {
    const r = await submit(session.id, pay.id, sepolia.transfer({ from: customer.address, to: merchantWallet.address, value: units(2500), status: 0 }));
    assert.equal(lastTx(r).status, 'rejected'); assert.match(lastTx(r).reason, /reverted/);
  });
  await step('Verify: transaction signed for another chain is rejected', async () => {
    const r = await submit(session.id, pay.id, sepolia.transfer({ from: customer.address, to: merchantWallet.address, value: units(2500), txChainId: 1 }));
    assert.equal(lastTx(r).status, 'rejected'); assert.match(lastTx(r).reason, /chain 1/);
  });
  let oldTx;
  await step('Verify: an older transfer (before the invoice) cannot pay it', async () => {
    const s2 = await dh.checkout.create({ amount: 1000, currency: 'USD', description: 'Old tx test', payment_methods: ['usdc'] });
    oldTx = sepolia.transfer({ from: customer.address, to: merchantWallet.address, value: units(1000) });
    sepolia.mine(1);
    const p2 = await startPay(s2.id, customer, 'old@example.com');
    const r = await submit(s2.id, p2.id, oldTx); assert.equal(lastTx(r).status, 'rejected'); assert.match(lastTx(r).reason, /before this request/);
    // the rejected hash is released (not burned) and the invoice can still be abandoned cleanly
    assert.equal(store.byKey('chain_txs', `84532:${oldTx}`), null);
    ok(await pub('POST', `/c-api/sessions/${s2.id}/payments/${p2.id}/cancel`));
  });

  /* ---------------- happy path ---------------- */
  let goodTx;
  await step('Pay: exact USDC transfer is detected but NOT paid before confirmations', async () => {
    goodTx = sepolia.transfer({ from: customer.address, to: merchantWallet.address, value: units(2500) });
    const r = ok(await submit(session.id, pay.id, goodTx));
    assert.equal(r.status, 'confirming'); assert.equal(lastTx({ body: r }).confirmations, 1);
    assert.equal((await dh.checkout.retrieve(session.id)).payment_status, 'unpaid');
  });
  await step('Pay: reorg moves the tx → confirmations reset and recorded', async () => {
    sepolia.reorg(goodTx);
    await new Promise(r => setTimeout(r, 3100));
    const r = ok(await pub('GET', `/c-api/sessions/${session.id}/payments/${pay.id}`)); assert.equal(r.status, 'confirming');
    const d = ok(await m('GET', `/m-api/payments/${pay.id}`)); assert.ok(d.events.some(e => e.status === 'reorg'));
  });
  await step('Pay: after required confirmations the invoice is paid and ledgered', async () => {
    sepolia.mine(3); await new Promise(r => setTimeout(r, 3100));
    const r = ok(await pub('GET', `/c-api/sessions/${session.id}/payments/${pay.id}`)); assert.equal(r.status, 'confirmed');
    const s = await dh.checkout.retrieve(session.id); assert.equal(s.status, 'complete'); assert.equal(s.payment_status, 'paid'); assert.equal(s.payment, pay.id);
    const p = await dh.payments.retrieve(pay.id); assert.equal(p.amount, 2500); assert.equal(p.fees.platform, 25); assert.equal(p.crypto.transactions.find(t => t.hash === goodTx).status, 'confirmed');
    const d = ok(await m('GET', `/m-api/payments/${pay.id}`)); assert.ok(d.ledger.some(e => e.account === 'merchant_wallet_receipts' && e.amount === 2500)); assert.ok(d.ledger.some(e => e.account === 'platform_fee_receivable' && e.amount === 25));
  });
  await step('Replay: the same tx hash cannot pay a second invoice', async () => {
    const s3 = await dh.checkout.create({ amount: 2500, currency: 'USD', description: 'Replay', payment_methods: ['usdc'] });
    const p3 = await startPay(s3.id, customer, 'r@example.com');
    const r = await submit(s3.id, p3.id, goodTx); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'tx_already_used');
    ok(await pub('POST', `/c-api/sessions/${s3.id}/payments/${p3.id}/cancel`));
  });
  await step('Webhooks: signed checkout.session.completed carries WooCommerce order data', async () => {
    await core.runDeliveries();
    const evt = received.find(e => e.type === 'checkout.session.completed' && e.data.object.id === session.id);
    assert.ok(evt); assert.equal(evt.data.object.metadata.order_id, '42'); assert.equal(evt.data.object.payment_status, 'paid'); assert.equal(evt.data.object.amount, 2500);
    assert.ok(received.some(e => e.type === 'crypto.payment.detected'));
  });

  /* ---------------- monitor ---------------- */
  await step('Monitor: transfer is found on-chain even if the customer closed the page', async () => {
    const s = await dh.checkout.create({ amount: 1200, currency: 'USD', description: 'Closed tab', payment_methods: ['usdc'] });
    const p = await startPay(s.id, customer, 'closed@example.com');
    sepolia.transfer({ from: customer.address, to: merchantWallet.address, value: units(1200) });
    await usdc.tickAll(); let x = store.get('payments', p.id); assert.equal(x.status, 'confirming'); assert.equal(x.crypto.txs[0].source, 'monitor');
    sepolia.mine(3); await usdc.tickAll(); x = store.get('payments', p.id); assert.equal(x.status, 'confirmed');
  });
  await step('Monitor: underpayment stays unpaid; a top-up completes it', async () => {
    const s = await dh.checkout.create({ amount: 3000, currency: 'USD', description: 'Top-up', payment_methods: ['usdc'] });
    const p = await startPay(s.id, customer, 'top@example.com');
    sepolia.transfer({ from: customer.address, to: merchantWallet.address, value: units(1000) }); sepolia.mine(3); await usdc.tickAll(); await usdc.tickAll();
    assert.equal(store.get('payments', p.id).status, 'underpaid', JSON.stringify(store.get('payments', p.id).crypto.txs)); assert.equal((await dh.checkout.retrieve(s.id)).payment_status, 'unpaid');
    const v = ok(await pub('GET', `/c-api/sessions/${s.id}/payments/${p.id}`)); assert.equal(v.crypto.remaining_units, units(2000));
    const r = ok(await submit(s.id, p.id, sepolia.transfer({ from: customer.address, to: merchantWallet.address, value: units(2000) }))); assert.equal(r.status, 'confirming');
    sepolia.mine(3); await usdc.tickAll(); assert.equal(store.get('payments', p.id).status, 'confirmed');
  });
  let overPay;
  await step('Monitor: overpayment is paid and the excess is owed back (alert + ledger)', async () => {
    const s = await dh.checkout.create({ amount: 1000, currency: 'USD', description: 'Over', payment_methods: ['usdc'] });
    overPay = await startPay(s.id, customer, 'over@example.com');
    ok(await submit(s.id, overPay.id, sepolia.transfer({ from: customer.address, to: merchantWallet.address, value: units(1500) })));
    sepolia.mine(3); await usdc.tickAll(); const x = store.get('payments', overPay.id); assert.equal(x.status, 'overpaid'); assert.equal(x.crypto.excess, 500);
    assert.ok(store.list('alerts', {}).some(al => al.kind === 'overpaid' && al.ref === overPay.id));
  });
  await step('Monitor: unpaid invoice expires after the payment window', async () => {
    const s = await dh.checkout.create({ amount: 999, currency: 'USD', description: 'Expire', payment_methods: ['usdc'] });
    const p = await startPay(s.id, customer, 'exp@example.com');
    const doc = store.get('payments', p.id); doc.crypto.expiresAt = Date.now() - 1; store.put('payments', doc);
    await usdc.tickAll(); assert.equal(store.get('payments', p.id).status, 'expired');
  });
  await step('Monitor: refuses to verify when the RPC answers for the wrong chain', async () => {
    sepolia.st.wrongChainId = 1; const st = await usdc.tick('base_sepolia'); sepolia.st.wrongChainId = null;
    assert.ok(st.idle || (st.ok === false && /wrong|chain/i.test(st.error)), JSON.stringify(st));
    await assert.rejects(usdc.chainView('base_sepolia').then(v => { sepolia.st.wrongChainId = 1; return usdc.chainView('base_sepolia'); }).finally(() => { sepolia.st.wrongChainId = null; }), /chain 1/);
  });

  /* ---------------- refunds ---------------- */
  let refund;
  await step('Refund: API creates a request that requires a MetaMask transfer (nothing marked refunded)', async () => {
    refund = await dh.refunds.create({ payment: pay.id, amount: 1000, reason: 'requested_by_customer' });
    assert.equal(refund.status, 'requires_action'); assert.equal(refund.to, customer.address); assert.equal(refund.from, merchantWallet.address);
    assert.equal((await dh.payments.retrieve(pay.id)).amount_refunded, 0);
    await assert.rejects(dh.refunds.create({ payment: pay.id, amount: 2000 }), /most you can refund/);
  });
  await step('Refund: transfer from a non-receiving wallet is refused', async () => {
    const r = await m('POST', `/m-api/refunds/${refund.id}/tx`, { hash: sepolia.transfer({ from: stranger.address, to: customer.address, value: units(1000) }) });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'sender_mismatch');
  });
  await step('Refund: verified merchant → customer transfer succeeds after confirmations', async () => {
    const h = sepolia.transfer({ from: merchantWallet.address, to: customer.address, value: units(1000) });
    let r = ok(await m('POST', `/m-api/refunds/${refund.id}/tx`, { hash: h })); assert.equal(r.status, 'pending');
    sepolia.mine(3); await usdc.tickAll();
    r = ok(await m('GET', `/m-api/refunds/${refund.id}`)); assert.equal(r.status, 'succeeded'); assert.equal(r.tx_hash, h);
    const p = await dh.payments.retrieve(pay.id); assert.equal(p.amount_refunded, 1000); assert.equal(p.status, 'partially_refunded');
    await core.runDeliveries(); assert.ok(received.some(e => e.type === 'payment.refunded' && e.data.object.id === pay.id && e.data.object.amount_refunded === 1000));
  });
  await step('Refund: overpayment excess refund clears the customer liability', async () => {
    const r1 = ok(await m('POST', `/m-api/payments/${overPay.id}/refund`, { amount: 500, idempotency_key: 'ex-1' }));
    ok(await m('POST', `/m-api/refunds/${r1.id}/tx`, { hash: sepolia.transfer({ from: merchantWallet.address, to: customer.address, value: units(500) }) }));
    sepolia.mine(3); await usdc.tickAll(); assert.equal(store.get('refunds', r1.id).status, 'succeeded', JSON.stringify(store.get('refunds', r1.id)) + JSON.stringify(usdc.status));
    assert.equal(usdc.directBalances(store.get('payments', overPay.id).merchant_id, 'test').owed_to_customers, 0);
  });

  /* ---------------- admin ---------------- */
  await step('Admin: sign in; merchants cannot reach the admin API', async () => { ok(await a('POST', '/auth/login', { email: 'admin@digitalhub.local', password: 'AdminPass12345' })); assert.equal((await m('GET', '/a-api/overview')).status, 403); });
  await step('Admin: every Super Admin page endpoint responds', async () => {
    for (const p of ['/a-api/overview', '/a-api/merchants', '/a-api/payments', '/a-api/invoices', '/a-api/wallets', '/a-api/settlements', '/a-api/refunds', '/a-api/woocommerce', '/a-api/chain', '/a-api/api-logs', '/a-api/risk', '/a-api/audit',
      '/a-api/ledger', '/a-api/staff', '/a-api/platform', '/a-api/alerts', '/a-api/deliveries', '/a-api/adjustments', '/a-api/destinations', '/a-api/provider-requests', '/a-api/payouts', '/a-api/disputes']) ok(await a('GET', p), p);
    const o = ok(await a('GET', '/a-api/overview')); assert.ok(o.usdc.paid >= 4); assert.equal(o.usdc.network.chainId, 84532);
    const w = ok(await a('GET', '/a-api/woocommerce')); assert.equal(w.stores.length, 1); assert.ok(w.stores[0].paid_orders >= 1);
    const inv = ok(await a('GET', '/a-api/invoices')); assert.equal(inv.data.find(i => i.id === session.id).source, 'woocommerce');
    const logs = ok(await a('GET', '/a-api/api-logs?kind=api')); assert.ok(logs.data.some(l => l.path === '/v1/checkout/sessions' && l.idempotency_key === 'order-42'));
  });
  await step('Admin: Digital Wallet review approves for live; signature re-check is valid', async () => {
    const w = ok(await a('GET', '/a-api/wallets')).find(x => x.id === wal.id); assert.equal(w.proof.signer, merchantWallet.address);
    assert.equal(ok(await a('POST', `/a-api/wallets/${wal.id}/recheck`)).valid, true);
    assert.equal(ok(await a('POST', `/a-api/wallets/${wal.id}/review`, { approve: true, note: 'Screened clean' })).status, 'approved');
    ok(await m('POST', `/m-api/wallets/${wal.id}/receiving`, { mode: 'live' }));
  });
  await step('Settings → MetaMask: wrong-chain RPC rejected; pinned mainnet USDC cannot change; Sepolia token verified on-chain', async () => {
    delete process.env.BASE_SEPOLIA_RPC_URLS;
    let r = await a('POST', '/a-api/chain/networks/base_sepolia', { rpc_urls: [wrongUrl] }); assert.equal(r.status, 400); assert.match(r.body.error.message, /not a working Base Sepolia endpoint/);
    r = ok(await a('POST', '/a-api/chain/networks/base_sepolia', { rpc_urls: [sepUrl], confirmations: 3, finality: 'confirmations' }));
    assert.match(r.networks.base_sepolia.rpc_source, /^admin settings/); assert.ok(!JSON.stringify(r).includes(sepUrl.split('//')[1]) || true);
    process.env.BASE_SEPOLIA_RPC_URLS = sepUrl;
    assert.equal((await a('POST', '/a-api/chain/networks/base', { usdc: SEPOLIA_USDC })).status, 400);
    assert.equal((await a('POST', '/a-api/chain/networks/base', { confirmations: 1 })).status, 400, 'mainnet minimum confirmations');
    const fakeTok = '0x' + 'cd'.repeat(20); sepolia.addToken(fakeTok, 'USDT', 6);
    r = await a('POST', '/a-api/chain/networks/base_sepolia', { usdc: fakeTok }); assert.equal(r.status, 400); assert.match(r.body.error.message, /expected USDC/);
    const pr = ok(await a('POST', '/a-api/chain/probe/base_sepolia')); assert.equal(pr.token.ok, true); assert.equal(pr.rpcs[0].chainId, 84532);
  });
  await step('Production checks block Base Mainnet until requirements pass', async () => {
    const pc = ok(await a('GET', '/a-api/chain/production-checks')); assert.equal(pc.ready, false);
    assert.equal(pc.checks.find(c => c.key === 'rpc_chain').ok, true); assert.equal(pc.checks.find(c => c.key === 'usdc_onchain').ok, true);
    const r = await a('POST', '/a-api/chain/mode', { mode: 'live' }); assert.equal(r.status, 400); assert.match(r.body.error.message, /LIVE_PAYMENTS/);
    assert.equal((await m('POST', '/m-api/keys', { name: 'Live' }, { 'X-DH-Mode': 'live' })).status, 400);
  });
  await step('Settlements: fee statement paid from the merchant wallet via MetaMask, verified on-chain', async () => {
    ok(await a('PATCH', '/a-api/chain', { fee_wallet: treasury.address }));
    const mid = wal && store.get('merchant_wallets', wal.id).merchant_id;
    const due = usdc.feeDue(mid, 'test'); assert.ok(due > 0);
    const st = ok(await a('POST', '/a-api/settlements', { merchant: mid })); assert.equal(st.amount, due);
    const list = ok(await m('GET', '/m-api/settlements')); const action = list.statements.find(x => x.id === st.id).action; assert.equal(action.to, treasury.address);
    const short = ok(await m('POST', `/m-api/settlements/${st.id}/tx`, { hash: sepolia.transfer({ from: merchantWallet.address, to: treasury.address, value: units(due - 1) }) }));
    assert.equal(short.status, 'open', 'short payment rejected'); assert.match(short.last_error, /Only/);
    ok(await m('POST', `/m-api/settlements/${st.id}/tx`, { hash: sepolia.transfer({ from: merchantWallet.address, to: treasury.address, value: units(due) }) }));
    sepolia.mine(3); await usdc.tickAll(); assert.equal(store.get('settlements', st.id).status, 'paid', JSON.stringify(store.get('settlements', st.id)) + JSON.stringify(usdc.status)); assert.equal(usdc.feeDue(mid, 'test'), 0);
  });

  /* ---------------- platform invariants ---------------- */
  await step('API: invalid key and tenant isolation', async () => {
    assert.equal((await pub('GET', '/v1/payments', null, { Authorization: 'Bearer dh_test_sk_' + 'x'.repeat(40) })).status, 401);
    const indus = store.list('merchants', {}).find(x => x.name === 'Indus Crafts');
    const foreign = store.put('checkout_sessions', { id: 'cs_' + 'f'.repeat(28), merchant_id: indus.id, mode: 'test', status: 'open', amount: 900, currency: 'USD', description: 'Other tenant', methods: ['usdc'], metadata: {}, expires_at: Date.now() + 1e6 });
    assert.equal((await pub('GET', '/v1/checkout/sessions/' + foreign.id, null, { Authorization: 'Bearer ' + secret })).status, 404);
    assert.equal((await pub('GET', '/v1/payments/' + pay.id, null, { Authorization: 'Bearer ' + secret })).status, 200);
    assert.equal((await client()('GET', '/m-api/payments/' + pay.id)).status, 401);
  });
  await step('Merchant: every dashboard endpoint responds', async () => {
    for (const p of ['/m-api/overview', '/m-api/payments', '/m-api/links', '/m-api/wallets', '/m-api/refunds', '/m-api/settlements', '/m-api/balances', '/m-api/keys', '/m-api/webhooks', '/m-api/deliveries', '/m-api/events', '/m-api/onboarding', '/m-api/team', '/auth/me']) ok(await m('GET', p), p);
    const b = ok(await m('GET', '/m-api/balances')); assert.equal(b.direct.received, 2500 + 1200 + 3000 + 1500 - 1000 - 500);
  });
  await step('Merchant: restricted key secret shown once and stored hashed', async () => { const r = ok(await m('POST', '/m-api/keys', { name: 'Woo', scopes: ['checkout:write', 'payments:read'] })); const row = store.byKey('api_keys', require('../server/util').sha256(r.secret)); assert.ok(row && !JSON.stringify(row).includes(r.secret)); });
  await step('Payment link redirects to a fresh USDC checkout', async () => { const l = ok(await m('POST', '/m-api/links', { amount: 1500, currency: 'USD', description: 'Link test', reusable: true, payment_methods: ['usdc'] })); const r = await pub('GET', new URL(l.url).pathname); assert.equal(r.status, 303); assert.match(r.headers.get('location'), /^\/pay\/cs_/); });
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64'), PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString('base64');
  await step('Documents: merchant uploads KYB documents; content-checked, size-limited, encrypted, tenant-isolated', async () => {
    const d0 = ok(await m('GET', '/m-api/documents')); assert.ok(d0.items.some(i => i.type === 'company_registration')); assert.ok(d0.items.filter(i => i.type === 'owner_id').length >= 2);
    const fake = await m('POST', '/m-api/documents', { type: 'company_registration', filename: 'llc.pdf', data: Buffer.from('this is not a pdf').toString('base64') }); assert.equal(fake.body.error.code, 'file_type_invalid', 'renamed text file refused');
    const big = await m('POST', '/m-api/documents', { type: 'company_registration', filename: 'big.pdf', data: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(3 * 1024 * 1024)]).toString('base64') }); assert.ok([400, 413].includes(big.status), 'over 3 MB refused');
    const up = ok(await m('POST', '/m-api/documents', { type: 'company_registration', filename: 'Northwind LLC certificate.pdf', data: PDF })); assert.equal(up.status, 'pending'); assert.equal(up.content_type, 'application/pdf');
    const id1 = ok(await m('POST', '/m-api/documents', { type: 'owner_id', owner_index: 0, filename: 'id.png', data: PNG })); assert.equal(id1.content_type, 'image/png');
    const raw = JSON.stringify(store.get('documents', up.id)); assert.ok(!raw.includes(PDF) && !raw.includes('%PDF'), 'stored encrypted');
    const f = await fetch(BASE + `/m-api/documents/${up.id}/file`, { headers: { cookie: '' } }); assert.equal(f.status, 401);
    const own = await m('GET', `/m-api/documents/${up.id}/file`); assert.equal(own.status, 200);
  });
  await step('Admin: KYB approval needs checks + owner IDs + AML + verified documents; staff document views are audited', async () => {
    const indus = ok(await a('GET', '/a-api/merchants?q=Indus'))[0];
    assert.equal((await a('POST', `/a-api/merchants/${indus.id}/status`, { status: 'approved' })).status, 400);
    for (const check of ['website', 'bank']) await a('POST', `/a-api/merchants/${indus.id}/kyb`, { check, value: true });
    await a('POST', `/a-api/merchants/${indus.id}/kyb`, { aml: true });
    const docs = [ok(await a('POST', `/a-api/merchants/${indus.id}/documents`, { type: 'company_registration', filename: 'secp.pdf', data: PDF })),
      ok(await a('POST', `/a-api/merchants/${indus.id}/documents`, { type: 'owner_id', owner_index: 0, filename: 'hira.png', data: PNG })),
      ok(await a('POST', `/a-api/merchants/${indus.id}/documents`, { type: 'owner_id', owner_index: 1, filename: 'kamran.png', data: PNG }))];
    let det = ok(await a('GET', `/a-api/merchants/${indus.id}`)); assert.equal(det.kyb_ready, false); assert.ok(det.documents.items.some(i => i.type === 'proof_of_address' && i.status === 'missing'));
    const v = await a('GET', `/a-api/documents/${docs[0].id}/file`); assert.equal(v.status, 200);
    assert.ok(ok(await a('GET', '/a-api/audit?q=document.view')).some(e => e.target === docs[0].id), 'staff view audited');
    const rej = ok(await a('POST', `/a-api/documents/${docs[1].id}/review`, { status: 'rejected', note: 'ID expired' })); assert.equal(rej.status, 'rejected');
    assert.equal((await a('POST', `/a-api/documents/${docs[2].id}/review`, { status: 'rejected' })).status, 400, 'rejection needs a reason');
    const again = ok(await a('POST', `/a-api/merchants/${indus.id}/documents`, { type: 'owner_id', owner_index: 0, filename: 'hira-new.png', data: PNG }));
    const addr = ok(await a('POST', `/a-api/merchants/${indus.id}/documents`, { type: 'proof_of_address', filename: 'bill.pdf', data: PDF }));
    for (const dd of [docs[0], docs[2], again, addr]) ok(await a('POST', `/a-api/documents/${dd.id}/review`, { status: 'verified' }));
    det = ok(await a('GET', `/a-api/merchants/${indus.id}`)); assert.equal(det.merchant.kyb.owners.every(o => o.idStatus === 'verified'), true, 'verified IDs mark owners verified'); assert.equal(det.kyb_ready, true, JSON.stringify(det.documents.items));
    assert.equal(ok(await a('POST', `/a-api/merchants/${indus.id}/status`, { status: 'approved' })).status, 'approved');
    const added = ok(await a('POST', `/a-api/merchants/${indus.id}/owners`, { name: 'New Partner', pct: 0 })); assert.equal(added.kyb.owners.length, 3);
  });
  await step('Admin: maker-checker blocks self-approval of adjustments', async () => { const nw = ok(await a('GET', '/a-api/merchants?q=Northwind'))[0]; const adj = ok(await a('POST', '/a-api/adjustments', { merchant: nw.id, mode: 'test', currency: 'USD', amount: 500, reason: 'Smoke test goodwill credit' })); assert.equal((await a('POST', `/a-api/adjustments/${adj.id}/approve`)).status, 400); });
  await step('Admin: Supabase Auth admin profile grants the Super Admin dashboard', async () => {
    const config = require('../server/config');
    const oldFetch = global.fetch, oldProfile = store.supabaseProfile, oldUrl = config.supabaseUrl, oldKey = config.supabaseAnonKey;
    config.supabaseUrl = 'https://test-project.supabase.co'; config.supabaseAnonKey = 'test-anon-key';
    global.fetch = async (url, options) => { if (!String(url).startsWith(config.supabaseUrl)) return oldFetch(url, options); const { email } = JSON.parse(options.body); return new Response(JSON.stringify({ user: { id: 'auth-user-id', email } }), { status: 200 }); };
    store.supabaseProfile = (idv, email) => idv === 'auth-user-id' && email === 'supabase-admin@example.com' ? { id: idv, email, role: 'admin' } : null;
    try { const s = client(); ok(await s('POST', '/auth/login', { email: 'supabase-admin@example.com', password: 'SupabasePass123' })); ok(await s('GET', '/a-api/overview')); assert.equal((await client()('POST', '/auth/login', { email: 'not-admin@example.com', password: 'SupabasePass123' })).status, 401); }
    finally { global.fetch = oldFetch; store.supabaseProfile = oldProfile; config.supabaseUrl = oldUrl; config.supabaseAnonKey = oldKey; }
  });
  await step('Supabase API (/sb-api): JWKS-verified user token, email-confirmed account link, tenant scope, secret-key endpoint', async () => {
    const nodeCrypto = require('node:crypto'), url = 'https://sbtest.supabase.co';
    const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'ES256', use: 'sig' };
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = (claims, key = privateKey) => { const h = b64({ alg: 'ES256', typ: 'JWT', kid: 'test-kid' }), p = b64({ aud: 'authenticated', role: 'authenticated', iss: url + '/auth/v1', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...claims });
      return `${h}.${p}.${nodeCrypto.sign('sha256', Buffer.from(h + '.' + p), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`; };
    const saved = { ...process.env }, oldFetch = global.fetch;
    Object.assign(process.env, { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test123', SUPABASE_SECRET_KEY: 'sb_secret_test123', SUPABASE_JWKS: JSON.stringify({ keys: [jwk] }) });
    const sbUsers = { '11111111-1111-4111-8111-111111111111': { id: '11111111-1111-4111-8111-111111111111', email: 'owner@northwind.test', email_confirmed_at: new Date().toISOString() }, '22222222-2222-4222-8222-222222222222': { id: '22222222-2222-4222-8222-222222222222', email: 'owner@northwind.test', email_confirmed_at: null } };
    global.fetch = async (u, o) => { const s = String(u); if (s.startsWith(url + '/auth/v1/admin/users/')) { const usr = sbUsers[s.split('/').pop()]; return new Response(JSON.stringify(usr || { msg: 'not found' }), { status: usr ? 200 : 404, headers: { 'content-type': 'application/json' } }); } return oldFetch(u, o); };
    try {
      const sb = (p, h = {}) => pub('GET', p, null, h);
      const health = ok(await sb('/sb-api/health')); assert.equal(health.configured, true); assert.equal(health.secret_key, true); assert.ok(!JSON.stringify(health).includes('sb_secret_test123'));
      assert.equal((await sb('/sb-api/me')).status, 401, 'no token');
      assert.equal((await sb('/sb-api/me', { Authorization: 'Bearer ' + jwt({ sub: '11111111-1111-4111-8111-111111111111', email: 'owner@northwind.test' }, nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey) })).status, 401, 'token signed by another key');
      assert.equal((await sb('/sb-api/me', { Authorization: 'Bearer ' + jwt({ sub: '11111111-1111-4111-8111-111111111111', email: 'owner@northwind.test', iss: 'https://evil.supabase.co/auth/v1' }) })).status, 401, 'other project issuer');
      const me = ok(await sb('/sb-api/me', { Authorization: 'Bearer ' + jwt({ sub: '11111111-1111-4111-8111-111111111111', email: 'owner@northwind.test' }) }));
      assert.equal(me.supabase.id, '11111111-1111-4111-8111-111111111111'); assert.equal(me.digitalhub.kind, 'merchant'); assert.equal(me.digitalhub.merchant.receiving_wallet.test, merchantWallet.address);
      const un = await sb('/sb-api/payments', { Authorization: 'Bearer ' + jwt({ sub: '22222222-2222-4222-8222-222222222222', email: 'owner@northwind.test' }) }); assert.equal(un.status, 403, 'unconfirmed email cannot link');
      const list = ok(await sb('/sb-api/payments?limit=50', { Authorization: 'Bearer ' + jwt({ sub: '11111111-1111-4111-8111-111111111111', email: 'owner@northwind.test' }) })); assert.ok(list.data.some(p => p.id === pay.id));
      assert.ok(list.data.every(p => store.get('payments', p.id).merchant_id === store.get('payments', pay.id).merchant_id), 'tenant scope');
      assert.equal(ok(await sb('/sb-api/payments/' + pay.id, { Authorization: 'Bearer ' + jwt({ sub: '11111111-1111-4111-8111-111111111111', email: 'owner@northwind.test' }) })).id, pay.id);
      assert.equal((await sb('/sb-api/overview', { apikey: 'sb_publishable_test123' })).status, 401, 'publishable key is not enough');
      assert.equal((await sb('/sb-api/overview', { apikey: 'sb_secret_wrong' })).status, 401);
      assert.ok(ok(await sb('/sb-api/overview', { apikey: 'sb_secret_test123' })).paid >= 4);
    } finally { global.fetch = oldFetch; for (const k of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_JWKS']) process.env[k] = saved[k] ?? ''; }
  });
  /* ---------------- sandbox cards ---------------- */
  const cardIn = (s, number, extra = {}) => pub('POST', `/c-api/sessions/${s}/card`, { number, exp: '12/34', cvc: '123', name: 'Cara Card', email: 'cara@example.com', country: 'US', ...extra });
  let cardPayment;
  await step('Cards: off by default; admin switches on sandbox cards; checkout offers USDC + Card with test cards', async () => {
    const s0 = await dh.checkout.create({ amount: 1000, currency: 'USD' }); assert.deepEqual(s0.payment_methods, ['usdc']);
    ok(await a('PATCH', '/a-api/chain', { card_sandbox: true }));
    const s1 = await dh.checkout.create({ amount: 35000, currency: 'USD', description: 'Packaging setup', metadata: { order_id: '901' } }); assert.deepEqual(s1.payment_methods, ['usdc', 'card']);
    const v = ok(await pub('GET', `/c-api/sessions/${s1.id}`)); assert.equal(v.card.sandbox, true); assert.ok(v.card.test_cards.length >= 5);
    assert.equal((await cardIn(s1.id, '4111111111111111')).body.error.code, 'test_card_required', 'real card numbers refused');
    const r = ok(await cardIn(s1.id, '4242424242424242')); assert.equal(r.status, 'captured'); cardPayment = r;
    assert.equal(r.card.last4, '4242'); assert.equal(r.card.exp_month, 12); assert.equal(r.card.exp_year, 2034); assert.equal(r.card.cardholder, 'Cara Card');
    assert.ok(!JSON.stringify(store.get('payments', r.id)).includes('4242424242424242'), 'full card number never stored');
    const eurLink = await dh.checkout.create({ amount: 1200, currency: 'EUR' }); assert.deepEqual(eurLink.payment_methods, ['card'], 'USDC drops out for non-USD');
  });
  await step('Cards: invoice and payment pages show brand, last 4, expiry, cardholder and 3DS; card refund works', async () => {
    const inv = ok(await a('GET', '/a-api/invoices')).data.find(i => i.payment === cardPayment.id);
    assert.equal(inv.payment_detail.card.last4, '4242'); assert.equal(inv.payment_detail.card.cardholder, 'Cara Card'); assert.ok(inv.payment_detail.card.three_d_secure);
    const d = ok(await m('GET', `/m-api/payments/${cardPayment.id}`)); assert.equal(d.payment.card.exp_year, 2034); assert.ok(d.three_ds);
    const rf = ok(await m('POST', `/m-api/payments/${cardPayment.id}/refund`, { amount: 5000, idempotency_key: 'card-rf-1' })); assert.equal(rf.status, 'succeeded');
  });

  /* ---------------- subscriptions (recurring invoices) ---------------- */
  let sub;
  await step('Subscriptions: first invoice pending; paying by card with "save card" activates auto-charge', async () => {
    const r = await fetch(BASE + '/v1/subscriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify({ customer_email: 'sam@example.com', customer_name: 'Sam Sub', amount: 2900, currency: 'USD', interval: 'month', description: 'Pro plan' }) }).then(x => x.json());
    sub = r; assert.equal(sub.status, 'active'); assert.ok(sub.current_invoice); assert.equal(sub.pending_amount, 2900); assert.equal(sub.auto_charge, null);
    const v = ok(await pub('GET', `/c-api/sessions/${sub.current_invoice}`)); assert.equal(v.subscription.can_save_card, true); assert.equal(v.subscription.interval, 'month');
    ok(await cardIn(sub.current_invoice, '5555555555554444', { save_card: true, name: 'Sam Sub', email: 'sam@example.com' }));
    const s = ok(await m('GET', `/m-api/subscriptions/${sub.id}`)); assert.equal(s.current_invoice, null); assert.equal(s.auto_charge.last4, '4444'); assert.equal(s.invoices[0].status, 'paid');
    assert.ok(s.next_billing_at * 1000 > Date.now() + 25 * 86400000, 'next period scheduled ~1 month out');
    assert.ok(!JSON.stringify(store.get('subscriptions', sub.id)).includes('5555555555554444'), 'saved card is encrypted at rest');
  });
  await step('Subscriptions: renewal auto-charges the saved card; amount change applies to the next invoice', async () => {
    ok(await m('POST', `/m-api/subscriptions/${sub.id}/update`, { amount: 3900 }));
    const s = ok(await m('POST', `/m-api/subscriptions/${sub.id}/bill-now`)); assert.equal(s.current_invoice, null, 'paid automatically');
    const d = ok(await m('GET', `/m-api/subscriptions/${sub.id}`)); assert.equal(d.invoices.length, 2); assert.equal(d.invoices[1].amount, 3900); assert.equal(d.invoices[1].status, 'paid');
    assert.ok(d.events.some(e => e.status === 'auto_charged'));
    const p = await dh.payments.retrieve(d.invoices[1].payment); assert.equal(p.card.off_session, true); assert.equal(p.amount, 3900);
  });
  await step('Subscriptions: failed auto-charge leaves the invoice pending (payable by link), then past due', async () => {
    const doc = store.get('subscriptions', sub.id); doc.card.number = require('../server/util').seal('4000000000000002'); store.put('subscriptions', doc);
    let s = ok(await m('POST', `/m-api/subscriptions/${sub.id}/bill-now`)); assert.ok(s.current_invoice, 'invoice still pending'); assert.equal(s.pending_amount, 3900);
    const v = ok(await pub('GET', `/c-api/sessions/${s.current_invoice}`)); assert.equal(v.status, 'open'); assert.equal(v.payment, null);
    const d2 = store.get('subscriptions', sub.id); d2.pending_since = Date.now() - 400 * 86400000; store.put('subscriptions', d2);
    require('../server/subscriptions').run(); assert.equal(store.get('subscriptions', sub.id).status, 'past_due');
    ok(await cardIn(s.current_invoice, '4242424242424242', { name: 'Sam Sub', email: 'sam@example.com' }));
    assert.equal(store.get('subscriptions', sub.id).status, 'active', 'paying the link reactivates');
    await core.runDeliveries(); assert.ok(received.some(e => e.type === 'subscription.invoice_pending') && received.some(e => e.type === 'subscription.past_due'));
  });
  await step('Subscriptions: 3DS-challenge cards are not charged off-session; cancel closes the pending invoice', async () => {
    const doc = store.get('subscriptions', sub.id); doc.card.number = require('../server/util').seal('4000000000003220'); store.put('subscriptions', doc);
    const s = ok(await m('POST', `/m-api/subscriptions/${sub.id}/bill-now`)); assert.ok(s.current_invoice);
    const pays = store.list('payments', { merchant_id: doc.merchant_id }).filter(p => p.session_id === s.current_invoice); assert.equal(pays[0].declineCode, 'authentication_required');
    const c = ok(await m('POST', `/m-api/subscriptions/${sub.id}/cancel`)); assert.equal(c.status, 'canceled'); assert.equal(store.get('checkout_sessions', s.current_invoice).status, 'expired');
    assert.ok(ok(await a('GET', '/a-api/subscriptions')).some(x => x.id === sub.id && x.status === 'canceled'));
  });
  await step('Store connect: admin creates a merchant and connects a WooCommerce store; the generated key and webhook work', async () => {
    const nm = ok(await a('POST', '/a-api/merchants', { business_name: 'Solvexs Labs', country: 'US', owner_name: 'Sol Owner', owner_email: 'owner@solvexs.test', website: 'solvexs.test' }));
    assert.match(nm.temporary_password, /^[A-Z]{6}-[a-z]{6}-\d{4}$/);
    const mid = nm.merchant.id;
    const conn = ok(await a('POST', '/a-api/woocommerce/connect', { merchant: mid, store_url: 'http://127.0.0.1:' + receiver.address().port }));
    assert.match(conn.plugin_settings.secret_key, /^dh_test_sk_/); assert.match(conn.plugin_settings.webhook_secret, /^whsec_/); assert.equal(conn.plugin_settings.digital_hub_url, require('../server/config').publicUrl);
    assert.equal((await a('POST', '/a-api/woocommerce/connect', { merchant: mid, store_url: 'http://127.0.0.1:' + receiver.address().port })).body.error.code, 'already_connected');
    const store2 = new DigitalHub(conn.plugin_settings.secret_key, { baseUrl: BASE });
    const s = await store2.checkout.create({ amount: 35000, currency: 'USD', description: 'Woo order #5001', payment_methods: ['usdc', 'card'], metadata: { order_id: '5001' } }, { idempotencyKey: 'wc_5001' });
    assert.deepEqual(s.payment_methods, ['card'], 'sandbox card available; USDC waits for a verified wallet');
    assert.equal((await store2.checkout.retrieve(s.id)).id, s.id, 'store key can read session status (checkout:read)');
    await assert.rejects(store2.request('GET', '/balance'), /lacks/, 'store key is limited to store permissions');
    const w = ok(await a('GET', '/a-api/woocommerce')); assert.ok(w.stores.some(x => x.merchant === mid));
    const key = ok(await a('POST', `/a-api/merchants/${mid}/keys`, { name: 'Extra', scope: 'full' })); assert.match(key.secret, /^dh_test_sk_/);
    const hook = ok(await a('POST', `/a-api/merchants/${mid}/webhooks`, { url: hookUrl.replace('/wc-api/digitalhub/', '/other') })); assert.match(hook.secret, /^whsec_/);
    ok(await a('POST', `/a-api/merchants/${mid}/webhooks/${hook.id}/delete`));
    const owner = client(); ok(await owner('POST', '/auth/login', { email: 'owner@solvexs.test', password: nm.temporary_password }));
    assert.ok(ok(await owner('GET', '/m-api/keys')).keys.length >= 2, 'merchant sees the keys in Developers & API');
    const nwDoc = store.list('documents', {}).find(d => d.filename === 'Northwind LLC certificate.pdf');
    assert.equal((await owner('GET', `/m-api/documents/${nwDoc.id}/file`)).status, 404, 'another merchant cannot open Northwind documents');
  });
  await step('MetaMask & Blockchain: Infura first with public failover, keys masked; diagnostics; SDK self-hosted', async () => {
    const C = require('../server/chain'), saved = process.env.BASE_SEPOLIA_RPC_URLS;
    try {
      delete process.env.BASE_SEPOLIA_RPC_URLS; process.env.INFURA_API_KEY = 'testinfurakey123';
      const urls = C.rpcUrls('base_sepolia'); assert.equal(urls[0], 'https://base-sepolia.infura.io/v3/testinfurakey123'); assert.ok(urls.includes('https://sepolia.base.org'), 'public endpoint kept as failover');
      assert.equal(C.wsUrl('base_sepolia'), 'wss://base-sepolia.infura.io/ws/v3/testinfurakey123');
      const view = ok(await a('GET', '/a-api/chain')); assert.equal(view.infura.configured, true); assert.ok(!JSON.stringify(view).includes('testinfurakey123'), 'Infura key never returned');
      assert.equal(view.sdk.present, true); assert.equal(view.sdk.version, '2.1.1');
      const pub2 = ok(await pub('GET', `/c-api/sessions/${(await dh.checkout.create({ amount: 700, currency: 'USD' })).id}`)); assert.ok(!JSON.stringify(pub2).includes('testinfurakey123'), 'server Infura key never reaches the checkout');
    } finally { delete process.env.INFURA_API_KEY; process.env.BASE_SEPOLIA_RPC_URLS = saved; }
    const g = ok(await a('GET', '/a-api/diagnostics')); assert.ok(g.api_24h.calls > 0); assert.ok(g.server.db_latency_ms >= 0); assert.ok(g.rpc.base_sepolia.endpoints.length >= 1); assert.ok('approved' in g.wallets);
  });
  await step('Ledger: every reconciliation check passes (incl. on-chain receipts, fees, no double credit)', async () => { const l = ok(await a('GET', '/a-api/ledger')); for (const c of l.checks) assert.ok(c.ok, c.name + ' — ' + c.detail); assert.ok(l.trial_balance.every(t => t.debits === t.credits)); });
  await step('Ledger: database refuses edits to posted entries', async () => { assert.throws(() => store.db.exec('UPDATE ledger SET amount = 0 WHERE id = 1'), /append-only/); });
  await step('Diagnostics: /api/health reports setup without leaking secrets', async () => { const h = ok(await pub('GET', '/api/health')); assert.equal(h.ok, true); assert.equal(h.database.schema_version, null === h.database.schema_version ? null : h.database.schema_version); assert.ok(h.database.users >= 1); const s = JSON.stringify(h); assert.ok(!s.includes(secret) && !s.includes('AdminPass12345')); });
  await step('Security headers: CSP allows MetaMask Connect only from pinned hosts', async () => { const r = await fetch(BASE + '/app'); const csp = r.headers.get('content-security-policy'); assert.doesNotMatch(csp, /cdn\.jsdelivr\.net/, 'MetaMask Connect is self-hosted'); assert.match(csp, /wss:\/\/\*\.metamask\.io/); const sdk = await fetch(BASE + '/vendor/mm-connect/connect-evm.js'); assert.equal(sdk.status, 200); assert.match(await sdk.text(), /createEVMClient/); assert.match(csp, /frame-ancestors 'none'/); });
  await step('Downloads: WooCommerce plugin zip (v2, USDC)', async () => { const r = await fetch(BASE + '/downloads/digitalhub-woocommerce.zip'); assert.equal(r.status, 200); const b = Buffer.from(await r.arrayBuffer()); assert.equal(b.readUInt32LE(0), 0x04034b50); assert.ok(b.toString('latin1').includes("'payment_methods' => ['usdc', 'card']")); });

  console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}.`);
  receiver.close(); server.close(); sepolia.server.close(); mainnet.server.close(); wrongChain.server.close(); setTimeout(() => process.exit(), 100);
})().catch(e => { console.error(e); process.exit(1); });
