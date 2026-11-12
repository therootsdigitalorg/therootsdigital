'use strict';
/* Hosted checkout — MetaMask USDC on Base. Talks only to /c-api with the unguessable session ID; never sees API keys.
   Flow: connect MetaMask → switch to the right Base network → sign a free wallet confirmation → send a plain USDC
   transfer to the merchant's verified wallet → the server verifies the receipt on-chain and counts confirmations.
   The page shows "paid" only when the server says the invoice is paid.
   Single-business platform: cards go through Authorize.Net Accept Hosted — this page collects name / email / billing,
   gets a one-time token from the server and form-POSTs it to Authorize.Net, where the customer types the card. On the way
   back (?return=1) the server looks the transaction up with Authorize.Net; the redirect itself never marks anything paid. */
const QS = new URLSearchParams(location.search);
const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (m, c) => { const s = (Math.abs(m) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return c === 'USDC' ? `${s} USDC` : c === 'USD' ? `$${s}` : `${s} ${c}`; };
const short = (s, a = 6, b = 4) => s && s.length > a + b + 3 ? `${s.slice(0, a)}…${s.slice(-b)}` : (s || '');
const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const MM = window.DHMetaMask;
const sid = location.pathname.split('/').pop();
const st = { s: null, step: 'loading', error: '', busy: '', email: '', name: '', wallet: null, chainOk: false, balances: null, detected: null, poll: null, manual: false, method: null, card: { number: '', exp: '', save: false } };
const SYM = { USD: '$', EUR: '€', GBP: '£', AED: 'AED ', PKR: 'Rs ' };
const fmtCur = (m, c) => SYM[c] ? `${SYM[c]}${(Math.abs(m) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : fmt(m, c);

function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 5000); }
async function call(method, path, body) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
  let r;
  try { r = await fetch('/c-api/sessions/' + encodeURIComponent(sid) + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'Checkout request timed out. Please try again.' : 'Could not connect to checkout. Check your connection and try again.'); }
  finally { clearTimeout(timer); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error?.message || `Checkout request failed (${r.status}).`); e.code = d.error?.code; e.status = r.status; throw e; }
  return d;
}

async function load() {
  try { st.s = await call('GET', ''); }
  catch (e) { $('#co').innerHTML = `<div class="co-body"><div class="result"><div class="icon" style="background:var(--danger-soft);color:var(--danger)">!</div><h2>Checkout unavailable</h2><p class="muted">${esc(e.message)}</p><button class="btn" type="button" id="reloadCo">Try again</button></div></div>`; $('#reloadCo').onclick = () => location.reload(); return; } // no inline handlers: the CSP blocks them
  const s = st.s;
  if (s.customer_email && !st.email) st.email = s.customer_email;
  const hosted = !!s.card?.hosted;
  $('#banner').innerHTML = s.mode === 'test' ? `<div class="test-banner">${hosted ? 'Test mode · Authorize.Net sandbox · no real money' : 'Test mode · Base Sepolia testnet · test USDC has no value'}</div>` : '';
  $('#modeNote').textContent = hosted ? (s.mode === 'test' ? 'sandbox' : '') : s.mode === 'test' ? 'Base Sepolia testnet' : 'Base mainnet';
  if (hosted) { $('#coFoot').innerHTML = 'Secured by Digital Hub · Card details are entered on Authorize.Net’s secure payment page and never reach this site.'; if (QS.get('canceled') === '1') st.error = 'Payment was cancelled. You can try again.'; route(); draw(); return; }
  st.detected = await MM.detect();
  if (st.detected) { const w = await MM.reconnect().catch(() => null); if (w) st.wallet = w; }
  route(); draw();
  if (st.wallet) await checkWallet();
}
function route() {
  const s = st.s, p = s.payment;
  if (s.card?.hosted) { // Authorize.Net Accept Hosted
    st.method = 'card'; stopPoll();
    if (s.status === 'complete' || (p && ['captured', 'authorized', 'partially_refunded', 'refunded'].includes(p.status))) st.step = 'done';
    else if (s.status === 'expired') st.step = 'expired';
    else if (p && p.status === 'pending') st.step = 'review';
    else if (p && p.status === 'created' && QS.get('return') === '1' && (st.verifyTries || 0) < 8) { st.step = 'verifying'; startVerify(); }
    else { st.step = 'connect'; if (p && p.status === 'declined' && QS.get('return') === '1' && !st.declineShown) { st.declineShown = true; st.error = 'Your bank declined the payment. You can try again with another card.'; } }
    return;
  }
  if (!st.method || !s.methods.includes(st.method)) st.method = p?.method === 'usdc' ? 'usdc' : s.methods.includes('card') ? 'card' : s.methods[0]; // card first
  if (s.status === 'complete' || (p && ['confirmed', 'overpaid', 'partially_refunded', 'refunded', 'captured', 'authorized', 'settled'].includes(p.status))) st.step = 'done';
  else if (p && p.method === 'card' && p.status === 'requires_action') { st.step = '3ds'; st.method = 'card'; }
  else if (s.status === 'expired') st.step = 'expired';
  else if (p && p.method === 'usdc' && ['awaiting_payment', 'confirming', 'underpaid'].includes(p.status)) st.step = p.status === 'confirming' ? 'confirming' : 'pay';
  else if (p && p.status === 'expired') st.step = 'quote_expired';
  else st.step = 'connect';
  if (['pay', 'confirming'].includes(st.step)) startPoll(); else stopPoll();
}
const chain = () => st.s.usdc?.chain || null;

function header() {
  const s = st.s, c = chain();
  return `<div class="co-top"><div><div class="eyebrow" style="color:var(--muted)">${esc(s.merchant.name)}</div><div class="co-amt">${st.method === 'card' || !s.methods.includes('usdc') ? fmtCur(s.amount, s.currency) : fmt(s.amount, 'USDC')}</div><div class="muted">${esc(s.description)}</div></div>
    <div class="stack" style="align-items:flex-end;gap:6px">${c && st.method !== 'card' ? `<span class="net-chip"><i></i>${esc(c.chainName)}</span>` : ''}${s.subscription ? `<span class="tag">every ${s.subscription.interval_count > 1 ? s.subscription.interval_count + ' ' : ''}${esc(s.subscription.interval)}${s.subscription.interval_count > 1 ? 's' : ''}</span>` : ''}${s.mode === 'test' ? '<span class="tag">TEST</span>' : ''}</div></div>`;
}
function draw() {
  const s = st.s; let body = '';
  if (!s.methods.length) body = `<div class="note warn"><span>No payment method is available for this checkout right now. Please contact ${esc(s.merchant.name)}${s.merchant.support_email ? ` (${esc(s.merchant.support_email)})` : ''}.</span></div>`;
  else if (st.step === '3ds') body = threeDSView();
  else if (st.step === 'connect' && s.card?.hosted) body = hostedView();
  else if (st.step === 'verifying') body = result('…', 'info', 'Confirming your payment', 'Checking the result with the card processor. This takes a few seconds — please keep this page open.');
  else if (st.step === 'review') body = result('!', 'warn', 'Payment under review', `Your payment is being reviewed by the card processor. ${esc(s.merchant.name)} will confirm your order once it is approved. Do not pay again.`);
  else if (st.step === 'connect' && st.method === 'card') body = methodTabs() + cardView();
  else if (st.step === 'done') body = success();
  else if (st.step === 'expired') body = result('×', 'neutral', 'This checkout has expired', 'Return to the store and start again.');
  else if (st.step === 'quote_expired') body = result('⏱', 'warn', 'Payment window closed', 'No transfer arrived in time. Nothing was charged.', `<button class="btn primary" data-act="restart">Start again</button>`);
  else if (st.step === 'connect') body = methodTabs() + connectView();
  else if (st.step === 'pay') body = payView();
  else if (st.step === 'confirming') body = confirmingView();
  const cancel = s.cancel_url && !['done', 'confirming'].includes(st.step) ? `<div class="co-body" style="border-top:1px solid var(--line);padding-block:10px"><a href="${esc(s.cancel_url)}" class="faint" style="font-size:.8rem">← Cancel and return to ${esc(s.merchant.name)}</a></div>` : '';
  $('#co').innerHTML = header() + `<div class="co-body">${body}</div>` + cancel;
  mount();
}
const result = (icon, tone, title, text, extra = '') => `<div class="result"><div class="icon" style="background:var(--${tone}-soft);color:var(--${tone === 'neutral' ? 'muted' : tone})">${icon}</div><h2>${esc(title)}</h2><p class="muted">${text}</p>${extra}</div>`;
const err = () => st.error ? `<div class="note danger" role="alert"><span>${esc(st.error)}</span></div>` : '';
const busyBtn = (id, label, cls = 'primary') => `<button class="btn ${cls} mm-btn" id="${id}" ${st.busy ? 'disabled' : ''}>${st.busy && st.busy === id ? esc(st.busyText || 'Working…') : label}</button>`;
function steps(active) {
  const list = [['Connect MetaMask', 'Choose the account you will pay from.'], [`Switch to ${chain()?.chainName}`, 'MetaMask may ask to switch or add the network.'], ['Confirm your wallet', 'A free signature — no funds move, nothing is approved.'], ['Send USDC', 'One plain token transfer straight to the merchant.']];
  return `<ol class="steps-v">${list.map(([t, d], i) => `<li><span class="dot ${i < active ? 'done' : i === active ? 'on' : ''}">${i < active ? '✓' : i + 1}</span><div><b>${esc(t)}</b><div>${esc(d)}</div></div></li>`).join('')}</ol>`;
}
function methodTabs() {
  const s = st.s; if (s.methods.length < 2) return ''; // shown even when MetaMask is already connected, so returning users can still choose card
  return `<div class="methods" role="group" aria-label="Payment method">${s.methods.map(m => `<button type="button" data-method="${m}" aria-pressed="${st.method === m}">${m === 'card' ? 'Card' : 'USDC'}<small>${m === 'card' ? 'Visa · Mastercard' + (s.card?.sandbox ? ' · test' : '') : 'MetaMask · ' + esc(chain()?.chainName || 'Base')}</small></button>`).join('')}</div>`;
}
function cardView() {
  const s = st.s, cd = st.card;
  let h = `<div class="form-grid"><label class="field"><span>Name on card</span><input id="k-name" autocomplete="cc-name" value="${esc(st.name)}"></label><label class="field"><span>Email for receipt</span><input id="c-email" type="email" autocomplete="email" value="${esc(st.email)}"></label></div>
    <div class="hosted"><div class="hosted-label"><span>Card details</span><span>${s.card?.sandbox ? 'sandbox · test cards only' : 'secure'}</span></div>
      <label class="field"><span>Card number</span><input id="k-num" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234" value="${esc(cd.number)}"></label>
      <div class="form-grid"><label class="field"><span>Expiry (MM/YY)</span><input id="k-exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/YY" value="${esc(cd.exp)}"></label><label class="field"><span>CVC</span><input id="k-cvc" type="password" inputmode="numeric" autocomplete="cc-csc" maxlength="4" placeholder="123"></label></div></div>`;
  if (s.subscription?.can_save_card) h += `<label class="check"><input type="checkbox" id="k-save" ${cd.save ? 'checked' : ''}> Save this card and charge it automatically for future renewals (cancel any time)</label>`;
  if (s.card?.test_cards?.length) h += `<details><summary class="faint" style="cursor:pointer">Test cards</summary><div class="stack testcards" style="margin-top:8px;gap:6px">${s.card.test_cards.map(t => `<button type="button" data-tcard="${t.number}"><span class="mono">${t.number.replace(/(.{4})/g, '$1 ').trim()}</span><span class="muted">${esc(t.label)}</span></button>`).join('')}</div><p class="faint" style="margin-top:6px">Any future expiry, any CVC. 3DS code: 123456. Real card numbers are refused in sandbox.</p></details>`;
  return h + err() + busyBtn('payCard', `Pay ${fmtCur(s.amount, s.currency)}`);
}
function hostedView() {
  const s = st.s, b = st.bill || {};
  const f = (id, label, v, extra = '') => `<label class="field"><span>${label}</span><input id="${id}" value="${esc(v || '')}" ${extra}></label>`;
  return `${err()}<div class="form-grid">${f('h-name', 'Cardholder name', st.name, 'autocomplete="cc-name" required')}${f('h-email', 'Email for receipt', st.email, 'type="email" autocomplete="email" required')}</div>
    <details ${b.address ? 'open' : ''}><summary class="faint" style="cursor:pointer">Billing address (helps your bank approve the payment)</summary><div class="stack" style="margin-top:8px">${f('h-address', 'Street address', b.address, 'autocomplete="address-line1"')}
      <div class="form-grid">${f('h-city', 'City', b.city, 'autocomplete="address-level2"')}${f('h-state', 'State / region', b.state, 'autocomplete="address-level1"')}${f('h-zip', 'ZIP / postal code', b.zip, 'autocomplete="postal-code"')}${f('h-country', 'Country', b.country, 'autocomplete="country"')}</div></div></details>
    <div class="note info"><span>Next you enter your card on <b>Authorize.Net’s secure payment page</b>. Your card number and security code never reach this site.</span></div>
    ${busyBtn('hostedPay', 'Continue to secure card payment')}`;
}
let verifyTimer = null;
function startVerify() {
  if (verifyTimer) return;
  verifyTimer = setTimeout(async () => {
    verifyTimer = null; st.verifyTries = (st.verifyTries || 0) + 1;
    try { st.s = await call('GET', '?return=1'); } catch (e) { st.error = e.message; }
    route(); draw();
    if (st.step === 'connect' && st.s.payment?.status === 'created') st.error = 'We have not received a result from the card processor yet. If you completed the payment, wait a minute and refresh this page; otherwise try again.';
  }, st.verifyTries ? 2500 : 300);
}
function threeDSView() {
  return `<div class="note info"><span><b>Verify it's you.</b> Your bank asks for a one-time code (sandbox: 123456).</span></div>
    <label class="field"><span>Verification code</span><input id="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>${err()}${busyBtn('otpGo', 'Verify and pay')}<button class="btn sm ghost" id="otpCancel">Cancel</button>`;
}
function connectView() {
  const c = chain(), w = st.wallet;
  let h = `<label class="field"><span>Email for your receipt</span><input id="c-email" type="email" autocomplete="email" value="${esc(st.email)}" placeholder="you@example.com"></label>`;
  if (!w) {
    h += steps(0);
    if (st.detected) h += busyBtn('connect', '<span class="mm-mark"></span> Connect MetaMask');
    else h += `<div class="note info"><span>MetaMask was not found in this browser.</span></div>
      ${MM.isMobile() ? `<a class="btn primary mm-btn" href="${esc(MM.deepLink())}"><span class="mm-mark"></span> Open in MetaMask app</a>` : `<a class="btn primary mm-btn" href="https://metamask.io/download/" target="_blank" rel="noopener"><span class="mm-mark"></span> Install MetaMask</a>`}
      ${busyBtn('connectMobile', 'Connect with MetaMask Mobile (QR code)', '')}<p class="faint" style="font-size:.75rem">Uses the official MetaMask Connect: scan the QR code with the MetaMask app.</p>`;
  } else {
    h += `<div class="acct"><div><div class="faint" style="font-size:.72rem;font-weight:700">PAYING FROM</div><span class="mono">${esc(short(w.account, 8, 6))}</span></div><button class="btn sm ghost" data-act="disconnect">Change</button></div>`;
    if (!st.chainOk) h += steps(1) + busyBtn('switch', `Switch MetaMask to ${esc(c.chainName)}`);
    else {
      h += balanceNotes() + steps(2) + busyBtn('confirm', 'Confirm wallet in MetaMask');
    }
  }
  return h + err() + `<p class="faint" style="font-size:.75rem">USDC contract <span class="mono">${esc(short(c.usdc, 8, 6))}</span> on ${esc(c.chainName)} · ${st.s.usdc.confirmations} confirmations required.</p>`;
}
function balanceNotes() {
  const b = st.balances, c = chain(); if (!b) return '';
  const need = BigInt(st.s.payment?.crypto?.remaining_units || st.s.usdc.amount_units);
  let h = '';
  if (b.usdc < need) h += `<div class="note warn"><span>This account holds ${esc(MM.formatUnits(b.usdc))} USDC on ${esc(c.chainName)}; ${esc(MM.formatUnits(need))} is needed.${c.testnet ? ` Get test USDC at <a href="https://faucet.circle.com" target="_blank" rel="noopener">faucet.circle.com</a> (choose Base Sepolia).` : ''}</span></div>`;
  if (b.eth === 0n) h += `<div class="note warn"><span>No ETH on ${esc(c.chainName)} for the network fee (gas).${c.testnet ? ' Use a Base Sepolia ETH faucet (for example the Coinbase Developer Platform faucet).' : ''}</span></div>`;
  return h;
}
function payView() {
  const p = st.s.payment, c = p.crypto, w = st.wallet, ch = chain();
  const remaining = BigInt(c.remaining_units || '0'), wrongAcct = w && !MM.same(w.account, c.payer);
  let h = `<div class="card" style="background:var(--bg)"><dl class="kv"><dt>Send</dt><dd><b class="num">${esc(MM.formatUnits(remaining))} USDC</b></dd><dt>To merchant wallet</dt><dd class="mono">${esc(short(c.recipient, 10, 8))}</dd><dt>Network</dt><dd>${esc(ch.chainName)} (${ch.chainId})</dd><dt>From</dt><dd class="mono">${esc(short(c.payer, 10, 8))}</dd><dt>Time left</dt><dd class="num" id="cd">${mmss(c.expires_at - Date.now())}</dd></dl></div>`;
  if (p.status === 'underpaid') h += `<div class="note warn"><span>Received ${esc(MM.formatUnits(c.received_units))} of ${esc(MM.formatUnits(c.amount_units))} USDC. Send the remaining ${esc(MM.formatUnits(remaining))} USDC to complete this payment.</span></div>`;
  const rejected = c.txs.filter(t => ['rejected', 'not_found'].includes(t.status)).slice(-1)[0];
  if (rejected) h += `<div class="note danger"><span>Transaction <a href="${esc(rejected.url)}" target="_blank" rel="noopener" class="mono">${esc(short(rejected.hash, 10, 6))}</a> was not accepted: ${esc(rejected.reason)}</span></div>`;
  if (!w) h += busyBtn('connect', '<span class="mm-mark"></span> Reconnect MetaMask to pay');
  else if (wrongAcct) h += `<div class="note warn"><span>MetaMask is on ${esc(short(w.account, 8, 6))}, but this payment was confirmed for ${esc(short(c.payer, 8, 6))}. Switch accounts in MetaMask, or start over with the new account.</span></div><button class="btn mm-btn" data-act="changeWallet">Use the new account instead</button>`;
  else if (!st.chainOk) h += busyBtn('switch', `Switch MetaMask to ${esc(ch.chainName)}`);
  else h += balanceNotes() + busyBtn('send', `<span class="mm-mark"></span> Pay ${esc(MM.formatUnits(remaining))} USDC with MetaMask`);
  h += err();
  h += st.manual ? `<div class="stack"><label class="field"><span>Transaction hash</span><input id="m-hash" class="mono" placeholder="0x…" autocomplete="off" spellcheck="false"></label><button class="btn" id="m-submit">Check transaction</button></div>`
    : `<button class="btn sm ghost" data-act="manual">Already sent it from MetaMask? Enter the transaction hash</button>`;
  if (!c.txs.some(t => ['pending', 'confirming', 'confirmed'].includes(t.status))) h += `<button class="btn sm ghost" data-act="changeWallet">Pay from a different wallet</button>`;
  return h;
}
function confirmingView() {
  const p = st.s.payment, c = p.crypto, live = c.txs.filter(t => ['pending', 'confirming'].includes(t.status));
  const conf = Math.min(c.required, live.length ? Math.min(...live.map(t => t.confirmations)) : c.confirmations), pct = Math.round(conf / c.required * 100);
  return `<div class="result" style="padding-bottom:0"><div class="icon" style="background:var(--info-soft);color:var(--info)">⛓</div><h2>Verifying on ${esc(chain().chainName)}</h2>
      <p class="muted">Your transfer was broadcast. Digital Hub is checking the receipt, the USDC contract, the recipient and the amount, and waiting for ${c.required} confirmations${c.finality !== 'confirmations' ? ` plus "${esc(c.finality)}" finality` : ''}. You can close this page — the merchant is notified automatically.</p></div>
    <div><div class="row" style="justify-content:space-between;margin-bottom:6px"><b>${live.some(t => t.status === 'pending') ? 'Waiting for the first block…' : 'Confirming'}</b><span class="faint num">${conf}/${c.required}</span></div><div class="progress"><div style="width:${pct}%"></div></div></div>
    ${c.txs.map(t => `<div class="txrow"><a class="mono" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(short(t.hash, 10, 8))}</a><span class="badge ${t.status === 'confirmed' ? 'b-ok' : ['rejected', 'not_found'].includes(t.status) ? 'b-danger' : 'b-info'}">${esc(t.status.replace(/_/g, ' '))}</span></div>`).join('')}
    ${err()}`;
}
function success() {
  const s = st.s, p = s.payment, c = p?.crypto, url = s.success_url ? s.success_url + (s.success_url.includes('?') ? '&' : '?') + 'session_id=' + encodeURIComponent(s.id) : null;
  if (url && !st.redirecting) { st.redirecting = true; setTimeout(() => { location.href = url; }, 6000); }
  const tx = c?.txs?.filter(t => t.status === 'confirmed') || [];
  const extra = p?.provider === 'authorize_net' && p.status === 'authorized' ? `Your ${esc(p.card?.brand || 'card')} was authorized. ${esc(s.merchant.name)} will capture it when your order is processed.` : p?.method === 'card' ? `Charged to your ${esc(p.card?.brand || 'card')}. ${esc(s.merchant.name)} has been notified.` : p?.status === 'overpaid' ? `You sent ${fmt(c.excess, 'USDC')} more than required; ${esc(s.merchant.name)} will refund the difference to your wallet.` : `Verified on ${esc(chain()?.chainName || 'Base')}. ${esc(s.merchant.name)} has been notified.`;
  return `<div class="thank-you"><div class="thank-you-mark" aria-hidden="true"><span>✓</span></div><h2>Payment received</h2><p class="muted">${extra}</p>
    <div class="thank-you-details"><div><span>Amount</span><b>${p?.method === 'card' ? fmtCur(p.amount, p.currency) : fmt(p?.amount ?? s.amount, 'USDC')}</b></div>
      ${p?.card && p.provider === 'authorize_net' ? `<div><span>Card</span><b>${esc(p.card.brand)} •••• ${esc(p.card.last4)}</b></div>${p.card.cardholder ? `<div><span>Cardholder</span><b>${esc(p.card.cardholder)}</b></div>` : ''}<div><span>Authorization</span><b class="mono">${esc(p.card.auth_code || '—')}</b></div><div><span>Invoice</span><b class="mono">${esc(p.invoice)}</b></div>` : ''}
      ${p?.card && p.provider !== 'authorize_net' ? `<div><span>Card</span><b>${esc(p.card.brand)} •••• ${esc(p.card.last4)}</b></div><div><span>Expires</span><b>${String(p.card.exp_month || '').padStart(2, '0')}/${String(p.card.exp_year || '').slice(-2)}</b></div>${p.card.cardholder ? `<div><span>Cardholder</span><b>${esc(p.card.cardholder)}</b></div>` : ''}<div><span>Authentication</span><b>${esc((p.card.three_ds || '—').replace(/_/g, ' '))}</b></div>` : ''}
      ${c ? `<div><span>From wallet</span><b class="mono">${esc(short(c.payer, 8, 6))}</b></div><div><span>Network</span><b>${esc(chain()?.chainName || c.network)}</b></div>` : ''}
      <div><span>Status</span><b class="paid-status">${esc((p?.status || 'paid').replace(/_/g, ' '))}</b></div>
      ${tx.map(t => `<div><span>Transaction</span><b><a class="mono" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(short(t.hash, 10, 8))}</a></b></div>`).join('')}
      ${p?.id ? `<div><span>Reference</span><b class="mono">${esc(p.id)}</b></div>` : ''}</div>
    ${url ? `<a class="btn primary" href="${esc(url)}">Return to ${esc(s.merchant.name)}</a><span class="faint">Returning to the store…</span>` : ''}</div>`;
}

