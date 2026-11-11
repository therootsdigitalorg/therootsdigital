'use strict';
/* Browser UI test: headless Chrome/Edge (DevTools protocol, no extra dependencies) against the real server and a
   fake Base Sepolia node. A simulated MetaMask (EIP-6963 provider announcing io.metamask) signs with test keys and
   broadcasts transfers to the fake chain, so the real checkout page, dashboards and server verification run end to end.
   Visits every Super Admin and merchant page, every tab, opens drawers, and fails on any JS error or page error.
   Usage: npm run test:ui   (CHROME_PATH=/path/to/chrome to override detection; SCREENSHOTS=dir to save PNGs) */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { fakeChain, wallet } = require('./fake-chain');

const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
if (!CHROME) { console.log('No Chrome / Edge found — set CHROME_PATH. Skipping UI test.'); process.exit(0); }
const SHOTS = process.env.SCREENSHOTS || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

let passed = 0, failed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.error('  ✗', name, '\n   ', String(e.message).slice(0, 1500)); process.exitCode = 1; } };

/* ---------- minimal CDP client ---------- */
async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1366,900', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const t = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let seq = 0; const waiting = {}, handlers = {};
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && waiting[m.id]) { const w = waiting[m.id]; delete waiting[m.id]; m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } else if (m.method) (handlers[m.method] || []).forEach(f => f(m.params)); };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting[id] = { res, rej }; ws.send(JSON.stringify({ id, method, params })); });
  const on = (ev, f) => (handlers[ev] ||= []).push(f);
  return { send, on, close: () => { try { ws.close(); } catch {} proc.kill(); } };
}

