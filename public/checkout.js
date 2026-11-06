'use strict';
/* Hosted checkout for Cash App Pay. Talks only to /c-api with the unguessable session ID; it never
   sees API keys. The order is confirmed only from the server's Cash App status, never from the browser. */
const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = m => '$' + (Math.abs(m) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sid = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const st = { s: null, step: 'start', error: '', poll: null, busy: false, email: '', name: '' };

function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4000); }
async function call(method, path, body) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 25000);
  let r;
  try { r = await fetch('/c-api/sessions/' + encodeURIComponent(sid) + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'The request timed out. Please try again.' : 'Could not connect. Check your connection and try again.'); }
  finally { clearTimeout(timer); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Checkout request failed (${r.status}).`);
  return d;
}
function qr(el, text) { if (!el) return; el.innerHTML = ''; if (window.QRCode && text) { try { new QRCode(el, { text, width: 180, height: 180, colorDark: '#0C172A', colorLight: '#FFFFFF' }); return; } catch {} } el.innerHTML = '<span style="color:#0C172A;font-size:12px">QR unavailable</span>'; }

async function load() {
  if (!/^cs_[a-z0-9]{10,}$/.test(sid)) return fatal('This checkout link is invalid', 'Return to the store and start the payment again.');
  try { st.s = await call('GET', ''); } catch (e) { return fatal('Checkout unavailable', esc(e.message), true); }
  const s = st.s;
  $('#banner').innerHTML = s.mode === 'test' ? `<div class="test-banner">Test mode · ${esc(s.environment)} · no real money moves</div>` : '';
  $('#modeNote').textContent = s.mode === 'test' ? 'sandbox' : 'live';
  if (s.customer_email && !st.email) st.email = s.customer_email;
  route(s.payment);
}
function fatal(title, text, retry) { $('#co').innerHTML = `<div class="co-body">${result('!', 'danger', title, text, retry ? '<button class="btn" type="button" id="reload">Try again</button>' : '')}</div>`; const b = $('#reload'); if (b) b.onclick = () => location.reload(); }
function route(p) {
  if (st.s.status === 'expired') st.step = 'expired';
  else if (p && ['captured', 'settled', 'authorized', 'partially_refunded', 'refunded'].includes(p.status) || st.s.status === 'complete') st.step = 'done';
  else if (p && ['awaiting_customer', 'processing'].includes(p.status)) st.step = 'pay';
  else if (p && ['declined', 'expired', 'canceled'].includes(p.status)) { st.step = 'failed'; }
  else st.step = 'start';
  draw();
}
const head = () => { const s = st.s; return `<div class="co-top"><div><div class="eyebrow" style="color:var(--muted)">${esc(s.merchant.name)}</div><div class="co-amt">${fmt(s.amount)}</div><div class="muted">${esc(s.description)}</div></div>${s.mode === 'test' ? '<span class="tag">TEST</span>' : ''}</div>`; };
const result = (icon, tone, title, text, extra = '') => `<div class="result"><div class="icon" style="background:var(--${tone}-soft);color:var(--${tone === 'neutral' ? 'muted' : tone})">${icon}</div><h2>${esc(title)}</h2><p class="muted">${text}</p>${extra}</div>`;
const err = () => st.error ? `<div class="note danger"><span>${esc(st.error)}</span></div>` : '';

function draw() {
  const s = st.s, p = s.payment; let body = '';
  if (st.step === 'expired') body = result('×', 'neutral', 'This checkout has expired', 'Return to the store and start again.');
  else if (st.step === 'done') body = success(p);
  else if (st.step === 'pay' && p) body = payPanel(p);
  else if (st.step === 'failed' && p) body = failed(p);
  else if (!s.available) body = `<div class="note warn"><span>Cash App Pay is not available for ${esc(s.merchant.name)} right now. Please contact the store.</span></div>`;
  else body = start();
  $('#co').innerHTML = head() + `<div class="co-body">${body}</div>` + (s.cancel_url && st.step !== 'done' ? `<div class="co-body" style="border-top:1px solid var(--line);padding-block:10px"><a href="${esc(s.cancel_url)}" class="faint" style="font-size:.8rem">← Cancel and return to ${esc(s.merchant.name)}</a></div>` : '');
  mount();
}
function start() {
  return `<div class="cap-brand"><span class="cap-logo">$</span><div>Cash App Pay<div class="faint" style="font-weight:500;font-size:.8rem">Pay from your Cash App balance or linked card</div></div></div>
    <div class="form-grid"><label class="field"><span>Name (optional)</span><input id="c-name" autocomplete="name" value="${esc(st.name)}"></label><label class="field"><span>Email for receipt (optional)</span><input id="c-email" type="email" autocomplete="email" value="${esc(st.email)}"></label></div>
    ${err()}<button class="btn cap-btn" id="payCash" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Starting…' : `Pay ${fmt(st.s.amount)} with Cash App Pay`}</button>
    <p class="faint" style="font-size:.75rem;text-align:center">You approve the payment in Cash App. ${esc(st.s.merchant.name)} never sees your Cash App login.</p>`;
}
function payPanel(p) {
  const c = p.cash_app || {}, url = isMobile ? c.mobile_url : (c.desktop_url || c.mobile_url);
  if (p.status === 'processing') return `${result('…', 'info', 'Confirming your payment', 'You approved the payment. We are confirming it with Cash App — this takes a few seconds.')}<div class="waiting"><span class="dot"></span>Waiting for Cash App</div>`;
  return `<div class="cap-brand"><span class="cap-logo">$</span><div>${isMobile ? 'Continue in Cash App' : 'Scan with your phone'}<div class="faint" style="font-weight:500;font-size:.8rem">${isMobile ? 'Approve the payment, then come back here.' : 'Open your camera or Cash App and scan this code.'}</div></div></div>
    ${isMobile ? '' : `<div class="cap-qr" id="qr">${c.qr_code_image_url ? `<img src="${esc(c.qr_code_image_url)}" alt="Cash App Pay QR code">` : ''}</div>`}
    ${url ? `<a class="btn cap-btn" href="${esc(url)}" ${isMobile ? '' : 'target="_blank" rel="noopener"'}>${isMobile ? `Open Cash App to pay ${fmt(p.amount)}` : 'Or open Cash App Pay in a new tab'}</a>` : ''}
    <div class="waiting"><span class="dot"></span>Waiting for you to approve in Cash App…</div>${err()}
    ${st.s.simulator ? `<div class="sim"><h4>Local simulator · stands in for the customer's Cash App</h4><div class="row"><button class="btn sm" data-sim="approve">Approve payment</button><button class="btn sm" data-sim="decline">Decline</button></div><span class="faint" style="font-size:.75rem">Sandbox amounts: $77.71 declines (insufficient funds), $66.70 simulates a Cash App timeout that recovers.</span></div>` : ''}
    <button class="btn ghost" id="cancelPay" style="width:100%">Cancel and choose again</button>`;
}
function failed(p) {
  const msg = p.status === 'expired' ? 'The payment request expired before it was approved.' : p.status === 'canceled' ? 'The payment was canceled.' : (p.decline || 'Cash App declined the payment.');
  return result('!', 'danger', p.status === 'expired' ? 'Payment request expired' : p.status === 'canceled' ? 'Payment canceled' : 'Payment declined', esc(msg) + ' No money was taken.', '<button class="btn primary" id="retry">Try again</button>');
}
function success(p) {
  const s = st.s, url = s.success_url ? s.success_url + (s.success_url.includes('?') ? '&' : '?') + 'session_id=' + encodeURIComponent(s.id) : null;
  if (url) setTimeout(() => { location.href = url; }, 5000);
  const date = p?.created ? new Date(p.created * 1000).toLocaleString() : new Date().toLocaleString();
  const authorized = p?.status === 'authorized';
  return `<div class="thank-you"><div class="thank-you-mark" aria-hidden="true"><span>✓</span></div><h2>${authorized ? 'Payment authorized' : 'Thank you for your payment'}</h2>
    <p class="muted">${authorized ? `${esc(s.merchant.name)} will capture it when your order ships.` : 'Cash App confirmed your payment.'}${s.customer_email || st.email ? ' A receipt is on its way.' : ''}</p>
    <div class="thank-you-details"><div><span>Amount</span><b>${fmt(p?.amount ?? s.amount)}</b></div><div><span>Paid with</span><b>Cash App Pay</b></div>
      <div><span>Status</span><b class="paid-status">${esc((p?.status || 'paid').replace(/_/g, ' '))}</b></div><div><span>Date</span><b>${esc(date)}</b></div>
      ${p?.id ? `<div class="thank-you-reference"><span>Reference</span><b class="mono">${esc(p.id)}</b></div>` : ''}</div>
    ${url ? `<a class="btn primary" href="${esc(url)}">Return to ${esc(s.merchant.name)}</a><span class="faint">Returning to the store…</span>` : ''}</div>`;
}

function mount() {
  const p = st.s.payment;
  const pay = $('#payCash'); if (pay) pay.onclick = () => act(async () => {
    st.name = $('#c-name').value.trim(); st.email = $('#c-email').value.trim(); st.busy = true; draw();
    try { st.s.payment = await call('POST', '/cashapp', { name: st.name, email: st.email }); } finally { st.busy = false; }
    route(st.s.payment);
  });
  if (st.step === 'pay' && p) {
    const c = p.cash_app || {}; if (!isMobile && !c.qr_code_image_url) qr($('#qr'), c.desktop_url || c.mobile_url);
    startPoll();
  } else stopPoll();
  document.querySelectorAll('[data-sim]').forEach(b => b.onclick = () => act(async () => {
    const id = new URL(p.cash_app.mobile_url).pathname.split('/').pop();
    const r = await fetch('/c-api/cashapp-sim/' + encodeURIComponent(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: b.dataset.sim }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || 'Simulator error');
    await refresh();
  }));
  const cancel = $('#cancelPay'); if (cancel) cancel.onclick = () => act(async () => { st.s.payment = await call('POST', `/payments/${p.id}/cancel`); await call('POST', `/payments/${p.id}/retry`); st.s.payment = null; route(null); });
  const retry = $('#retry'); if (retry) retry.onclick = () => act(async () => { await call('POST', `/payments/${p.id}/retry`); st.s.payment = null; st.error = ''; route(null); });
}
async function act(fn) { st.error = ''; try { await fn(); } catch (e) { st.error = e.message; draw(); } }
async function refresh() {
  const p = st.s.payment; if (!p) return;
  const fresh = await call('GET', `/payments/${p.id}`);
  const changed = fresh.status !== p.status || fresh.cash_app?.qr_code_image_url !== p.cash_app?.qr_code_image_url;
  st.s.payment = fresh;
  if (changed) route(fresh);
}
function startPoll() {
  if (st.poll) return;
  st.poll = setInterval(() => { if (document.hidden) return; refresh().catch(e => { st.error = e.message; }); }, 2500);
}
function stopPoll() { clearInterval(st.poll); st.poll = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && st.step === 'pay') refresh().catch(() => {}); });
load();