/* ---------------- actions ---------------- */
async function act(id, text, fn) {
  if (st.busy) return; st.busy = id; st.busyText = text; st.error = ''; draw();
  try { await fn(); } catch (e) { st.error = e.code && typeof e.code === 'number' ? MM.message(e) : (e.message || MM.message(e)); }
  finally { st.busy = ''; draw(); }
}
async function checkWallet() {
  const w = st.wallet, c = chain(); if (!w || !c) return;
  st.chainOk = (await MM.chainId(w.provider).catch(() => '')) === c.chainIdHex.toLowerCase();
  if (st.chainOk) {
    try { const [usdc, eth] = await Promise.all([MM.tokenBalance(w.provider, c.usdc, w.account), MM.nativeBalance(w.provider, w.account)]); st.balances = { usdc, eth }; } catch { st.balances = null; }
  }
  draw();
}
function watchWallet() {
  MM.on('accountsChanged', a => { if (!a?.length) st.wallet = null; else if (st.wallet) st.wallet.account = a[0]; st.balances = null; checkWallet(); draw(); });
  MM.on('chainChanged', () => checkWallet());
}
async function doConnect(force) {
  st.email = $('#c-email')?.value?.trim() || st.email;
  st.wallet = await MM.connect(chain(), { forceConnect: force });
  watchWallet();
  await checkWallet();
}
async function doSwitch() { await MM.ensureChain(st.wallet.provider, chain()); await checkWallet(); }
async function doConfirm() {
  st.email = $('#c-email')?.value?.trim() || st.email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(st.email)) throw new Error('Enter a valid email address for your receipt.');
  await MM.ensureChain(st.wallet.provider, chain());
  const ch = await call('POST', '/usdc/challenge', { address: st.wallet.account });
  st.busyText = 'Sign in MetaMask…'; draw();
  const signature = await MM.sign(st.wallet.provider, st.wallet.account, ch.message);
  st.busyText = 'Creating payment…'; draw();
  st.s.payment = await call('POST', '/usdc/start', { address: st.wallet.account, signature, email: st.email, name: st.name });
  route();
}
async function doSend() {
  const p = st.s.payment, req = p.crypto.tx_request;
  if (!req) throw new Error('Nothing left to pay.');
  await MM.ensureChain(st.wallet.provider, chain());
  if (!MM.same(st.wallet.account, req.from)) throw new Error('Switch MetaMask to the account that confirmed this payment.');
  st.busyText = 'Confirm in MetaMask…'; draw();
  const hash = await MM.sendTransfer(st.wallet.provider, req);
  st.busyText = 'Verifying…'; draw();
  await submitHash(hash);
}
async function submitHash(hash) {
  try { st.s.payment = await call('POST', `/payments/${st.s.payment.id}/tx`, { hash }); }
  catch (e) {
    if (e.code === 'tx_already_used') { toast('Your transaction is already being verified.'); st.s.payment = await call('GET', `/payments/${st.s.payment.id}`); }
    else if (e.status >= 500 || e.code === 'rpc_unavailable') { toast('Transaction sent. Verification will continue automatically.', 'warn'); }
    else throw e;
  }
  route();
  const rej = st.s.payment.crypto.txs.find(t => t.hash === String(hash).toLowerCase() && t.status === 'rejected');
  if (rej) throw new Error('This transaction cannot pay the invoice: ' + rej.reason);
}

