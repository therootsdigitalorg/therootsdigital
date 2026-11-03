'use strict';
/* Hosted checkout. Talks only to /c-api with the unguessable session ID; never sees API keys. */
const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SYM = { USD: '$', EUR: '€', GBP: '£', AED: 'AED ', PKR: 'Rs ' };
const fmt = (m, c) => { const s = (Math.abs(m) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return ['USDT', 'USDC'].includes(c) ? `${s} ${c}` : `${SYM[c] ?? ''}${s}`; };
const COUNTRIES = { US: 'United States', GB: 'United Kingdom', DE: 'Germany', FR: 'France', AE: 'United Arab Emirates', PK: 'Pakistan', CA: 'Canada', AU: 'Australia', IN: 'India', SA: 'Saudi Arabia', NG: 'Nigeria', SG: 'Singapore' };
const sid = location.pathname.split('/').pop();
const st = { s: null, method: 'card', asset: null, network: null, step: 'form', error: '', customer: { name: '', email: '', country: 'US' }, card: { number: '', exp: '', cvc: '' }, poll: null };

function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4000); }
async function call(method, path, body) {
  const r = await fetch('/c-api/sessions/' + sid + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error?.message || 'Something went wrong'); return d;
}
function qr(el, text) { if (!el) return; el.innerHTML = ''; if (window.QRCode) { try { new QRCode(el, { text, width: 156, height: 156, colorDark: '#0C172A', colorLight: '#FFFFFF' }); return; } catch {} } el.innerHTML = '<span style="color:#0C172A;font-size:12px">QR unavailable</span>'; }

