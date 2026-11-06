'use strict';
/* Stands in for the customer's Cash App when no sandbox credentials are configured (test mode only). */
const box = document.getElementById('box');
const rid = decodeURIComponent(location.pathname.split('/').pop());
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function load() {
  const r = await fetch('/c-api/cashapp-sim/' + encodeURIComponent(rid)); const d = await r.json().catch(() => ({}));
  if (!r.ok) { box.innerHTML = `<h2>Request not found</h2><p class="muted">${esc(d.error?.message || '')}</p>`; return; }
  if (d.status !== 'PENDING') { box.innerHTML = `<div class="logo">$</div><h2>Request ${esc(d.status.toLowerCase())}</h2>${d.redirect_url ? `<a class="btn" href="${esc(d.redirect_url)}">Back to checkout</a>` : ''}`; return; }
  box.innerHTML = `<div class="logo">$</div><div class="muted">Pay</div><h2>${esc(d.merchant)}</h2><div class="co-amt">$${(d.amount / 100).toFixed(2)}</div>
    <p class="faint">From your Cash App balance (simulated)</p><button class="btn ok" id="a">Approve</button><button class="btn ghost" id="d">Decline</button>`;
  const decide = async decision => {
    const x = await fetch('/c-api/cashapp-sim/' + encodeURIComponent(rid), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
    const j = await x.json().catch(() => ({}));
    if (j.redirect_url) location.href = j.redirect_url; else load();
  };
  document.getElementById('a').onclick = () => decide('approve');
  document.getElementById('d').onclick = () => decide('decline');
}
load();