function mount() {
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#connect', () => act('connect', 'Open MetaMask…', () => doConnect(false)));
  on('#connectMobile', () => act('connectMobile', 'Loading MetaMask Connect…', () => doConnect(true)));
  on('#switch', () => act('switch', 'Approve in MetaMask…', doSwitch));
  on('#confirm', () => act('confirm', 'Preparing…', doConfirm));
  on('#send', () => act('send', 'Preparing…', doSend));
  on('#m-submit', () => act('m-submit', 'Checking…', async () => { const h = ($('#m-hash').value || '').trim(); if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error('A transaction hash is 0x followed by 64 hex characters.'); await submitHash(h); st.manual = false; }));
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => ({
    disconnect: () => { st.wallet = null; st.balances = null; st.chainOk = false; draw(); },
    manual: () => { st.manual = true; draw(); },
    changeWallet: () => act('change', 'Cancelling…', async () => { await call('POST', `/payments/${st.s.payment.id}/cancel`); st.s.payment = null; st.wallet = null; st.chainOk = false; route(); }),
    restart: () => act('restart', 'Starting over…', async () => { await call('POST', `/payments/${st.s.payment.id}/retry`); st.s.payment = null; route(); }),
  })[b.dataset.act]?.());
  const e = $('#c-email'); if (e) e.oninput = () => { st.email = e.value.trim(); };
  document.querySelectorAll('[data-method]').forEach(b => b.onclick = () => { captureCard(); st.method = b.dataset.method; st.error = ''; draw(); });
  document.querySelectorAll('[data-tcard]').forEach(b => b.onclick = () => { captureCard(); st.card.number = b.dataset.tcard.replace(/(.{4})/g, '$1 ').trim(); st.card.exp = '12/34'; draw(); const cvc = $('#k-cvc'); if (cvc) cvc.value = '123'; });
  const num = $('#k-num'); if (num) num.oninput = () => { num.value = num.value.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim(); };
  const ex = $('#k-exp'); if (ex) ex.oninput = () => { const d = ex.value.replace(/\D/g, '').slice(0, 4); ex.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; };
  // read the form BEFORE act() redraws it into the busy state (the CVC is never kept in page state)
  on('#payCard', () => { captureCard(); const cvc = $('#k-cvc')?.value || ''; act('payCard', 'Processing…', async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(st.email)) throw new Error('Enter a valid email address for your receipt.');
    const r = await call('POST', '/card', { name: st.name, email: st.email, number: st.card.number, exp: st.card.exp, cvc, save_card: st.card.save });
    st.s.payment = r; await afterCard(r);
  }); });
  on('#hostedPay', () => {
    const v = id => (document.getElementById(id)?.value || '').trim();
    st.name = v('h-name'); st.email = v('h-email'); st.bill = { address: v('h-address'), city: v('h-city'), state: v('h-state'), zip: v('h-zip'), country: v('h-country') };
    act('hostedPay', 'Opening secure payment page…', async () => {
      if (st.name.length < 2) throw new Error('Enter the cardholder name.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(st.email)) throw new Error('Enter a valid email address for your receipt.');
      const r = await call('POST', '/anet/start', { name: st.name, email: st.email, ...st.bill });
      const form = document.createElement('form'); form.method = 'POST'; form.action = r.form.action; form.style.display = 'none';
      const t = document.createElement('input'); t.type = 'hidden'; t.name = 'token'; t.value = r.form.token; form.appendChild(t);
      document.body.appendChild(form); st.busyText = 'Redirecting…'; form.submit();
      await new Promise(() => {}); // keep the button busy while the browser navigates
    });
  });
  on('#otpGo', () => { const code = $('#otp').value; act('otpGo', 'Verifying…', async () => { const r = await call('POST', `/payments/${st.s.payment.id}/3ds`, { code }); st.s.payment = r; await afterCard(r); }); });
  on('#otpCancel', () => act('otpCancel', 'Cancelling…', async () => { const r = await call('POST', `/payments/${st.s.payment.id}/3ds`, { code: 'cancel' }); st.s.payment = r; await afterCard(r); }));
}

