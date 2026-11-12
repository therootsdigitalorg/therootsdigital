'use strict';
/* Browser UI test of the single-business console (default platform): headless Chrome/Edge over the DevTools protocol against the
   real server, a fake Authorize.Net (JSON API + hosted page) and a fake Base Sepolia node, with a simulated MetaMask (EIP-6963).
   Covers mandatory 2FA enrollment, the 15-page sidebar, Authorize.Net setup, a payment link paid through the hosted page and
   verified server-side, wallet ownership by signature, every page / tab / drawer, readiness gates and phone width.
   Usage: npm run test:ui   (CHROME_PATH to override detection; SCREENSHOTS=dir to save PNGs) */
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
  const { fakeAnet } = require('./fake-anet');
  const LOGIN = 'UiLogin123', TKEY = 'Zyxw9876Vuts5432', SIGKEY = 'CD34'.repeat(32);
  const anetFake = fakeAnet({ loginId: LOGIN, transactionKey: TKEY }); const anetUrl = await anetFake.listen();
  const sepolia = fakeChain({ chainId: 84532, usdc: SEPOLIA_USDC });
  const sepUrl = await sepolia.listen();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-uic-'));
  Object.assign(process.env, { MULTI_MERCHANT: '0', DB_PATH: path.join(tmp, 'ui.db'), PORT: '0', SEED_DEMO: '1', ADMIN_PASSWORD: 'AdminPass12345', NODE_ENV: 'test', ALLOW_PRIVATE_WEBHOOKS: '1', BASE_SEPOLIA_RPC_URLS: sepUrl, CHAIN_POLL_MS: '3600000',
    ANET_SANDBOX_API_URL: anetUrl + '/xml/v1/request.api', ANET_SANDBOX_HOSTED_URL: anetUrl + '/payment/payment', ANET_SANDBOX_REST_URL: anetUrl + '/rest/v1',
    SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SECRET_KEY: '', SUPABASE_JWKS_URL: '' });
  for (const k of ['REQUIRE_STAFF_MFA', 'ANET_SANDBOX_LOGIN_ID', 'INFURA_API_KEY', 'LIVE_PAYMENTS']) delete process.env[k];
  const { server, start } = require('../server/index');
  const U = require('../server/util'), store = require('../server/db');
  let BASE; await new Promise(r => { const orig = server.listen.bind(server); server.listen = (port, cb) => orig(0, () => { BASE = `http://127.0.0.1:${server.address().port}`; process.env.PUBLIC_URL = BASE; cb && cb(); r(); }); start(); });
  console.log(`\nDIGITAL HUB console UI test · ${path.basename(CHROME)} headless · ${BASE}\n`);

  const bizWallet = wallet();
  const mm = { account: bizWallet.address, chainId: '0x1', calls: [], connected: false };
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
      else if (method === 'personal_sign') val = bizWallet.sign(Buffer.from(params[0].slice(2), 'hex').toString('utf8'));
      else throw Object.assign(new Error('unsupported ' + method), { code: 4200 });
    } catch (e) { ok = false; val = { message: e.message, code: e.code || -32603 }; }
    await b.send('Runtime.evaluate', { expression: `window.__dhResolve(${i}, ${ok}, ${JSON.stringify(val)})` });
  });
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    let id = 0; const pending = {}; window.__dhResolve = (i, ok, val) => { const p = pending[i]; delete pending[i]; ok ? p.res(val) : p.rej(Object.assign(new Error(val.message), { code: val.code })); };
    const provider = { isMetaMask: true, request: ({ method, params }) => new Promise((res, rej) => { const i = ++id; pending[i] = { res, rej }; window.dhWallet(JSON.stringify({ i, method, params: params || [] })); }), on() {}, removeListener() {} };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'ui-test', name: 'MetaMask', icon: 'data:,', rdns: 'io.metamask' }, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
  })();` });

  const evaluate = async expr => { const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const waitFor = async (expr, ms = 8000, what = expr) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(expr)) return true; } catch {} await sleep(120); } let seen = ''; try { seen = (await evaluate('document.body.innerText')).replace(/\s+/g, ' ').slice(0, 600); } catch {} throw new Error('Timed out waiting for: ' + what + '\n    page shows: ' + seen + (errors.length ? '\n    JS errors: ' + errors.join(' | ') : '')); };
  const goto = async url => { await b.send('Page.navigate', { url }); await sleep(250); await waitFor('document.readyState === "complete"'); };
  const shot = async name => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const { data } = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64')); };
  const click = sel => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no element ${sel.replace(/'/g, '')}'); el.click(); return true; })()`);
  const text = () => evaluate('document.body.innerText');
  const fill = (formSel, vals) => evaluate(`(() => { const f = document.querySelector(${JSON.stringify(formSel)}); if (!f) throw new Error('no form'); for (const [k, v] of Object.entries(${JSON.stringify(vals)})) f.elements[k].value = v; f.requestSubmit(); return true; })()`);
  const pageOk = async route => {
    const want = route.split(' ')[0]; await waitFor(`!document.querySelector('#main .loading') && !!document.querySelector('#main .page') && document.querySelector('#main').dataset.route === ${JSON.stringify(want)}`, 10000, 'page ' + route);
    const bad = await evaluate(`[...document.querySelectorAll('#main .note.danger')].map(n => n.innerText).filter(t => /Could not load this page/.test(t)).join(' | ')`);
    if (bad) throw new Error(route + ': ' + bad);
  };
  const visit = async (route, { drawer = true } = {}) => {
    await evaluate(`location.hash = '#/${route}'`); await sleep(150); await pageOk(route);
    const tabs = await evaluate(`[...document.querySelectorAll('#main [role=tab]')].map(t => t.dataset.group + '|' + t.dataset.tab)`);
    for (const t of tabs) { const [g, k] = t.split('|'); await click(`#main [role=tab][data-group="${g}"][data-tab="${k}"]`); await sleep(150); await pageOk(`${route} tab ${k}`); }
    if (drawer && await evaluate(`!!document.querySelector('#main tr.click')`)) {
      await click('#main tr.click'); await waitFor(`!!document.querySelector('#drawerHost .drawer') && !document.querySelector('#drBody .loading')`, 8000, route + ' drawer');
      const dErr = await evaluate(`[...document.querySelectorAll('#drBody .note.danger')].map(n => n.innerText).join('')`);
      if (dErr) throw new Error(route + ' drawer: ' + dErr);
      await click('#drawerHost .x');
    }
  };
  const noErrors = label => { if (errors.length) { const e = errors.splice(0); throw new Error(label + ' JS errors:\n' + e.join('\n')); } };
  const code = () => U.totp(mfaSecret);
  let mfaSecret = '';

  await step('Sign-in screen is the single-business admin login (no merchant signup)', async () => {
    await goto(BASE + '/app'); await waitFor(`!!document.querySelector('form[data-form=login]')`);
    const t = await text(); assert.match(t, /Administrator sign in/); assert.match(t, /Card Payments & Crypto Settlement/i); assert.ok(!/Create an account|New merchant/.test(t));
    assert.equal(await evaluate('document.title'), 'DIGITAL HUB — Card Payments & Crypto Settlement'); noErrors('login screen');
  });
  await step('Mandatory 2FA: after password sign-in the console is locked until the authenticator is set up', async () => {
    await fill('form[data-form=login]', { email: 'admin@digitalhub.local', password: 'AdminPass12345' });
    await waitFor(`/Turn on two-factor authentication/.test(document.body.innerText)`, 10000, 'mfa gate');
    assert.equal(await evaluate(`!!document.querySelector('#main')`), false, 'no console behind the gate');
    await click('[data-act=setupMfa]'); await waitFor(`!!document.querySelector('form[data-form=mfaEnable]')`);
    mfaSecret = (await evaluate(`document.querySelector('.secret').innerText`)).replace(/\s/g, '');
    await fill('form[data-form=mfaEnable]', { code: code() });
    await waitFor(`!!document.querySelector('#main .page')`, 10000, 'console after enrolling'); await pageOk('overview');
    assert.match(await text(), /Finish setup/); noErrors('mfa');
  });
  await step('Sidebar has exactly the 15 console pages in order', async () => {
    const items = await evaluate(`[...document.querySelectorAll('#rail .nav a')].map(a => a.textContent.trim()).filter(t => t !== 'Your security')`);
    assert.deepEqual(items, ['Overview', 'Card Transactions', 'Authorize.Net', 'Customers', 'Payment Links', 'WooCommerce Integration', 'Settlements', 'Crypto Wallet', 'Infura & Blockchain', 'USDC Transfers', 'Refunds & Disputes', 'Webhook Logs', 'Reports & Analytics', 'Security & Audit Logs', 'Settings']);
    const bg = await evaluate(`getComputedStyle(document.body).backgroundColor`); assert.equal(bg, 'rgb(7, 8, 11)', 'black / charcoal theme');
  });
  await step('Authorize.Net: keys saved through the form (2FA code), test connection and webhook registration', async () => {
    await evaluate(`location.hash = '#/authorize-net'`); await pageOk('authorize-net');
    await click('[data-act=anetCreds][data-env=sandbox]'); await waitFor(`!!document.querySelector('form[data-form=anetCreds]')`);
    await fill('form[data-form=anetCreds]', { login_id: LOGIN, transaction_key: TKEY, signature_key: SIGKEY, code: code() });
    await waitFor(`/configured/.test(document.querySelector('#main').innerText) && !document.querySelector('#dlg').open`, 8000, 'saved');
    const page = await text(); assert.ok(!page.includes(TKEY) && !page.includes(SIGKEY), 'keys never shown');
    await click('[data-act=anetTest][data-env=sandbox]'); await waitFor(`/accepted/.test(document.querySelector('#main').innerText)`, 8000, 'test ok');
    await click('[data-act=anetHook][data-env=sandbox]'); await waitFor(`/registered/.test(document.querySelector('#main').innerText)`, 8000, 'webhook');
    await shot('console-anet'); noErrors('anet');
  });
  let linkUrl;
  await step('Payment link created in the console', async () => {
    await evaluate(`location.hash = '#/links'`); await pageOk('links');
    await click('[data-act=newLink]'); await waitFor(`!!document.querySelector('form[data-form=newLink]')`);
    await fill('form[data-form=newLink]', { amount: '42.50', description: 'Design consultation' });
    await waitFor(`/Payment link ready/.test(document.querySelector('#dlg').innerText)`); linkUrl = BASE + new URL(await evaluate(`document.querySelector('#dlg .secret').innerText`)).pathname;
    await click('#dlg [data-act=closeModal]'); noErrors('links');
  });
  await step('Checkout: customer details → token POSTed to the (fake) Authorize.Net hosted page; return verified server-side', async () => {
    await goto(linkUrl); await waitFor(`!!document.querySelector('#hostedPay')`, 10000, 'hosted checkout');
    const t = await text(); assert.match(t, /\$42\.50/); assert.match(t, /Authorize\.Net/); assert.equal(await evaluate(`!!document.querySelector('#k-num, input[autocomplete=cc-number]')`), false, 'no card number field on Digital Hub');
    await evaluate(`document.querySelector('#h-name').value = 'Ui Buyer'; document.querySelector('#h-email').value = 'ui@example.com'; true`);
    await click('#hostedPay');
    await waitFor(`location.href.startsWith(${JSON.stringify(anetUrl)}) && /token ok/.test(document.body.innerText)`, 10000, 'hosted page with valid token');
    const sid = new URL(linkUrl).pathname; // /l/... → session id from the payment
    const p = store.list('payments', {}).find(x => x.provider === 'authorize_net'); anetFake.pay(anetFake.st.lastPostedToken);
    await goto(`${BASE}/pay/${p.session_id}?return=1`);
    await waitFor(`/Payment received/.test(document.body.innerText)`, 15000, 'paid after server verification');
    const done = await text(); assert.match(done, /Visa •••• 1111/); assert.match(done, /Invoice/); await shot('checkout-paid'); noErrors('checkout');
  });
  await step('Crypto wallet: MetaMask signature verifies the business wallet (no keys requested)', async () => {
    await goto(BASE + '/app#/wallet'); await pageOk('wallet');
    assert.match(await text(), /never asks for or stores private keys/);
    await click('[data-act=walletAdd]'); await waitFor(`!!document.querySelector('#w-addr')`);
    await click('[data-act=walletFromMM]'); await waitFor(`document.querySelector('#w-addr').value.length === 42`, 20000, 'address from MetaMask');
    await evaluate(`document.querySelector('form[data-form=walletAdd]').requestSubmit()`);
    await waitFor(`!!document.querySelector('[data-act=walletVerify]')`, 8000, 'verify button');
    await click('[data-act=walletVerify]'); await waitFor(`/Wallet ownership verified/.test(document.body.innerText)`, 25000, 'verified');
    assert.ok(mm.calls.includes('personal_sign')); assert.ok(!mm.calls.includes('eth_sendTransaction'), 'never sends a transaction'); noErrors('wallet');
  });
  await step('Every console page, tab and drawer renders without errors', async () => {
    for (const r of ['overview', 'transactions', 'authorize-net', 'customers', 'links', 'woocommerce', 'settlements', 'wallet', 'infura', 'transfers', 'refunds', 'webhooks', 'reports', 'security', 'settings', 'account']) await visit(r);
    await evaluate(`location.hash = '#/transactions'`); await pageOk('transactions'); assert.match(await text(), /captured/); await shot('console-transactions');
    noErrors('pages');
  });
  await step('Production readiness: live switches disabled until checks pass', async () => {
    await evaluate(`location.hash = '#/settings'`); await pageOk('settings');
    await click('#main [role=tab][data-tab=readiness]'); await pageOk('settings');
    assert.match(await text(), /Not ready for live payments/); assert.equal(await evaluate(`document.querySelector('[data-act=liveSwitch][data-key=cards_live]').disabled`), true);
    noErrors('readiness');
  });
  await step('Phone width: no horizontal scroll on the console', async () => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    for (const r of ['overview', 'transactions', 'settlements']) { await evaluate(`location.hash = '#/${r}'`); await pageOk(r); const over = await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'); assert.ok(over <= 1, `${r} overflows by ${over}px`); }
    await b.send('Emulation.clearDeviceMetricsOverride'); noErrors('mobile');
  });

  console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}.`);
  b.close(); anetFake.server.close(); sepolia.server.close(); server.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