(async () => {
  const sepolia = fakeChain({ chainId: 84532, usdc: SEPOLIA_USDC });
  const sepUrl = await sepolia.listen();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-ui-'));
  Object.assign(process.env, { DB_PATH: path.join(tmp, 'ui.db'), PORT: '0', SEED_DEMO: '1', ADMIN_PASSWORD: 'AdminPass12345', NODE_ENV: 'test', ALLOW_PRIVATE_WEBHOOKS: '1', BASE_SEPOLIA_RPC_URLS: sepUrl, CHAIN_POLL_MS: '1500', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SECRET_KEY: '', SUPABASE_JWKS_URL: '' });
  const { server, start } = require('../server/index');
  let BASE; await new Promise(r => { const orig = server.listen.bind(server); server.listen = (port, cb) => orig(0, () => { BASE = `http://127.0.0.1:${server.address().port}`; process.env.PUBLIC_URL = BASE; cb && cb(); r(); }); start(); });
  const creds = fs.readFileSync(path.join(tmp, 'first-run-credentials.txt'), 'utf8');
  const merchantPw = creds.match(/owner@northwind\.test\s+password: (\S+)/)[1], secretKey = creds.match(/dh_test_sk_\w+/)[0];
  console.log(`\nDigital Hub UI test · ${path.basename(CHROME)} headless · ${BASE}\n`);

  /* ---------- simulated MetaMask wallet (keys stay in Node) ---------- */
  const merchantWallet = wallet(), customer = wallet();
  const keys = { [merchantWallet.address.toLowerCase()]: merchantWallet, [customer.address.toLowerCase()]: customer };
  const mm = { account: merchantWallet.address, chainId: '0x1', calls: [], connected: false };
  const b = await launch();
  const errors = [];
  await b.send('Runtime.enable'); await b.send('Page.enable'); await b.send('Log.enable');
  b.on('Runtime.exceptionThrown', p => errors.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
  b.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') errors.push('console.error: ' + p.args.map(a => a.value || a.description).join(' ')); });
  b.on('Log.entryAdded', p => { if (p.entry.level === 'error' && !/favicon|fonts\.g|net::ERR_|status of 4\d\d/.test(p.entry.text + (p.entry.url || ''))) errors.push('log: ' + p.entry.text + ' ' + (p.entry.url || '')); });
  await b.send('Runtime.addBinding', { name: 'dhWallet' });
  b.on('Runtime.bindingCalled', async p => {
    if (p.name !== 'dhWallet') return;
    const { i, method, params } = JSON.parse(p.payload); mm.calls.push(method);
    let ok = true, val;
    try {
      if (method === 'eth_requestAccounts') { mm.connected = true; val = [mm.account]; }
      else if (method === 'eth_accounts') val = mm.connected ? [mm.account] : [];
      else if (method === 'eth_chainId') val = mm.chainId;
      else if (method === 'wallet_switchEthereumChain') mm.chainId = params[0].chainId.toLowerCase(), val = null;
      else if (method === 'wallet_addEthereumChain') val = null;
      else if (method === 'personal_sign') val = keys[params[1].toLowerCase()].sign(Buffer.from(params[0].slice(2), 'hex').toString('utf8'));
      else if (method === 'eth_getBalance') val = '0xde0b6b3a7640000';
      else if (method === 'eth_call') val = '0x' + (10n ** 12n).toString(16).padStart(64, '0');
      else if (method === 'eth_sendTransaction') { const tx = params[0], d = tx.data.slice(10); val = sepolia.transfer({ token: tx.to, from: tx.from, to: '0x' + d.slice(24, 64), value: BigInt('0x' + d.slice(64, 128)).toString() }); }
      else throw Object.assign(new Error('unsupported ' + method), { code: 4200 });
    } catch (e) { ok = false; val = { message: e.message, code: e.code || -32603 }; }
    await b.send('Runtime.evaluate', { expression: `window.__dhResolve(${i}, ${ok}, ${JSON.stringify(val)})` });
  });
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    let id = 0; const pending = {}; window.__dhResolve = (i, ok, val) => { const p = pending[i]; delete pending[i]; ok ? p.res(val) : p.rej(Object.assign(new Error(val.message), { code: val.code })); };
    const provider = { isMetaMask: true, request: ({ method, params }) => new Promise((res, rej) => { const i = ++id; pending[i] = { res, rej }; window.dhWallet(JSON.stringify({ i, method, params: params || [] })); }), on() {}, removeListener() {} };
    const announce = () => window.__noMetaMask ? null : window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'ui-test', name: 'MetaMask', icon: 'data:,', rdns: 'io.metamask' }, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
  })();` });

  const evaluate = async expr => { const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const waitFor = async (expr, ms = 8000, what = expr) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(expr)) return true; } catch {} await sleep(120); } let seen = ''; try { seen = (await evaluate('document.body.innerText')).replace(/\s+/g, ' ').slice(0, 600); } catch {} throw new Error('Timed out waiting for: ' + what + '\n    page shows: ' + seen + (errors.length ? '\n    JS errors: ' + errors.join(' | ') : '')); };
  const goto = async url => { await b.send('Page.navigate', { url }); await sleep(250); await waitFor('document.readyState === "complete"'); };
  const shot = async name => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const { data } = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64')); };
  const click = sel => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no element ${sel.replace(/'/g, '')}'); el.click(); return true; })()`);
  const text = () => evaluate('document.body.innerText');
  const pageOk = async route => {
    const want = route.split(' ')[0]; await waitFor(`!document.querySelector('#main .loading') && !!document.querySelector('#main .page') && document.querySelector('#main').dataset.route === ${JSON.stringify(want)}`, 10000, 'page ' + route);
    const bad = await evaluate(`[...document.querySelectorAll('#main .note.danger')].map(n => n.innerText).filter(t => /Could not load this page/.test(t)).join(' | ')`);
    if (bad) throw new Error(route + ': ' + bad);
  };
  const login = async (email, pw) => {
    await goto(BASE + '/app');
    await waitFor(`!!document.querySelector('form[data-form=login]') || !!document.querySelector('#main')`);
    if (await evaluate(`!!document.querySelector('#main')`)) { await evaluate(`fetch('/auth/logout',{method:'POST',headers:{'X-Requested-With':'DigitalHub'}})`); await goto(BASE + '/app'); }
    await waitFor(`!!document.querySelector('form[data-form=login]')`);
    await evaluate(`(() => { const f = document.querySelector('form[data-form=login]'); f.email.value = ${JSON.stringify(email)}; f.password.value = ${JSON.stringify(pw)}; f.requestSubmit(); return true; })()`);
    await waitFor(`!!document.querySelector('#main .page')`, 10000, 'dashboard after login');
  };
  /** Visit a route, then click every tab on it and open the first drawer row. */
  const visit = async (route, { tabsToo = true, drawer = true } = {}) => {
    await evaluate(`location.hash = '#/${route}'`); await sleep(150); await pageOk(route);
    if (tabsToo) {
      const tabs = await evaluate(`[...document.querySelectorAll('#main [role=tab]')].map(t => t.dataset.group + '|' + t.dataset.tab)`);
      for (const t of tabs) { const [g, k] = t.split('|'); await click(`#main [role=tab][data-group="${g}"][data-tab="${k}"]`); await sleep(120); await pageOk(`${route} tab ${k}`); }
    }
    if (drawer && await evaluate(`!!document.querySelector('#main tr.click')`)) {
      await click('#main tr.click'); await waitFor(`!!document.querySelector('#drawerHost .drawer') && !document.querySelector('#drBody .loading')`, 8000, route + ' drawer');
      const dErr = await evaluate(`[...document.querySelectorAll('#drBody .note.danger')].map(n => n.innerText).filter(t => /^Error/.test(t)).join('')`);
      if (dErr) throw new Error(route + ' drawer: ' + dErr);
      const dTabs = await evaluate(`[...document.querySelectorAll('#drBody [role=tab]')].map(t => t.dataset.group + '|' + t.dataset.tab)`);
      for (const t of dTabs) { const [g, k] = t.split('|'); await click(`#drBody [role=tab][data-group="${g}"][data-tab="${k}"]`); await sleep(200); await waitFor(`!document.querySelector('#drBody .loading')`); }
      await click('#drawerHost .x');
    }
  };
  const noErrors = label => { if (errors.length) { const e = errors.splice(0); throw new Error(label + ' JS errors:\n' + e.join('\n')); } };

  /* ================= merchant ================= */
  await step('Merchant: sign in through the login form', async () => { await login('owner@northwind.test', merchantPw); assert.match(await text(), /Northwind/); noErrors('login'); });
  await step('Merchant: receiving wallet verified through MetaMask in the UI (fake wallet signs EIP-4361)', async () => {
    await evaluate(`location.hash = '#/wallet'`); await pageOk('wallet');
    await click('[data-act=addWallet]'); await waitFor(`!!document.querySelector('#w-addr')`);
    await click('[data-act=walletFromMM]'); await waitFor(`document.querySelector('#w-addr').value.length === 42`, 5000, 'address from MetaMask');
    await evaluate(`document.querySelector('form[data-form=wallet]').requestSubmit()`);
    await waitFor(`/Wallet ownership verified/.test(document.body.innerText)`, 10000, 'verified toast');
    await waitFor(`/verified/.test(document.querySelector('#main table')?.innerText || '')`);
    assert.ok(mm.calls.includes('personal_sign')); await shot('merchant-wallet'); noErrors('wallet');
  });
  await step('Merchant: every page, tab and drawer renders without errors', async () => {
    for (const r of ['home', 'payments', 'subscriptions', 'links', 'refunds', 'wallet', 'balances', 'developers', 'integrations', 'golive', 'settings', 'account']) await visit(r);
    await evaluate(`location.hash = '#/home'`); await pageOk('home'); await shot('merchant-home'); noErrors('merchant pages');
  });
  await step('Merchant: create a payment link through the modal', async () => {
    await evaluate(`location.hash = '#/links'`); await pageOk('links');
    await click('#main [data-act=newLink]'); await waitFor(`!!document.querySelector('form[data-form=link]')`);
    await evaluate(`(() => { const f = document.querySelector('form[data-form=link]'); f.amount.value = '19.99'; f.description.value = 'UI test hoodie'; f.requestSubmit(); return true; })()`);
    await waitFor(`/Share payment link/.test(document.querySelector('#dlg')?.innerText || '')`); await evaluate(`document.querySelector('#dlg').close()`);
    await waitFor(`/UI test hoodie/.test(document.querySelector('#main').innerText)`); noErrors('link');
  });

  /* ================= customer checkout with MetaMask ================= */
  const r = await fetch(BASE + '/v1/checkout/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + secretKey, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 2500, currency: 'USD', description: 'UI order #77', payment_methods: ['usdc'], customer_email: 'ui@example.com', metadata: { order_id: '77' }, success_url: 'https://shop.example/thanks' }) }).then(r => r.json());
  await step('Checkout: connect → switch network → sign → pay → verifying → paid (real page, simulated MetaMask)', async () => {
    mm.account = customer.address; mm.chainId = '0x1'; mm.connected = false; // a fresh customer browser
    await goto(BASE + '/pay/' + r.id); await waitFor(`!!document.querySelector('#connect')`, 8000, 'connect button'); await shot('checkout-connect');
    assert.match(await text(), /25\.00 USDC/); assert.match(await text(), /Base Sepolia/);
    await click('#connect'); await waitFor(`!!document.querySelector('#switch')`, 8000, 'switch network button');
    await click('#switch'); await waitFor(`!!document.querySelector('#confirm')`, 8000, 'confirm wallet button'); assert.equal(mm.chainId, '0x14a34');
    await click('#confirm'); await waitFor(`!!document.querySelector('#send')`, 10000, 'pay button'); await shot('checkout-pay');
    await click('#send'); await waitFor(`/Verifying on Base Sepolia/.test(document.body.innerText)`, 10000, 'verifying screen'); await shot('checkout-verifying');
    assert.doesNotMatch(await text(), /Payment received/, 'must not show paid before confirmations');
    sepolia.mine(3);
    await waitFor(`/Payment received/.test(document.body.innerText)`, 20000, 'paid screen'); await shot('checkout-paid');
    assert.match(await text(), /Transaction/); noErrors('checkout');
  });
  await step('Checkout: page without MetaMask offers install / MetaMask Mobile instead of failing', async () => {
    const s2 = await fetch(BASE + '/v1/checkout/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + secretKey, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 900, currency: 'USD', payment_methods: ['usdc'] }) }).then(r => r.json());
    const { identifier } = await b.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__noMetaMask = true;' });
    await goto(BASE + '/pay/' + s2.id); await waitFor(`/MetaMask was not found/.test(document.body.innerText)`, 8000);
    assert.match(await text(), /Install MetaMask|Open in MetaMask app/); assert.ok(await evaluate(`!!document.querySelector('#connectMobile')`));
    await b.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); noErrors('no-metamask');
  });

  /* ================= merchant refund through MetaMask ================= */
  await step('Merchant: refund created and sent with MetaMask from the dashboard, verified on-chain', async () => {
    mm.account = merchantWallet.address; mm.connected = true;
    await login('owner@northwind.test', merchantPw);
    await evaluate(`location.hash = '#/payments'`); await pageOk('payments'); await click('#main tr.click');
    await waitFor(`!!document.querySelector('#drFoot [data-act=refundPayment]')`, 8000, 'refund button');
    await click('#drFoot [data-act=refundPayment]'); await waitFor(`!!document.querySelector('form[data-form=refund]')`);
    await evaluate(`(() => { const f = document.querySelector('form[data-form=refund]'); f.amount.value = '5.00'; f.requestSubmit(); return true; })()`);
    await waitFor(`!!document.querySelector('#drFoot [data-act=sendRefund]')`, 10000, 'send refund button'); await shot('merchant-refund');
    await click('#drFoot [data-act=sendRefund]'); await waitFor(`/verifying on-chain/i.test(document.body.innerText)`, 10000);
    sepolia.mine(3); await sleep(2500);
    await evaluate(`location.hash = '#/home'`); await pageOk('home'); await evaluate(`location.hash = '#/refunds'`); await pageOk('refunds'); try { await waitFor(`/succeeded/.test(document.querySelector('#main table').innerText)`, 10000, 'refund succeeded'); } catch (e) { console.log(JSON.stringify(require('../server/db').list('refunds', {}).map(r => ({ s: r.status, tx: r.tx, to: r.to, from: r.from, amt: r.amountUnits, ev: r.events })), null, 1), JSON.stringify(require('../server/usdc').status)); throw e; }
    noErrors('refund');
  });

  /* ================= super admin ================= */
  await step('Admin: sign in and visit every Super Admin page, tab and drawer', async () => {
    await login('admin@digitalhub.local', 'AdminPass12345');
    const routes = await evaluate(`NAV.admin.flatMap(([, items]) => items.map(([k]) => k))`);
    assert.deepEqual(routes, ['a-overview', 'a-merchants', 'a-payments', 'a-invoices', 'a-subscriptions', 'a-wallet', 'a-settlements', 'a-refunds', 'a-ledger', 'a-woo', 'a-apilogs', 'a-webhooks', 'a-risk', 'a-approvals', 'a-audit', 'a-staff', 'a-settings']);
    for (const rt of routes) { await visit(rt); if (['a-overview', 'a-wallet', 'a-settings', 'a-payments', 'a-risk'].includes(rt)) await shot(rt); }
    noErrors('admin pages');
  });
  await step('Admin: Digital Wallet approve flow, Settings probe, production checks and statement buttons', async () => {
    await evaluate(`location.hash = '#/a-wallet'`); await pageOk('a-wallet');
    await click('#main [data-act=walletProof]'); await waitFor(`/Signed message/.test(document.querySelector('#dlg').innerText)`);
    await click('#dlg [data-act=walletRecheck]'); await waitFor(`/recovers to the wallet/.test(document.body.innerText)`); await evaluate(`document.querySelector('#dlg').close()`);
    await click('#main [data-act=walletReview][data-ok="1"]'); await waitFor(`!!document.querySelector('form[data-form=walletReview]')`);
    await evaluate(`(() => { const f = document.querySelector('form[data-form=walletReview]'); f.note.value = 'Screened OK'; f.requestSubmit(); return true; })()`);
    await waitFor(`/approved/.test(document.querySelector('#main table').innerText)`);
    await evaluate(`location.hash = '#/a-settings'`); await pageOk('a-settings'); await click('#main [role=tab][data-tab="metamask"]'); await waitFor("!!document.querySelector('#main [data-act=probeNet]')", 10000, 'MetaMask settings tab');
    await click('#main [data-act=probeNet][data-key=base_sepolia]'); await waitFor(`/RPC endpoints and USDC contract verified/.test(document.body.innerText)`, 10000);
    await click('#main [data-act=prodChecks]'); await waitFor(`/Not ready|Ready/.test(document.querySelector('#prodOut').innerText)`, 20000); await shot('a-settings-checks');
    await click('#main [data-act=editFeeWallet]'); await waitFor(`!!document.querySelector('form[data-form=feeWallet]')`);
    await evaluate(`(() => { const f = document.querySelector('form[data-form=feeWallet]'); f.fee_wallet.value = ${JSON.stringify(wallet().address)}; f.requestSubmit(); return true; })()`); await waitFor(`/Fee wallet saved/.test(document.body.innerText)`);
    await evaluate(`location.hash = '#/a-settlements'`); await pageOk('a-settlements');
    await click('#main [data-act=newStatement]'); await click('#dlg [data-act=confirmDo]'); await waitFor(`/open/.test(document.querySelectorAll('#main table')[1]?.innerText || '')`, 8000, 'statement issued');
    noErrors('admin actions');
  });
  await step('Cards: admin enables sandbox cards in Settings; customer pays by card on the checkout (tabs, test card, receipt details)', async () => {
    await evaluate(`location.hash = '#/a-settings'`); await pageOk('a-settings'); await click('#main [role=tab][data-tab="metamask"]'); await waitFor("!!document.querySelector('[data-change=cardToggle]')", 10000, 'card toggle');
    await evaluate(`(() => { const el = document.querySelector('[data-change=cardToggle]'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(`/Card payments enabled/.test(document.body.innerText)`, 8000);
    const s = await fetch(BASE + '/v1/checkout/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + secretKey, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 35000, currency: 'USD', description: 'Custom Packaging & Labeling Setup', customer_email: 'buyer@example.com' }) }).then(r => r.json());
    await goto(BASE + '/pay/' + s.id); await waitFor(`!!document.querySelector('[data-method=card]')`, 8000, 'method tabs');
    await click('[data-method=card]'); await waitFor(`!!document.querySelector('#k-num')`); await shot('checkout-card');
    await evaluate(`document.querySelector('details').open = true`); await click('[data-tcard="4000000000003220"]');
    await evaluate(`(() => { document.getElementById('k-name').value = 'Rahman Buyer'; return true; })()`);
    await click('#payCard'); await waitFor(`!!document.querySelector('#otp')`, 8000, '3DS step');
    await evaluate(`document.getElementById('otp').value = '123456'`); await click('#otpGo');
    await waitFor(`/Payment received/.test(document.body.innerText)`, 10000, 'card receipt'); await shot('checkout-card-paid');
    const t = await text(); assert.match(t, /Visa •••• 3220/); assert.match(t, /12\/34/); assert.match(t, /Rahman Buyer/); assert.match(t, /authenticated/);
    await login('admin@digitalhub.local', 'AdminPass12345'); await evaluate(`location.hash = '#/a-invoices'`); await pageOk('a-invoices');
    await waitFor(`/Visa ••••3220/.test(document.querySelector('#main table').innerText)`, 8000, 'card on invoices page'); await shot('a-invoices-card');
    noErrors('cards');
  });
  await step('Admin: New merchant + Connect a store produce working plugin settings (UI)', async () => {
    await evaluate("location.hash = '#/a-merchants'"); await pageOk('a-merchants'); await click('#main [data-act=newMerchant]');
    await waitFor("!!document.querySelector('form[data-form=newMerchant]')");
    await evaluate("(() => { const f = document.querySelector('form[data-form=newMerchant]'); f.business_name.value = 'Solvexs'; f.owner_name.value = 'Sol Owner'; f.owner_email.value = 'owner@solvexs.example'; f.requestSubmit(); return true; })()");
    await waitFor("/Merchant created/.test(document.querySelector('#dlg').innerText)", 8000, 'merchant created modal'); await evaluate("document.querySelector('#dlg').close()");
    await evaluate("location.hash = '#/a-woo'"); await pageOk('a-woo'); await click('#main [data-act=wooConnect]');
    await waitFor("!!document.querySelector('form[data-form=wooConnect]')", 8000, 'connect form');
    await evaluate("(() => { const f = document.querySelector('form[data-form=wooConnect]'); f.merchant.value = [...f.merchant.options].find(o => o.text === 'Solvexs').value; f.store_url.value = 'https://shop.solvexs.example'; f.requestSubmit(); return true; })()");
    await waitFor("/Store connected/.test(document.querySelector('#dlg').innerText)", 10000, 'connected modal'); await shot('a-woo-connected');
    const txt = await evaluate("document.querySelector('#dlg').innerText"); assert.match(txt, /dh_test_sk_/); assert.match(txt, /whsec_/); assert.match(txt, /wc-api\/digitalhub/);
    await evaluate("document.querySelector('#dlg').close()"); noErrors('store connect');
  });
  await step('Responsive: admin console has no horizontal page scroll at phone width', async () => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    for (const rt of ['a-overview', 'a-settings', 'a-wallet']) { await evaluate(`location.hash = '#/${rt}'`); await pageOk(rt); const over = await evaluate('document.documentElement.scrollWidth - window.innerWidth'); assert.ok(over <= 1, `${rt} overflows by ${over}px`); }
    await shot('a-overview-mobile');
    await b.send('Emulation.clearDeviceMetricsOverride'); noErrors('responsive');
  });

  console.log(`\n${passed} UI checks passed${failed ? `, ${failed} FAILED` : ''}.${SHOTS ? ' Screenshots: ' + SHOTS : ''}`);
  b.close(); server.close(); sepolia.server.close(); setTimeout(() => process.exit(), 200);
})().catch(e => { console.error(e); process.exit(1); });