async function load() {
  try { st.s = await call('GET', ''); } catch (e) { $('#co').innerHTML = `<div class="co-body"><div class="result"><div class="icon" style="background:var(--danger-soft);color:var(--danger)">!</div><h2>Checkout not found</h2><p class="muted">${esc(e.message)}</p></div></div>`; return; }
  const s = st.s;
  $('#banner').innerHTML = s.mode === 'test' ? '<div class="test-banner">Test mode — no real money moves</div>' : '';
  $('#modeNote').textContent = s.mode === 'test' ? 'sandbox' : 'live';
  if (s.customer_email && !st.customer.email) st.customer.email = s.customer_email;
  if (!s.methods.includes(st.method)) st.method = s.methods[0];
  const p = s.payment;
  if (p && ['awaiting_payment', 'confirming', 'underpaid'].includes(p.status)) st.step = 'crypto';
  else if (p && p.status === 'requires_action') st.step = '3ds';
  else if (s.status === 'complete' || (p && ['captured', 'settled', 'authorized', 'confirmed', 'overpaid'].includes(p.status))) st.step = 'done';
  draw();
}
function top() { const s = st.s; return `<div class="co-top"><div><div class="eyebrow" style="color:var(--muted)">${esc(s.merchant.name)}</div><div class="co-amt">${fmt(s.amount, s.currency)}</div><div class="muted">${esc(s.description)}</div></div>${s.mode === 'test' ? '<span class="tag">TEST</span>' : ''}</div>`; }
function draw() {
  const s = st.s, p = s.payment; let body = '';
  if (s.status === 'expired') body = result('×', 'neutral', 'This checkout has expired', 'Return to the store and start again.');
  else if (st.step === 'done') body = success(p);
  else if (st.step === '3ds') body = threeDS(p);
  else if (st.step === 'crypto' && p) body = cryptoPay(p);
  else if (!s.methods.length) body = `<div class="note warn"><span>No payment method is available right now. Please contact ${esc(s.merchant.name)}.</span></div>`;
  else body = form();
  $('#co').innerHTML = top() + `<div class="co-body">${body}</div>` + (s.cancel_url && st.step !== 'done' ? `<div class="co-body" style="border-top:1px solid var(--line);padding-block:10px"><a href="${esc(s.cancel_url)}" class="faint" style="font-size:.8rem">← Cancel and return to ${esc(s.merchant.name)}</a></div>` : '');
  mount();
}
const result = (icon, tone, title, text, extra = '') => `<div class="result"><div class="icon" style="background:var(--${tone}-soft);color:var(--${tone === 'neutral' ? 'muted' : tone})">${icon}</div><h2>${esc(title)}</h2><p class="muted">${text}</p>${extra}</div>`;
function form() {
  const s = st.s, c = st.customer;
  let h = s.methods.length > 1 ? `<div class="methods" role="group" aria-label="Payment method">${s.methods.map(m => `<button type="button" data-m="${m}" aria-pressed="${st.method === m}">${m === 'card' ? 'Card' : 'USDT / USDC'}<small>${m === 'card' ? 'Visa · Mastercard' : esc(s.crypto.provider)}</small></button>`).join('')}</div>` : '';
  h += `<div class="form-grid"><label class="field"><span>Full name</span><input id="c-name" autocomplete="name" value="${esc(c.name)}"></label><label class="field"><span>Email for receipt</span><input id="c-email" type="email" autocomplete="email" value="${esc(c.email)}"></label>
    <label class="field full"><span>Country</span><select id="c-country">${Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}" ${c.country === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>`;
  if (st.method === 'card') {
    h += `<div class="hosted"><div class="hosted-label"><span>Card details</span><span>${s.mode === 'test' ? 'sandbox · test cards only' : 'secure'}</span></div>
      <label class="field"><span>Card number</span><input id="c-num" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234" value="${esc(st.card.number)}"></label>
      <div class="form-grid"><label class="field"><span>Expiry (MM/YY)</span><input id="c-exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/YY" value="${esc(st.card.exp)}"></label><label class="field"><span>CVC</span><input id="c-cvc" type="password" inputmode="numeric" autocomplete="cc-csc" maxlength="4" placeholder="123"></label></div></div>`;
    if (s.test_cards.length) h += `<details><summary class="faint" style="cursor:pointer">Test cards</summary><div class="tc testcards" style="margin-top:8px">${s.test_cards.map(t => `<button type="button" data-card="${t.number}"><span class="mono">${t.number.replace(/(.{4})/g, '$1 ').trim()}</span><span class="muted">${esc(t.label)}</span></button>`).join('')}</div><p class="faint" style="margin-top:6px">Any future expiry, any CVC. 3DS code: 123456.</p></details>`;
    h += err() + `<button class="btn primary" style="width:100%;padding:12px" id="payCard">Pay ${fmt(s.amount, s.currency)}</button>`;
  } else {
    const opts = s.crypto.options, assets = [...new Set(opts.map(o => o.asset))];
    if (!assets.includes(st.asset)) st.asset = assets[0];
    const nets = opts.filter(o => o.asset === st.asset); if (!nets.some(n => n.network === st.network)) st.network = nets[0]?.network;
    const n = nets.find(x => x.network === st.network);
    h += `<div class="methods" role="group" aria-label="Stablecoin">${assets.map(a => `<button type="button" data-a="${a}" aria-pressed="${st.asset === a}">${a}<small>${a === 'USDT' ? 'Tether USD' : 'USD Coin'}</small></button>`).join('')}</div>
      <label class="field"><span>Network</span><select id="c-net">${nets.map(x => `<option value="${x.network}" ${x.network === st.network ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select><small>Send only ${st.asset} on this network.</small></label>
      <div class="card" style="background:var(--bg)"><dl class="kv"><dt>You pay</dt><dd><b class="num">${fmt(s.crypto.quotes[st.asset], st.asset)}</b></dd><dt>Processed by</dt><dd>${esc(s.crypto.provider)}</dd><dt>Confirmations</dt><dd>${n?.confirmations ?? '—'}</dd><dt>Quote valid</dt><dd>15 minutes</dd></dl></div>`
      + err() + `<button class="btn primary" style="width:100%;padding:12px" id="payCrypto">Continue</button>`;
  }
  return h;
}
const err = () => st.error ? `<div class="note danger"><span>${esc(st.error)}</span></div>` : '';
function threeDS(p) {
  return `<div class="hosted" style="border-style:solid"><div class="hosted-label"><span>${p.card?.brand === 'Visa' ? 'Visa Secure' : 'Mastercard Identity Check'}</span><span>${st.s.mode === 'test' ? 'sandbox issuer' : 'issuer'}</span></div>
    <h3>Confirm this purchase</h3><p class="muted">Your bank sent a one-time code. ${st.s.mode === 'test' ? 'Sandbox code: 123456.' : ''}</p>
    <label class="field"><span>One-time code</span><input id="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>${err()}
    <div class="row"><button class="btn primary" id="otpGo">Verify</button><button class="btn ghost" id="otpCancel">Cancel</button></div></div>`;
}
function cryptoPay(p) {
  const c = p.crypto, remaining = c.amount_due - c.received, left = Math.max(0, c.expires_at - Date.now());
  if (c.checkout_url && st.s.mode === 'live') return `<div class="row" style="justify-content:space-between">${pill(p.status)}</div><p class="muted">Complete the payment with ${esc(c.provider === 'binance' ? 'Binance Pay' : 'Coinbase')}. This page updates automatically.</p>
    <div class="row" style="align-items:flex-start"><div class="qr" id="qr"></div><div class="stack" style="flex:1;min-width:180px"><b class="num" style="font-size:1.2rem">${fmt(c.amount_due, c.asset)}</b><a class="btn primary" href="${esc(c.checkout_url)}" target="_blank" rel="noopener">Open ${esc(c.provider === 'binance' ? 'Binance Pay' : 'Coinbase')}</a></div></div><span id="qrText" hidden>${esc(c.qr || c.checkout_url)}</span>`;
  const status = { awaiting_payment: 'Waiting for your transfer…', confirming: `Payment detected · ${c.confirmations}/${c.required} confirmations`, underpaid: `Received ${fmt(c.received, c.asset)} · ${fmt(remaining, c.asset)} still due` }[p.status] || p.status;
  return `<div class="row" style="justify-content:space-between">${pill(p.status)}${p.status === 'awaiting_payment' ? `<span class="num muted" id="cd">${mmss(left)}</span>` : ''}</div>
    <div class="row" style="align-items:flex-start"><div class="qr" id="qr"></div><div class="stack" style="flex:1;min-width:180px">
      <div><div class="faint" style="font-size:.75rem;font-weight:700">SEND EXACTLY</div><div class="row"><b class="num" style="font-size:1.25rem">${fmt(p.status === 'underpaid' ? remaining : c.amount_due, c.asset)}</b><button class="btn sm ghost" data-copy="${((p.status === 'underpaid' ? remaining : c.amount_due) / 100).toFixed(2)}">Copy</button></div></div>
      <div><div class="faint" style="font-size:.75rem;font-weight:700">${c.network === 'BINANCE_PAY' ? 'BINANCE PAY ID' : 'TO ADDRESS'} · ${esc(c.network_label)}</div><div class="addr">${esc(c.address)}</div><button class="btn sm ghost" data-copy="${esc(c.address)}">Copy</button></div></div></div>
    <div><div class="row" style="justify-content:space-between;margin-bottom:6px"><b>${esc(status)}</b><span class="faint num">${c.confirmations}/${c.required}</span></div><div class="progress"><div style="width:${Math.round(c.confirmations / c.required * 100)}%"></div></div></div>
    ${st.s.mode === 'test' ? `<div class="sim"><h4>Sandbox · wallet simulator</h4><div class="row">${p.status === 'awaiting_payment' ? '<button class="btn sm" data-sim="exact">Send exact</button><button class="btn sm" data-sim="under">Send 90%</button><button class="btn sm" data-sim="over">Send 105%</button>' + (c.network === 'BINANCE_PAY' ? '' : '<button class="btn sm" data-sim="wrong">Wrong network</button>') + '<button class="btn sm ghost" data-sim="expire">Let quote expire</button>' : p.status === 'underpaid' ? '<button class="btn sm" data-sim="topup">Send the rest</button>' : '<span class="faint">Confirming…</span>'}</div></div>` : ''}
    <span id="qrText" hidden>${esc(c.network === 'BINANCE_PAY' ? c.address : `${c.asset.toLowerCase()}:${c.address}?amount=${(c.amount_due / 100).toFixed(2)}`)}</span>`;
}
const pill = s => `<span class="badge ${['confirmed', 'captured', 'settled'].includes(s) ? 'b-ok' : ['underpaid', 'overpaid'].includes(s) ? 'b-warn' : ['declined', 'expired', 'wrong_network'].includes(s) ? 'b-danger' : 'b-info'}">${esc(s.replace(/_/g, ' '))}</span>`;
const mmss = ms => `Quote expires in ${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}`;
function success(p) {
  const s = st.s, url = s.success_url ? s.success_url + (s.success_url.includes('?') ? '&' : '?') + 'session_id=' + encodeURIComponent(s.id) : null;
  if (url) setTimeout(() => { location.href = url; }, 4000);
  const extra = p?.status === 'overpaid' ? `You sent ${fmt(p.crypto.excess, p.crypto.asset)} more than required; ${esc(s.merchant.name)} will return it.` : p?.status === 'authorized' ? 'Your card is authorized; the merchant captures it when your order ships.' : `A receipt goes to your email.`;
  return result('✓', 'ok', 'Payment successful', extra, `${p ? `<dl class="kv" style="text-align:left;width:100%"><dt>Reference</dt><dd class="mono">${esc(p.id)}</dd><dt>Paid with</dt><dd>${p.card ? `${esc(p.card.brand)} ••${esc(p.card.last4)}` : `${p.crypto.asset} · ${esc(p.crypto.network_label)}`}</dd></dl>` : ''}${url ? `<a class="btn primary" href="${esc(url)}">Return to ${esc(s.merchant.name)}</a><span class="faint">Redirecting…</span>` : ''}`);
}
function failure(p) {
  const msg = p.status === 'declined' ? (p.decline || 'Your bank declined the payment.') : p.status === 'expired' ? 'The quote expired before funds arrived.' : 'We saw a transfer on a different network. Support will contact you to recover it.';
  st.step = 'form'; st.error = msg;
}

function mount() {
  const p = st.s.payment;
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { capture(); st.method = b.dataset.m; st.error = ''; draw(); });
  document.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { capture(); st.asset = b.dataset.a; draw(); });
  document.querySelectorAll('[data-card]').forEach(b => b.onclick = () => { capture(); st.card = { number: b.dataset.card.replace(/(.{4})/g, '$1 ').trim(), exp: '12/34', cvc: '' }; draw(); $('#c-cvc').value = '123'; });
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Copied')));
  document.querySelectorAll('[data-sim]').forEach(b => b.onclick = () => act(async () => { st.s.payment = await call('POST', `/payments/${p.id}/simulate`, { kind: b.dataset.sim }); afterCrypto(); }));
  const net = $('#c-net'); if (net) net.onchange = () => { capture(); st.network = net.value; draw(); };
  const num = $('#c-num'); if (num) num.oninput = () => { num.value = num.value.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim(); };
  const exp = $('#c-exp'); if (exp) exp.oninput = () => { const d = exp.value.replace(/\D/g, '').slice(0, 4); exp.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; };
  const pc = $('#payCard'); if (pc) pc.onclick = () => act(async () => { capture(); pc.disabled = true; pc.textContent = 'Processing…'; const r = await call('POST', '/card', { ...st.customer, number: st.card.number, exp: st.card.exp, cvc: $('#c-cvc').value }); st.s.payment = r; st.card.number = ''; afterCard(r); });
  const pcr = $('#payCrypto'); if (pcr) pcr.onclick = () => act(async () => { capture(); pcr.disabled = true; const r = await call('POST', '/crypto', { ...st.customer, asset: st.asset, network: st.network }); st.s.payment = r; st.step = 'crypto'; draw(); });
  const og = $('#otpGo'); if (og) og.onclick = () => act(async () => { const r = await call('POST', `/payments/${p.id}/3ds`, { code: $('#otp').value }); st.s.payment = r; afterCard(r); });
  const oc = $('#otpCancel'); if (oc) oc.onclick = () => act(async () => { const r = await call('POST', `/payments/${p.id}/3ds`, { code: 'cancel' }); st.s.payment = r; afterCard(r); });
  if (st.step === 'crypto' && p) { qr($('#qr'), $('#qrText')?.textContent || ''); startPoll(); }
}
function capture() {
  if ($('#c-name')) st.customer = { name: $('#c-name').value.trim(), email: $('#c-email').value.trim(), country: $('#c-country').value };
  if ($('#c-num')) st.card = { number: $('#c-num').value, exp: $('#c-exp').value, cvc: '' };
}
async function act(fn) { st.error = ''; try { await fn(); } catch (e) { st.error = e.message; if (st.step === '3ds' || st.step === 'crypto') toast(e.message, 'err'); draw(); } }
async function afterCard(p) {
  if (p.status === 'requires_action') st.step = '3ds';
  else if (['captured', 'authorized', 'settled'].includes(p.status)) { st.step = 'done'; }
  else { failure(p); await call('POST', `/payments/${p.id}/retry`).catch(() => {}); }
  draw();
}
async function afterCrypto() {
  const p = st.s.payment;
  if (['confirmed', 'overpaid'].includes(p.status)) { st.step = 'done'; stopPoll(); }
  else if (['expired', 'wrong_network', 'declined'].includes(p.status)) { stopPoll(); failure(p); await call('POST', `/payments/${p.id}/retry`).catch(() => {}); }
  draw();
}
function startPoll() {
  if (st.poll) return;
  st.poll = setInterval(async () => {
    const p = st.s.payment; if (!p || st.step !== 'crypto') return stopPoll();
    const cd = $('#cd'); if (cd) cd.textContent = mmss(Math.max(0, p.crypto.expires_at - Date.now()));
    st.tick = (st.tick || 0) + 1;
    if (st.tick % 3 === 0) { try { const fresh = await call('GET', `/payments/${p.id}`); if (fresh.status !== p.status || fresh.crypto.confirmations !== p.crypto.confirmations || fresh.crypto.received !== p.crypto.received) { st.s.payment = fresh; afterCrypto(); } } catch {} }
  }, 1000);
}
function stopPoll() { clearInterval(st.poll); st.poll = null; }
load();