function captureCard() {
  const v = id => document.getElementById(id);
  if (v('k-name')) st.name = v('k-name').value.trim(); if (v('c-email')) st.email = v('c-email').value.trim();
  if (v('k-num')) st.card.number = v('k-num').value; if (v('k-exp')) st.card.exp = v('k-exp').value; if (v('k-save')) st.card.save = v('k-save').checked;
}
async function afterCard(p) {
  st.card.number = ''; // never keep the number around in the page after submitting
  if (p.status === 'requires_action') { st.step = '3ds'; return; }
  if (['captured', 'authorized', 'settled'].includes(p.status)) { st.s = await call('GET', ''); route(); return; }
  const why = p.status === 'canceled' ? 'Payment canceled. You can try again.' : (p.decline || 'Your bank declined the payment.');
  await call('POST', `/payments/${p.id}/retry`).catch(() => {}); st.s.payment = null; st.step = 'connect';
  throw new Error(why);
}

/* ---------------- live status ---------------- */
function startPoll() {
  if (st.poll) return;
  st.poll = setInterval(async () => {
    const p = st.s.payment; if (!p) return stopPoll();
    const cd = $('#cd'); if (cd) cd.textContent = mmss(p.crypto.expires_at - Date.now());
    st.tick = (st.tick || 0) + 1;
    if (st.tick % 3 !== 0 || st.busy) return;
    try {
      const fresh = await call('GET', `/payments/${p.id}`), before = JSON.stringify(p);
      st.s.payment = fresh;
      if (['confirmed', 'overpaid'].includes(fresh.status)) st.s = await call('GET', '');
      if (JSON.stringify(fresh) !== before) { route(); draw(); }
    } catch (e) { if (e.status === 404) { stopPoll(); st.error = e.message; draw(); } }
  }, 1000);
}
function stopPoll() { clearInterval(st.poll); st.poll = null; }

load();
