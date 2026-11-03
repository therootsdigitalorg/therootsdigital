'use strict';
/* Merchant dashboard views. */
NAV.merchant = [
  ['Payments', [['home', 'Home'], ['payments', 'Transactions'], ['links', 'Payment links']]],
  ['Money', [['balances', 'Balances & payouts'], ['destinations', 'Payout destinations']]],
  ['Integrate', [['developers', 'Developers & API'], ['integrations', 'Plugins & integrations']]],
  ['Business', [['golive', 'Go live'], ['settings', 'Settings & team']]],
];
const M = () => App.me.merchant;
const liveBlocked = d => App.mode === 'live' && d ? note('warn', 'Live mode not active', esc(d) + ' You can keep working in test mode.') : '';
function statusBanner() {
  const m = M();
  if (m.status === 'suspended') return note('danger', 'Account suspended', 'New payments and payouts are blocked. Contact Digital Hub support.');
  if (m.status === 'rejected') return note('danger', 'Verification rejected', 'Update your business details under Go live and resubmit.');
  if (m.status === 'pending') return note('info', 'Test mode only', `Business verification is ${m.kyb.submitted ? 'under review' : 'not submitted yet'}. <a href="#/golive">Go live →</a>`);
  return '';
}
const payCols = [
  { h: 'Date', v: p => `<span class="num">${fmtDT(p.created)}</span>` },
  { h: 'Payment', v: p => `<span class="mono">${esc(short(p.id, 8, 4))}</span>` },
  { h: 'Customer', v: p => `${esc(p.customer?.name || '—')}<div class="faint" style="font-size:.75rem">${esc(p.customer?.email || '')}</div>` },
  { h: 'Method', v: p => p.card ? `${esc(p.card.brand)} ••${esc(p.card.last4)} <span class="tag">${p.card.three_d_secure === 'not_performed' ? 'non-3DS' : '3DS'}</span>` : p.crypto ? `${p.crypto.asset} · ${esc(p.crypto.network)}` : esc(p.method) },
  { h: 'Amount', r: 1, v: p => fmt(p.amount, p.currency) },
  { h: 'Net', r: 1, v: p => p.net != null ? fmt(p.net, p.crypto ? p.crypto.asset : p.currency) : '<span class="faint">—</span>' },
  { h: 'Status', v: p => badge(p.status) },
];
const payRow = p => `class="click" tabindex="0" data-act="openPayment" data-id="${p.id}"`;

/* ---------------- home ---------------- */
VIEWS.home = async () => {
  const d = await api('GET', '/m-api/overview'), m = M(), done = d.onboarding.filter(s => s.done).length;
  return head('Dashboard', m.name, `${App.mode === 'test' ? 'Test data' : 'Live data'} · last 30 days`, `<button class="btn" data-act="newLink">New payment link</button>${App.mode === 'test' ? '<button class="btn" data-act="samplePayments">Create test payments</button>' : ''}<a class="btn primary" href="#/balances">Payouts</a>`)
    + statusBanner() + liveBlocked(d.live_ready)
    + `<div class="grid g4">
      <div class="card kpi"><div class="label">Gross volume</div><div class="value">${fmt(d.gross_usd, 'USD')}</div><div class="sub">USD equivalent</div></div>
      <div class="card kpi"><div class="label">Successful payments</div><div class="value">${d.count}</div><div class="sub">${d.attempts ? Math.round(d.count / d.attempts * 100) : 0}% of ${d.attempts} attempts</div></div>
      <div class="card kpi"><div class="label">Fees</div><div class="value">${fmt(d.fees_usd, 'USD')}</div><div class="sub">provider + platform</div></div>
      <div class="card kpi"><div class="label">Available to pay out</div><div class="value">${fmt(d.available_usd, 'USD')}</div><div class="sub">all currencies, USD equivalent</div></div></div>
    <div class="split"><div class="card"><div class="card-head"><h2>Daily volume</h2><span class="faint">14 days</span></div>${barChart(d.series)}</div>
      <div class="card"><div class="card-head"><h2>Go-live progress</h2>${badge(done === d.onboarding.length ? 'done' : 'pending', `${done}/${d.onboarding.length}`)}</div><div class="progress" style="margin-bottom:10px"><div style="width:${Math.round(done / d.onboarding.length * 100)}%"></div></div>
        <div class="stack" style="gap:6px">${d.onboarding.filter(s => !s.done).slice(0, 4).map(s => `<div class="row" style="justify-content:space-between"><span>${esc(s.label)}</span>${badge('pending', 'to do')}</div>`).join('') || '<p class="muted">All steps complete.</p>'}</div><a href="#/golive" style="margin-top:10px;display:inline-block">Open go-live checklist →</a>
        ${d.attention.length ? `<div class="divider" style="margin:12px 0"></div><h3>Needs attention</h3><div class="stack" style="margin-top:8px">${d.attention.slice(0, 5).map(a => `<button class="btn ghost" style="justify-content:space-between" data-act="openPayment" data-id="${a.payment}"><span>${esc(a.status.replace(/_/g, ' '))}</span><span class="num">${fmt(a.amount, a.currency)}</span></button>`).join('')}</div>` : ''}</div></div>
    <h2>Balances</h2>${balanceCards(d.balances)}
    <div class="card"><div class="card-head"><h2>Recent payments</h2><a href="#/payments">All transactions →</a></div>${table(payCols, d.recent, { rowAttr: payRow, empty: App.mode === 'test' ? 'No test payments yet. Click “Create test payments” or open a payment link.' : 'No live payments yet.' })}</div>`;
};
ACT.samplePayments = () => run(() => api('POST', '/m-api/test/sample-payments'), { ok: 'Test payments created' });

/* ---------------- payments ---------------- */
VIEWS.payments = async () => {
  const f = App.filters.pay ||= { q: '', status: '', method: '', offset: 0 };
  const d = await api('GET', '/m-api/payments' + qs(f));
  return head('Payments', 'Transactions', 'Every card and stablecoin payment with fees, 3DS outcome, ledger entries and events.')
    + `<div class="card"><div class="grid g3">${fInput('pay', 'q', 'Search', 'ID, email, last 4, order ID')}${fSelect('pay', 'status', 'Status', [['', 'All statuses'], ...['captured', 'settled', 'authorized', 'confirmed', 'overpaid', 'underpaid', 'awaiting_payment', 'confirming', 'declined', 'expired', 'refunded', 'partially_refunded', 'reversed', 'disputed', 'canceled', 'wrong_network'].map(s => [s, s.replace(/_/g, ' ')])])}
      ${fSelect('pay', 'method', 'Method', [['', 'All methods'], ['card', 'Card'], ['crypto', 'USDT / USDC']])}</div></div>`
    + table(payCols, d.data, { rowAttr: payRow, empty: 'No payments match.' })
    + `<div class="pager"><span class="faint">${d.total} payments</span><div class="row">${f.offset > 0 ? '<button class="btn sm" data-act="page" data-bag="pay" data-dir="-1">Previous</button>' : ''}${f.offset + 50 < d.total ? '<button class="btn sm" data-act="page" data-bag="pay" data-dir="1">Next</button>' : ''}</div></div>`;
};
ACT.page = d => { const f = App.filters[d.bag]; f.offset = Math.max(0, (f.offset || 0) + 50 * d.dir); render(); };
function paymentBody(d, admin) {
  const p = d.payment, cur = p.crypto ? p.crypto.asset : p.currency;
  let b = `<div class="row" style="justify-content:space-between"><div><div class="co-amt" style="font-size:1.5rem">${fmt(p.amount, p.currency)}</div><div class="muted">${esc(p.description)}</div></div>${badge(p.status)}</div>`;
  b += kv([['Payment ID', `<span class="mono">${esc(p.id)}</span> <button class="btn sm ghost" data-act="copy" data-text="${esc(p.id)}">Copy</button>`], admin && ['Merchant', esc(d.merchant?.name)], ['Mode', badge(p.livemode ? 'live' : 'test')],
    ['Customer', `${esc(p.customer?.name)} · ${esc(p.customer?.email)} · ${esc(p.customer?.country)}`], ['Created', fmtDT(p.created)], ['Checkout session', `<span class="mono">${esc(short(p.checkout_session, 10, 6))}</span>`],
    Object.keys(p.metadata || {}).length && ['Metadata', `<span class="mono">${esc(JSON.stringify(p.metadata))}</span>`]]);
  b += `<h3>Amounts</h3>` + kv([['Gross', fmt(p.crypto ? (p.crypto.amount_due) : p.amount, cur)], p.fees && ['Provider fee', '−' + fmt(p.fees.provider, cur)], p.fees && ['Platform fee', '−' + fmt(p.fees.platform, cur)], p.net != null && ['Net', `<b>${fmt(p.net, cur)}</b>`], p.amount_refunded && ['Refunded', '−' + fmt(p.amount_refunded, cur)]]);
  if (d.three_ds) b += `<h3>Card & authentication</h3>` + kv([['Card', `${esc(p.card.brand)} ••••${esc(p.card.last4)} · issued ${esc(p.card.country)}`], ['3DS decision', esc(d.three_ds.reason)], ['3DS result', badge(d.three_ds.result === 'authenticated' ? 'approved' : d.three_ds.result || 'pending', d.three_ds.result)], ['Fraud liability', esc(d.three_ds.liability || '—')], d.risk && ['Risk score', `${d.risk.score} <span class="faint">(${esc(d.risk.why.join(', '))})</span>`], p.decline_code && ['Decline code', `<span class="mono">${esc(p.decline_code)}</span>`]]);
  if (d.crypto) b += `<h3>Stablecoin</h3>` + kv([['Provider', esc(d.crypto.provider)], ['Asset · network', `${d.crypto.asset} · ${esc(d.crypto.network)}`], ['Amount due', fmt(d.crypto.quoteAmount, d.crypto.asset)], ['Received', fmt(d.crypto.received, d.crypto.asset)], ['Confirmations', `${d.crypto.confirmations}/${d.crypto.required}`], d.crypto.address && ['Address', `<span class="mono">${esc(d.crypto.address)}</span>`], d.crypto.excess && ['Excess owed to customer', fmt(d.crypto.excess, d.crypto.asset)]]);
  if (d.dispute) b += `<h3>Dispute</h3>` + kv([['Reason', esc(d.dispute.reason)], ['Status', badge(d.dispute.status)], ['Amount', fmt(d.dispute.amount, d.dispute.currency) + ' + ' + fmt(d.dispute.fee, d.dispute.currency) + ' fee'], ['Respond by', fmtDate(d.dispute.due_at)], d.dispute.evidence && ['Evidence', esc(d.dispute.evidence)]]);
  if (d.refunds?.length) b += `<h3>Refunds</h3>` + table([{ h: 'Date', v: r => fmtDT(r.created ?? r.created_at) }, { h: 'Amount', r: 1, v: r => fmt(r.amount, r.currency) }, { h: 'Status', v: r => badge(r.status) }], d.refunds);
  b += `<h3>Timeline</h3><ul class="timeline">${[...d.events].reverse().map(e => `<li><div><b>${esc(e.status.replace(/_/g, ' '))}</b> <span class="t">${fmtDT(e.at)}</span><div class="muted" style="font-size:.84rem">${esc(e.note || '')}</div></div></li>`).join('')}</ul>`;
  b += `<h3>Ledger <span class="faint" style="font-weight:500">(debit +, credit −)</span></h3>` + table([{ h: 'Journal', v: e => `<span class="mono">${esc(e.journal_key.split(':').slice(1).join(':'))}</span>` }, { h: 'Account', v: e => esc(e.account) }, { h: 'Amount', r: 1, v: e => fmt(e.amount, e.currency) }], d.ledger, { empty: 'No money has moved.' });
  if (d.webhooks?.length) b += `<h3>Events</h3>` + table([{ h: 'Event', v: e => `<span class="mono">${esc(e.type)}</span>` }, { h: 'Time', v: e => fmtDT(e.created) }], d.webhooks);
  if (d.provider_events?.length) b += `<h3>Provider events</h3>` + table([{ h: 'Provider', v: e => esc(e.provider) }, { h: 'Event', v: e => esc(e.type) }, { h: 'Signature', v: e => esc(e.sig) }], d.provider_events);
  return b;
}
ACT.openPayment = d => openDrawer(async () => {
  const x = await api('GET', '/m-api/payments/' + d.id), p = x.payment, B = (act, l, c = '') => `<button class="btn ${c}" data-act="${act}" data-id="${p.id}">${l}</button>`;
  let foot = '';
  if (p.status === 'authorized') foot += B('cancelPayment', 'Cancel', 'danger') + B('capturePayment', 'Capture', 'primary');
  if (x.refundable > 0 && can('refunds')) foot += B('refundPayment', 'Refund');
  if (p.status === 'underpaid') foot += B('acceptPartial', 'Accept partial', 'primary');
  if (!p.livemode && p.card && ['settled', 'partially_refunded'].includes(p.status) && !x.dispute) foot += B('simDispute', 'Simulate chargeback', 'ghost');
  if (x.dispute?.status === 'needs_response') foot += `<button class="btn primary" data-act="disputeEvidence" data-id="${x.dispute.id}">Submit evidence</button>`;
  App.cache.payment = x;
  return { title: 'Payment', body: paymentBody(x, false), foot };
});
ACT.capturePayment = d => run(() => api('POST', `/m-api/payments/${d.id}/capture`), { ok: 'Payment captured' });
ACT.cancelPayment = d => confirmBox('Cancel authorization?', 'The hold on the customer\'s card is released.', 'Cancel authorization', () => api('POST', `/m-api/payments/${d.id}/cancel`));
ACT.acceptPartial = d => confirmBox('Accept partial payment?', 'Credit what was received (fees apply) and close the invoice.', 'Accept', () => api('POST', `/m-api/payments/${d.id}/accept-partial`), false);
ACT.simDispute = d => confirmBox('Simulate chargeback?', 'Sandbox only: debits the amount plus the dispute fee from your available balance.', 'Open chargeback', () => api('POST', `/m-api/payments/${d.id}/simulate-dispute`, { reason: 'fraudulent' }));
ACT.disputeEvidence = d => formModal('Submit dispute evidence', 'evidence', field('Evidence summary', '<textarea name="text" required minlength="20" placeholder="Tracking number, delivery proof, customer messages, 3DS result…"></textarea>'), 'Submit', { data: { id: d.id } });
FORM.evidence = async (f, form) => { await api('POST', `/m-api/disputes/${form.dataset.id}/evidence`, f); closeModal(); toast('Evidence submitted'); refreshDrawer(); };
ACT.refundPayment = d => {
  const x = App.cache.payment, p = x.payment, cur = p.crypto ? p.crypto.asset : p.currency;
  formModal('Refund payment', 'refund', field(`Amount (${cur})`, input('amount', { type: 'number', value: (x.refundable / 100).toFixed(2), req: true, extra: `step="0.01" min="0.01" max="${(x.refundable / 100).toFixed(2)}"` }), `Up to ${fmt(x.refundable, cur)}. Processing fees are not returned.`)
    + (p.crypto ? field('Refund network', select('network', [[p.crypto.network, p.crypto.network]], p.crypto.network)) + field(p.crypto.network === 'BINANCE_PAY' ? 'Customer Binance Pay ID' : 'Customer wallet address', input('address', { req: true }), 'Only send to an address the customer confirms they control.') : '')
    + field('Reason', select('reason', ['requested_by_customer', 'duplicate', 'fraudulent', 'item_returned'])), 'Refund', { data: { id: p.id, idem: 'idem_' + uid() } });
};
FORM.refund = async (f, form) => { const r = await api('POST', `/m-api/payments/${form.dataset.id}/refund`, { ...f, amount: toMinor(f.amount), idempotency_key: form.dataset.idem }); closeModal(); toast(r.replayed ? 'Already refunded (duplicate submit ignored)' : 'Refund created'); await render(); refreshDrawer(); };

/* ---------------- payment links ---------------- */
VIEWS.links = async () => {
  const links = await api('GET', '/m-api/links');
  return head('Payments', 'Payment links', 'No-code checkout: share a link by chat, email, social media or a QR code. Customers pay by card or USDT/USDC.', `<button class="btn primary" data-act="newLink">New payment link</button>`)
    + statusBanner()
    + table([{ h: 'Created', v: l => fmtDate(l.created) }, { h: 'Description', v: l => esc(l.description) + (l.reusable ? ' <span class="tag">reusable</span>' : '') }, { h: 'Amount', r: 1, v: l => fmt(l.amount, l.currency) },
      { h: 'Methods', v: l => l.payment_methods.map(x => `<span class="tag">${x === 'card' ? 'Card' : 'Crypto'}</span>`).join(' ') }, { h: 'Paid', r: 1, v: l => l.paid }, { h: 'Status', v: l => badge(l.status) },
      { h: '', v: l => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-act="shareLink" data-url="${esc(l.url)}" data-desc="${esc(l.description)}">Share</button><a class="btn sm" href="${esc(l.url)}" target="_blank" rel="noopener">Open</a><button class="btn sm ghost" data-act="linkStatus" data-id="${l.id}" data-active="${l.status === 'active' ? '' : '1'}">${l.status === 'active' ? 'Deactivate' : 'Activate'}</button></div>` }], links, { empty: 'No payment links yet.' });
};
ACT.newLink = () => formModal('New payment link', 'link', `<div class="form-grid">${field('Amount', input('amount', { type: 'number', req: true, ph: '0.00', extra: 'step="0.01" min="0.50"' }))}${field('Currency', select('currency', FIAT, 'USD'))}</div>
  ${field('Description', input('description', { req: true, extra: 'maxlength="200"', ph: 'What the customer pays for' }))}
  <div class="field"><span>Payment methods</span><div class="row"><label class="check"><input type="checkbox" name="methods" value="card" data-multi checked> Card</label><label class="check"><input type="checkbox" name="methods" value="crypto" data-multi checked> USDT / USDC</label></div></div>
  <div class="form-grid">${field('Expires', select('expires_in_days', [['0', 'Never'], ['1', 'In 1 day'], ['7', 'In 7 days'], ['30', 'In 30 days']], '0'))}<label class="check" style="align-self:end"><input type="checkbox" name="reusable" checked> Reusable (many customers)</label></div>`, 'Create link');
FORM.link = async f => { const l = await api('POST', '/m-api/links', { amount: toMinor(f.amount), currency: f.currency, description: f.description, payment_methods: f.methods, expires_in_days: +f.expires_in_days, reusable: f.reusable }); closeModal(); await render(); ACT.shareLink({ url: l.url, desc: l.description }); };
ACT.shareLink = d => openModal({ title: 'Share payment link', body: `<div class="row" style="align-items:flex-start"><div class="qr" id="lq"></div><div class="stack" style="flex:1;min-width:200px"><b>${esc(d.desc)}</b><div class="addr">${esc(d.url)}</div><div class="row"><button class="btn sm primary" data-act="copy" data-text="${esc(d.url)}">Copy link</button><a class="btn sm" href="${esc(d.url)}" target="_blank" rel="noopener">Open checkout</a></div>
  <span class="faint">Embed on any website:</span><pre class="code">${esc(`<a href="${d.url}" class="dh-pay-button">Pay with Digital Hub</a>\n<script src="${location.origin}/js/digitalhub.js" async></script>`)}</pre></div></div>`, wide: true, onMount: () => qrInto($('#lq'), d.url) });
ACT.linkStatus = d => run(() => api('POST', `/m-api/links/${d.id}/status`, { active: !!d.active }), { ok: 'Link updated' });

/* ---------------- balances & payouts ---------------- */
VIEWS.balances = async () => {
  const d = await api('GET', '/m-api/balances');
  return head('Money', 'Balances & payouts', 'Card funds settle T+2 minus a rolling reserve. Confirmed stablecoin payments are available immediately. Every figure comes from the double-entry ledger.', can('payouts') ? `<button class="btn primary" data-act="newPayout">Request payout</button>` : '')
    + statusBanner() + (d.hold ? note('danger', 'Settlement hold', esc(d.hold.reason)) : '') + balanceCards(d.balances)
    + `<div class="card"><div class="card-head"><h2>Payouts</h2></div>${table([{ h: 'Requested', v: p => fmtDT(p.created) }, { h: 'Debit', r: 1, v: p => fmt(p.amount, p.currency) }, { h: 'Fee', r: 1, v: p => fmt(p.fee, p.destination_currency) }, { h: 'Receives', r: 1, v: p => `<b>${fmt(p.amount_received, p.destination_currency)}</b>` }, { h: 'Destination', v: p => esc(p.destination) }, { h: 'Reference', v: p => p.reference ? `<span class="mono">${esc(short(p.reference, 10, 6))}</span>` : '—' }, { h: 'Status', v: p => badge(p.status) + (p.reasons?.length && p.status === 'pending_approval' ? `<div class="faint" style="font-size:.72rem">${esc(p.reasons.join('; '))}</div>` : '') }], d.payouts, { empty: 'No payouts yet.' })}</div>`;
};
ACT.newPayout = () => run(async () => {
  const [b, dst] = await Promise.all([api('GET', '/m-api/balances'), api('GET', '/m-api/destinations')]);
  const curs = Object.entries(b.balances).filter(([, x]) => x.available > 0);
  if (!curs.length) throw new Error('No available balance to pay out yet.');
  const dests = [...dst.wallets.map(w => [w.id, `${w.asset} · ${w.network} · ${w.label}`, w.status]), ...dst.banks.map(x => [x.id, `${x.currency} · ${x.bank_name} ••${x.last4}`, x.status])];
  if (!dests.some(x => x[2] === 'verified')) throw new Error('Add a payout destination and wait for Digital Hub to verify it.');
  openModal({ title: 'Request payout', body: `<form class="stack" data-form="payout" id="mf" data-idem="idem_${uid()}"><div class="form-grid">${field('From balance', `<select name="currency" id="po-cur">${curs.map(([c, x]) => `<option value="${c}">${c} · ${fmt(x.available, c)}</option>`).join('')}</select>`)}
    ${field('Amount', input('amount', { type: 'number', req: true, extra: 'step="0.01" min="0.01" id="po-amt"' }))}</div>
    ${field('Destination', `<select name="destination" id="po-dst">${dests.map(([idv, l, st]) => `<option value="${idv}" ${st !== 'verified' ? 'disabled' : ''}>${esc(l)}${st !== 'verified' ? ' (' + st.replace(/_/g, ' ') + ')' : ''}</option>`).join('')}</select>`)}
    <div class="card" style="background:var(--bg)" id="po-q"><span class="faint">Enter an amount to see the quote.</span></div><div class="err" id="formErr"></div></form>`,
    foot: `<button class="btn ghost" data-act="closeModal">Cancel</button><button class="btn primary" type="submit" form="mf">Confirm payout</button>`,
    onMount: () => ['#po-cur', '#po-amt', '#po-dst'].forEach(s => $(s).addEventListener('input', quotePayout)) });
}, { noRefresh: true });
let quoteTimer;
function quotePayout() {
  clearTimeout(quoteTimer); quoteTimer = setTimeout(async () => {
    const box = $('#po-q'), amount = toMinor($('#po-amt').value); if (!box) return;
    if (!(amount > 0)) { box.innerHTML = '<span class="faint">Enter an amount to see the quote.</span>'; return; }
    try { const q = await api('POST', '/m-api/payouts/quote', { currency: $('#po-cur').value, amount, destination: $('#po-dst').value });
      box.innerHTML = kv([['You send', fmt(q.amount, q.sourceCur)], q.sourceCur !== q.destCur && ['Rate', `1 ${q.sourceCur} = ${q.rate.toFixed(4)} ${q.destCur} (incl. ${q.spreadBps / 100}% spread)`], ['Fee', '−' + fmt(q.fee, q.destCur)], ['Destination receives', `<b>${fmt(q.receive, q.destCur)}</b>`], ['Approval', q.reasons.length ? 'Digital Hub review: ' + esc(q.reasons.join('; ')) : 'Automatic'], q.amount > q.available && ['Available', `<span class="err">Only ${fmt(q.available, q.sourceCur)}</span>`]]);
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }, 250);
}
FORM.payout = async (f, form) => { const r = await api('POST', '/m-api/payouts', { currency: f.currency, amount: toMinor(f.amount), destination: f.destination, idempotency_key: form.dataset.idem }); closeModal(); toast(r.replayed ? 'Duplicate submit ignored' : r.status === 'completed' ? 'Payout sent' : 'Payout submitted for approval'); render(); };

/* ---------------- payout destinations ---------------- */
VIEWS.destinations = async () => {
  const d = await api('GET', '/m-api/destinations');
  const add = can('payouts');
  return head('Money', 'Payout destinations', 'Stablecoin wallets and bank accounts. Each one is reviewed by Digital Hub (ownership, sanctions screening) before any payout.')
    + `<div class="card"><div class="card-head"><h2>Stablecoin wallets</h2>${add ? '<button class="btn" data-act="addWallet">Add wallet</button>' : ''}</div>${table([{ h: 'Label', v: w => esc(w.label) }, { h: 'Asset · network', v: w => `${w.asset} · ${esc(d.networks[w.network]?.label || w.network)}` }, { h: 'Address / Pay ID', v: w => `<span class="mono">${esc(short(w.address, 10, 6))}</span>` }, { h: 'Status', v: w => badge(w.status) }, { h: '', v: w => add ? `<button class="btn sm ghost" data-act="removeDest" data-id="${w.id}">Remove</button>` : '' }], d.wallets, { empty: 'No wallets yet.' })}</div>
    <div class="card"><div class="card-head"><h2>Bank accounts</h2>${add ? '<button class="btn" data-act="addBank">Add bank account</button>' : ''}</div>${table([{ h: 'Bank', v: b => esc(b.bank_name) }, { h: 'Currency', v: b => b.currency }, { h: 'Account', v: b => `••${esc(b.last4)}` }, { h: 'Rail', v: b => esc(b.rail || '—') }, { h: 'Status', v: b => badge(b.status) }, { h: '', v: b => add ? `<button class="btn sm ghost" data-act="removeDest" data-id="${b.id}">Remove</button>` : '' }], d.banks, { empty: 'No bank accounts yet.' })}</div>
    ${note('info', 'Corridors', 'Stablecoin balances pay out to stablecoin wallets; fiat balances pay out to bank accounts. PKR accounts are paid via Soneri Bank (Raast) once that connection is approved. Stablecoin → PKR is not offered.')}`;
};
ACT.addWallet = () => formModal('Add stablecoin wallet', 'wallet', `<div class="form-grid">${field('Asset', select('asset', ['USDT', 'USDC']))}${field('Network', select('network', [['BINANCE_PAY', 'Binance Pay ID'], ['TRON', 'TRON (TRC-20)'], ['ETH', 'Ethereum'], ['BSC', 'BNB Smart Chain'], ['POLYGON', 'Polygon'], ['SOLANA', 'Solana'], ['BASE', 'Base']]))}</div>
  ${field('Address or Binance Pay ID', input('address', { req: true, extra: 'autocomplete="off" spellcheck="false"' }), 'Must be a wallet your business controls. Exchange deposit addresses are not accepted.')}${field('Label', input('label', { ph: 'Treasury wallet' }))}
  <label class="check"><input type="checkbox" name="attest" required> I confirm my business controls this wallet's private keys / account.</label>`, 'Submit for review');
FORM.wallet = async f => { await api('POST', '/m-api/wallets', f); closeModal(); toast('Wallet submitted for Digital Hub review'); render(); };
ACT.addBank = () => formModal('Add bank account', 'bank', `<div class="form-grid">${field('Currency', select('currency', FIAT))}${field('Bank name', input('bank_name', { req: true }))}</div>
  ${field('Account holder', input('holder', { req: true, value: M().legal_name }), 'Must match your legal business name.')}${field('IBAN or account number', input('account', { req: true, extra: 'autocomplete="off"' }), 'PKR: Pakistani IBAN (PK + 22 characters). Stored encrypted; only the last 4 are shown.')}
  ${field('Routing / SWIFT (optional)', input('routing'))}`, 'Submit for review');
FORM.bank = async f => { await api('POST', '/m-api/banks', f); closeModal(); toast('Bank account submitted for review'); render(); };
ACT.removeDest = d => confirmBox('Remove destination?', 'Payouts to it stop. Completed payouts are unaffected.', 'Remove', () => api('DELETE', '/m-api/destinations/' + d.id));

/* ---------------- developers ---------------- */
VIEWS.developers = async () => {
  const t = tab('dev', 'keys');
  let body = '';
  if (t === 'keys') {
    const d = await api('GET', '/m-api/keys'), pk = d.keys.find(k => k.type === 'publishable' && k.status === 'active');
    body = liveBlocked(d.live_ready) + (pk ? `<div class="card">${kv([['Publishable key', `<span class="mono">${esc(pk.plain)}</span> <button class="btn sm ghost" data-act="copy" data-text="${esc(pk.plain)}">Copy</button>`], ['Use', 'Browser-safe; can only read checkout session status.']])}</div>` : '')
      + `<div class="card"><div class="card-head"><h2>Secret keys · ${App.mode}</h2><button class="btn primary" data-act="newKey">Create secret key</button></div>
      ${table([{ h: 'Name', v: k => esc(k.name) }, { h: 'Key', v: k => `<span class="mono">${esc(k.prefix)}…${esc(k.last4)}</span>` }, { h: 'Permissions', v: k => k.scopes.map(s => `<span class="tag">${s === '*' ? 'full access' : esc(s)}</span>`).join(' ') }, { h: 'IP allowlist', v: k => k.allowed_ips.length ? esc(k.allowed_ips.join(', ')) : 'any' }, { h: 'Last used', v: k => fmtDT(k.last_used) }, { h: 'Status', v: k => badge(k.status) },
        { h: '', v: k => k.status === 'active' ? `<div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-act="rollKey" data-id="${k.id}">Roll</button><button class="btn sm danger" data-act="revokeKey" data-id="${k.id}">Revoke</button></div>` : '' }], d.keys.filter(k => k.type === 'secret'), { empty: 'No secret keys yet.' })}
      <p class="faint" style="margin-top:8px">Secret keys are shown once and stored only as SHA-256 hashes. Keep them on your server — never in browser code or mobile apps.</p></div>`;
  }
  if (t === 'webhooks') {
    const d = await api('GET', '/m-api/webhooks');
    body = `<div class="card"><div class="card-head"><h2>Webhook endpoints · ${App.mode}</h2><button class="btn primary" data-act="newEndpoint">Add endpoint</button></div>
      ${table([{ h: 'URL', v: e => `<span class="mono">${esc(e.url)}</span>` }, { h: 'Events', v: e => e.enabled_events.map(x => `<span class="tag">${esc(x === '*' ? 'all events' : x)}</span>`).join(' ') }, { h: 'Status', v: e => badge(e.status) },
        { h: '', v: e => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-act="testEndpoint" data-id="${e.id}">Send test</button><button class="btn sm" data-act="revealSecret" data-id="${e.id}">Signing secret</button><button class="btn sm ghost" data-act="toggleEndpoint" data-id="${e.id}" data-enabled="${e.status === 'enabled' ? '' : '1'}">${e.status === 'enabled' ? 'Disable' : 'Enable'}</button><button class="btn sm danger" data-act="deleteEndpoint" data-id="${e.id}">Delete</button></div>` }], d.endpoints, { empty: 'No endpoints yet. Add one so your store learns about payments instantly.' })}
      <p class="faint" style="margin-top:8px">Each event is POSTed with <span class="mono">DigitalHub-Signature: t=…,v1=HMAC-SHA256(secret, t + "." + body)</span>. Reject signatures older than 5 minutes and deduplicate by event ID. Failed deliveries retry with exponential backoff (6 attempts).</p></div>`;
    App.cache.eventTypes = d.event_types;
  }
  if (t === 'logs') {
    const ds = await api('GET', '/m-api/deliveries');
    body = table([{ h: 'Time', v: d => fmtDT(d.last_attempt || d.created_at) }, { h: 'Event', v: d => `<span class="mono">${esc(d.type)}</span>` }, { h: 'Endpoint', v: d => `<span class="mono">${esc(short(d.url.replace(/^https?:\/\//, ''), 22, 10))}</span>` }, { h: 'HTTP', r: 1, v: d => d.code ?? '—' }, { h: 'Attempts', r: 1, v: d => d.attempts }, { h: 'Status', v: d => badge(d.status) + (d.error ? `<div class="faint" style="font-size:.72rem">${esc(d.error)}</div>` : '') }, { h: '', v: d => d.status !== 'delivered' ? `<button class="btn sm" data-act="retryDelivery" data-id="${d.id}">Retry</button>` : '' }], ds, { empty: 'No deliveries yet.' });
  }
  if (t === 'events') {
    const evs = await api('GET', '/m-api/events'); App.cache.events = Object.fromEntries(evs.map(e => [e.id, e]));
    body = table([{ h: 'Time', v: e => fmtDT(e.created) }, { h: 'Type', v: e => `<span class="mono">${esc(e.type)}</span>` }, { h: 'Object', v: e => `<span class="mono">${esc(e.data.object.id || '')}</span>` }], evs, { empty: 'No events yet.', rowAttr: e => `class="click" data-act="showEvent" data-id="${e.id}"` });
  }
  if (t === 'api') body = apiReference();
  return head('Integrate', 'Developers & API', `REST API at <span class="mono">${esc(location.origin)}/v1</span>. Use test keys while building; switch to live keys after go-live.`)
    + tabs('dev', [['keys', 'API keys'], ['webhooks', 'Webhooks'], ['logs', 'Delivery logs'], ['events', 'Events'], ['api', 'API reference']], 'keys') + body;
};
const SCOPE_LABELS = { 'checkout:write': 'Create checkout sessions', 'payments:read': 'Read payments', 'payments:write': 'Capture / cancel', 'refunds:write': 'Refunds', 'balance:read': 'Balance & payouts', 'links:write': 'Payment links', 'payouts:write': 'Request payouts', 'webhooks:write': 'Manage webhooks', 'events:read': 'Read events' };
ACT.newKey = () => formModal(`Create ${App.mode} secret key`, 'key', `${field('Name', input('name', { req: true, ph: 'WooCommerce store' }))}
  <label class="check"><input type="checkbox" name="full" checked> Full access</label><div class="field"><span>Or restrict to</span><div class="form-grid">${Object.entries(SCOPE_LABELS).map(([s, l]) => `<label class="check"><input type="checkbox" name="scopes" value="${s}" data-multi> ${esc(l)}</label>`).join('')}</div></div>
  ${field('IP allowlist (optional)', input('allowed_ips', { ph: '203.0.113.10, 198.51.100.7' }), 'Only these server IPs may use the key.')}`, 'Create key');
FORM.key = async f => { const r = await api('POST', '/m-api/keys', { name: f.name, scopes: f.full ? ['*'] : f.scopes, allowed_ips: f.allowed_ips }); closeModal(); await render(); secretModal('Your new secret key', `Store <b>${esc(r.key.name)}</b> in your server's secret manager or plugin settings.`, r.secret); };
ACT.rollKey = d => confirmBox('Roll this key?', 'A new key is issued now; the old one keeps working for 24 hours so you can deploy the new one.', 'Roll key', async () => { const r = await api('POST', `/m-api/keys/${d.id}/roll`); setTimeout(() => secretModal('Rolled key', 'Replace the old key within 24 hours.', r.secret), 60); }, false);
ACT.revokeKey = d => confirmBox('Revoke key?', 'Requests using this key fail immediately. This cannot be undone.', 'Revoke', () => api('POST', `/m-api/keys/${d.id}/revoke`));
ACT.newEndpoint = () => formModal(`Add ${App.mode} webhook endpoint`, 'endpoint', `${field('Endpoint URL', input('url', { type: 'url', req: true, ph: 'https://yourshop.com/wc-api/digitalhub/' }), 'HTTPS required in production.')}
  <label class="check"><input type="checkbox" name="all" checked> All events</label><div class="form-grid">${(App.cache.eventTypes || []).map(e => `<label class="check"><input type="checkbox" name="events" value="${e}" data-multi> <span class="mono" style="font-size:.78rem">${e}</span></label>`).join('')}</div>`, 'Add endpoint', { wide: true });
FORM.endpoint = async f => { const r = await api('POST', '/m-api/webhooks', { url: f.url, events: f.all ? ['*'] : f.events }); closeModal(); await render(); secretModal('Signing secret', 'Use this to verify the DigitalHub-Signature header.', r.secret); };
ACT.revealSecret = d => run(async () => { const r = await api('POST', `/m-api/webhooks/${d.id}/secret`); openModal({ title: 'Signing secret', body: `<div class="secret">${esc(r.secret)}</div>`, foot: `<button class="btn" data-act="rotateSecret" data-id="${d.id}">Rotate</button><button class="btn primary" data-act="copy" data-text="${esc(r.secret)}">Copy</button>` }); }, { noRefresh: true });
ACT.rotateSecret = d => run(async () => { const r = await api('POST', `/m-api/webhooks/${d.id}/rotate`); secretModal('New signing secret', 'The previous secret stops working now.', r.secret); }, { noRefresh: true });
ACT.toggleEndpoint = d => run(() => api('POST', `/m-api/webhooks/${d.id}/status`, { enabled: !!d.enabled }));
ACT.testEndpoint = d => run(() => api('POST', `/m-api/webhooks/${d.id}/test`), { ok: 'Test event queued — see Delivery logs' });
ACT.deleteEndpoint = d => confirmBox('Delete endpoint?', 'Events stop being sent to this URL.', 'Delete', () => api('DELETE', '/m-api/webhooks/' + d.id));
ACT.retryDelivery = d => run(() => api('POST', `/m-api/deliveries/${d.id}/retry`), { ok: 'Retry queued' });
ACT.showEvent = d => openModal({ title: App.cache.events[d.id].type, wide: true, body: `<pre class="code">${esc(JSON.stringify(App.cache.events[d.id], null, 2))}</pre>` });
function apiReference() {
  const E = [['POST', '/v1/checkout/sessions', 'Create a hosted checkout (amount, currency, description, success_url, cancel_url, metadata, payment_methods)'], ['GET', '/v1/checkout/sessions/{id}', 'Retrieve a session (also works with the publishable key)'],
    ['GET', '/v1/payments', 'List payments (?status, ?limit, ?offset)'], ['GET', '/v1/payments/{id}', 'Retrieve a payment'], ['POST', '/v1/payments/{id}/capture', 'Capture an authorized card payment'], ['POST', '/v1/payments/{id}/cancel', 'Release an authorization'],
    ['POST', '/v1/refunds', 'Refund all or part of a payment (payment, amount, reason; crypto: address, network)'], ['GET', '/v1/refunds', 'List refunds'], ['GET', '/v1/balance', 'Pending, available, reserve and hold per currency'],
    ['POST', '/v1/payment_links', 'Create a payment link'], ['GET', '/v1/payment_links', 'List links'], ['POST', '/v1/payment_links/{id}/deactivate', 'Deactivate a link'],
    ['GET', '/v1/payouts', 'List payouts'], ['POST', '/v1/payouts', 'Request a payout (currency, amount, destination)'], ['GET', '/v1/events', 'List events (?type)'], ['GET', '/v1/events/{id}', 'Retrieve an event'],
    ['POST', '/v1/webhook_endpoints', 'Create an endpoint (url, enabled_events) — returns the signing secret once'], ['GET', '/v1/webhook_endpoints', 'List endpoints'], ['DELETE', '/v1/webhook_endpoints/{id}', 'Delete an endpoint'], ['GET', '/v1/account', 'Account, available methods and crypto pairs']];
  return `<div class="card stack"><h2>Conventions</h2>${kv([['Base URL', `<span class="mono">${esc(location.origin)}/v1</span>`], ['Auth', '<span class="mono">Authorization: Bearer dh_test_sk_…</span> (test) or <span class="mono">dh_live_sk_…</span> (live)'], ['Amounts', 'Integers in minor units (2500 = $25.00)'], ['Bodies', 'JSON or form-encoded'], ['Idempotency', '<span class="mono">Idempotency-Key</span> header on every POST; same key + same body replays the first response'], ['Errors', '<span class="mono">{"error":{"type","code","message"}}</span> with HTTP 400/401/403/404/409/422/429'], ['Rate limit', '100 requests / 10 s per key']])}</div>`
    + table([{ h: 'Method', v: e => `<span class="tag">${e[0]}</span>` }, { h: 'Path', v: e => `<span class="mono">${esc(e[1])}</span>` }, { h: 'Description', v: e => esc(e[2]) }], E);
}

/* ---------------- integrations (plugins, SDKs, snippets) ---------------- */
const SNIP = {
  curl: o => `curl ${o}/v1/checkout/sessions \\\n  -H "Authorization: Bearer $DH_SECRET_KEY" \\\n  -H "Idempotency-Key: order_1001" \\\n  -d amount=2500 -d currency=USD \\\n  -d description="Order #1001" \\\n  -d "metadata[order_id]=1001" \\\n  -d success_url=https://yourshop.com/thanks \\\n  -d cancel_url=https://yourshop.com/cart`,
  node: o => `// npm-free: copy sdk/node/digitalhub.js into your project\nconst DigitalHub = require('./digitalhub');\nconst dh = new DigitalHub(process.env.DH_SECRET_KEY, { baseUrl: '${o}' });\n\nconst session = await dh.checkout.create({\n  amount: 2500, currency: 'USD', description: 'Order #1001',\n  metadata: { order_id: '1001' },\n  success_url: 'https://yourshop.com/thanks', cancel_url: 'https://yourshop.com/cart',\n}, { idempotencyKey: 'order_1001' });\n\nres.redirect(session.url);`,
  php: o => `<?php\n$ch = curl_init('${o}/v1/checkout/sessions');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => [\n    'Authorization: Bearer ' . getenv('DH_SECRET_KEY'),\n    'Content-Type: application/json',\n    'Idempotency-Key: order_1001',\n  ],\n  CURLOPT_POSTFIELDS => json_encode([\n    'amount' => 2500, 'currency' => 'USD', 'description' => 'Order #1001',\n    'metadata' => ['order_id' => '1001'],\n    'success_url' => 'https://yourshop.com/thanks',\n    'cancel_url' => 'https://yourshop.com/cart',\n  ]),\n]);\n$session = json_decode(curl_exec($ch), true);\nheader('Location: ' . $session['url']);`,
  python: o => `import os, requests\n\nr = requests.post(\n    "${o}/v1/checkout/sessions",\n    headers={"Authorization": f"Bearer {os.environ['DH_SECRET_KEY']}", "Idempotency-Key": "order_1001"},\n    json={"amount": 2500, "currency": "USD", "description": "Order #1001",\n          "metadata": {"order_id": "1001"},\n          "success_url": "https://yourshop.com/thanks", "cancel_url": "https://yourshop.com/cart"},\n)\nsession = r.json()\n# redirect the customer to session["url"]`,
  verifyNode: () => `const crypto = require('crypto');\n// Use the RAW request body (express.raw({ type: 'application/json' }))\nfunction verify(rawBody, header, secret) {\n  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));\n  const expected = crypto.createHmac('sha256', secret).update(parts.t + '.' + rawBody).digest('hex');\n  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 || ''));\n  if (!ok || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) throw new Error('bad signature');\n  return JSON.parse(rawBody); // then dedupe by event.id\n}`,
  verifyPhp: () => `$raw = file_get_contents('php://input');\nparse_str(str_replace(',', '&', $_SERVER['HTTP_DIGITALHUB_SIGNATURE'] ?? ''), $sig);\n$expected = hash_hmac('sha256', $sig['t'] . '.' . $raw, getenv('DH_WEBHOOK_SECRET'));\nif (!hash_equals($expected, $sig['v1'] ?? '') || abs(time() - (int)$sig['t']) > 300) {\n  http_response_code(400); exit;\n}\n$event = json_decode($raw, true); // dedupe by $event['id']`,
};
VIEWS.integrations = async () => {
  const o = location.origin, lang = tab('lang', 'curl'), vlang = tab('vlang', 'verifyNode');
  const card = (logo, title, text, actions) => `<div class="card integration"><div class="row"><span class="logo">${logo}</span><h2>${esc(title)}</h2></div><div class="muted">${text}</div><div class="row">${actions}</div></div>`;
  return head('Integrate', 'Plugins & integrations', 'Connect WordPress / WooCommerce, Shopify, custom websites and apps to Digital Hub. All integrations use your API keys and signed webhooks.')
    + `<div class="grid g2">
      ${card('W', 'WordPress · WooCommerce', `<ol class="stepper"><li>Download the plugin and upload it in <b>Plugins → Add New → Upload</b>.</li><li>Activate it, open <b>WooCommerce → Settings → Payments → Digital Hub</b>.</li><li>Paste your <b>secret key</b> (Developers → API keys) and API URL <span class="mono">${esc(o)}</span>.</li><li>Add a webhook endpoint here with URL <span class="mono">https://YOUR-SHOP/wc-api/digitalhub/</span> and paste its signing secret into the plugin.</li><li>Place a test order — card and USDT/USDC appear at checkout; orders are marked paid by the signed webhook. Refunds from WooCommerce call the refunds API.</li></ol>`, `<a class="btn primary" href="/downloads/digitalhub-woocommerce.zip">Download plugin (.zip)</a><a class="btn" href="#/developers">Get API key</a>`)}
      ${card('S', 'Shopify', `Shopify only shows third-party gateways at checkout for <b>approved Shopify Payments Partners</b>. Until Digital Hub is approved, use the bridge app:<ol class="stepper"><li>Add a <b>manual payment method</b> named “Card or USDT/USDC (Digital Hub)”.</li><li>Run the bridge (Node, no dependencies) with your Shopify Admin API token and Digital Hub secret key.</li><li>On <span class="mono">orders/create</span> it creates a Digital Hub checkout and emails / shows the pay link; on <span class="mono">payment.succeeded</span> it marks the Shopify order paid.</li></ol>`, `<a class="btn primary" href="/downloads/digitalhub-shopify-bridge.zip">Download bridge (.zip)</a>`)}
      ${card('&lt;/&gt;', 'Any website · pay button', `Create a payment link, then paste this anywhere. The script turns links into styled buttons.<pre class="code" style="margin-top:8px">${esc(`<a href="${o}/l/YOUR_LINK" class="dh-pay-button">Pay $25.00</a>\n<script src="${o}/js/digitalhub.js" async></script>`)}</pre>`, `<a class="btn" href="#/links">Payment links</a>`)}
      ${card('N', 'Node.js SDK', 'Zero-dependency client for checkout sessions, payments, refunds, payment links, balance, payouts and webhook signature verification.', `<a class="btn primary" href="/downloads/digitalhub-node-sdk.zip">Download SDK (.zip)</a>`)}</div>
    <div class="card"><div class="card-head"><h2>Create a checkout session</h2></div><div class="code-tabs">${[['curl', 'cURL'], ['node', 'Node.js'], ['php', 'PHP'], ['python', 'Python']].map(([k, l]) => `<button data-act="tab" data-group="lang" data-tab="${k}" aria-selected="${lang === k}">${l}</button>`).join('')}</div><pre class="code">${esc(SNIP[lang](o))}</pre></div>
    <div class="card"><div class="card-head"><h2>Verify webhooks</h2></div><div class="code-tabs">${[['verifyNode', 'Node.js'], ['verifyPhp', 'PHP']].map(([k, l]) => `<button data-act="tab" data-group="vlang" data-tab="${k}" aria-selected="${vlang === k}">${l}</button>`).join('')}</div><pre class="code">${esc(SNIP[vlang]())}</pre></div>
    ${note('info', 'Test first', 'Use test keys and test cards (4242 4242 4242 4242, any future expiry, any CVC; 3DS code 123456). Sandbox crypto checkout includes a wallet simulator.')}`;
};

/* ---------------- go live ---------------- */
VIEWS.golive = async () => {
  const d = await api('GET', '/m-api/onboarding'), done = d.steps.filter(s => s.done).length, k = d.kyb, b = k.business || {};
  const provCard = p => { const st = d.providers[p.id] || 'not_requested', open = d.requests.some(q => q.provider === p.id && q.type === 'connection' && ['requested', 'submitted'].includes(q.status));
    return `<div class="card stack"><div class="card-head" style="margin:0"><h3>${esc(p.name)}</h3>${badge(st)}</div><p class="muted">${esc(p.note)}</p><div class="row">${st === 'approved' ? '<span class="faint">Connected</span>' : open ? '<button class="btn sm" disabled>Request pending</button>' : `<button class="btn sm primary" data-act="requestProvider" data-provider="${p.id}" data-type="connection">Request connection</button>`}
      ${p.id === 'card_acquirer' && st === 'approved' ? (d.non3ds ? `<span class="tag">non-3DS: ${esc(d.non3ds.ref)}</span>` : d.requests.some(q => q.type === 'non3ds' && ['requested', 'submitted'].includes(q.status)) ? '<span class="tag">non-3DS requested</span>' : `<button class="btn sm ghost" data-act="requestProvider" data-provider="card_acquirer" data-type="non3ds">Request non-3DS</button>`) : ''}</div></div>`; };
  const ownersRows = (k.owners.length ? k.owners : [{}]).map((o, i) => ownerRow(o, i)).join('');
  return head('Business', 'Go live', 'Complete verification, connect providers and pass the checklist. Digital Hub reviews each step; live payments also need provider approval.')
    + `<div class="split"><div class="card"><div class="card-head"><h2>Checklist</h2>${badge(done === d.steps.length ? 'done' : 'pending', `${done}/${d.steps.length}`)}</div><div class="progress" style="margin-bottom:12px"><div style="width:${Math.round(done / d.steps.length * 100)}%"></div></div>
      <ol class="onb">${d.steps.map((s, i) => `<li><span class="n ${s.done ? 'done' : ''}">${s.done ? '✓' : i + 1}</span><div><b>${esc(s.label)}</b><div class="muted" style="font-size:.82rem">${esc(s.detail)}</div></div>${badge(s.done ? 'done' : 'pending', s.done ? 'done' : 'to do')}</li>`).join('')}</ol></div>
      <div class="card stack"><h2>Status</h2>${kv([['Verification', badge(d.status)], ['Live payments', d.live_ready ? badge('pending', 'not active') : badge('active')], ['Why', esc(d.live_ready || 'Ready')]])}${note('warn', 'Real money', 'Live processing requires Digital Hub approval, provider approval for your business and a completed security review. Card acquiring is pending partner integration; live crypto runs through Binance Pay or Coinbase once authorized.')}</div></div>
    <form class="card stack" data-form="kyb"><div class="card-head" style="margin:0"><h2>Business verification (KYB)</h2>${badge(k.submitted ? (d.status === 'approved' ? 'approved' : 'submitted') : 'pending', k.submitted ? (d.status === 'approved' ? 'verified' : 'under review') : 'not submitted')}</div>
      <div class="form-grid">${field('Legal entity name', input('legal_name', { req: true, value: b.legal_name || M().legal_name }))}${field('Registration number', input('registration_number', { req: true, value: b.registration_number || '' }))}
      ${field('Country of incorporation', select('country', Object.entries(COUNTRIES), b.incorporation_country || M().country))}${field('Website', input('website', { value: b.website || M().website || '' }))}
      <label class="field full"><span>Registered address</span>${input('address', { req: true, value: b.address || '' })}</label>
      <label class="field full"><span>What do you sell?</span><textarea name="description" required>${esc(b.description || '')}</textarea></label>${field('Expected monthly volume (USD)', input('monthly_volume_usd', { type: 'number', value: b.monthly_volume_usd || '' }))}</div>
      <h3>Beneficial owners (25%+)</h3><div class="stack" id="owners">${ownersRows}</div><div><button type="button" class="btn sm ghost" data-act="addOwnerRow">Add owner</button></div>
      <p class="faint">Digital Hub will request ID documents for each owner by email. Do not upload documents here.</p><div class="err" id="formErr"></div>
      <div><button class="btn primary" type="submit" ${d.status === 'approved' ? 'disabled' : ''}>${k.submitted ? 'Update submission' : 'Submit for review'}</button></div></form>
    <h2>Payment providers</h2><div class="grid g2">${d.provider_info.map(provCard).join('')}</div>`;
};
const ownerRow = (o, i) => `<div class="form-grid" data-owner="${i}" style="grid-template-columns:2fr 1fr 1fr 1fr">${field('Full name', `<input type="text" data-o="name" value="${esc(o.name || '')}">`)}${field('Ownership %', `<input type="number" data-o="pct" min="0" max="100" value="${esc(o.pct ?? '')}">`)}${field('Date of birth', `<input type="date" data-o="dob" value="${esc(o.dob || '')}">`)}${field('Nationality', `<input type="text" data-o="nationality" maxlength="2" placeholder="US" value="${esc(o.nationality || '')}">`)}</div>`;
ACT.addOwnerRow = () => { const box = $('#owners'); box.insertAdjacentHTML('beforeend', ownerRow({}, box.children.length)); };
FORM.kyb = async (f, form) => { f.owners = $$('[data-owner]', form).map(r => Object.fromEntries($$('[data-o]', r).map(i => [i.dataset.o, i.value]))).filter(o => o.name); await api('POST', '/m-api/kyb', f); toast('Submitted. Digital Hub compliance will review it.'); await loadMe(); };
ACT.requestProvider = d => formModal(d.type === 'non3ds' ? 'Request non-3DS processing' : 'Request provider connection', 'providerReq',
  (d.type === 'non3ds' ? note('info', '', 'The acquirer decides whether low-risk payments from non-SCA cards may skip 3DS. Fraud-chargeback liability stays with you for those payments.') : '')
  + field(d.type === 'non3ds' ? 'Justification (business model, fraud and chargeback rates)' : 'Use case', '<textarea name="use_case" required minlength="10"></textarea>') + field('Expected monthly volume (USD)', input('monthly_volume_usd', { type: 'number' })), 'Send request', { data: { provider: d.provider, type: d.type } });
FORM.providerReq = async (f, form) => { await api('POST', '/m-api/provider-requests', { ...f, provider: form.dataset.provider, type: form.dataset.type }); closeModal(); toast('Request sent to Digital Hub'); await loadMe(); };

/* ---------------- settings & team ---------------- */
VIEWS.settings = async () => {
  const t = tab('set', 'profile'), m = M(); let body = '';
  if (t === 'profile') body = `<form class="card stack" data-form="settings"><h2>Public profile</h2><div class="form-grid">${field('Display name (shown at checkout)', input('name', { value: m.name, req: true }))}${field('Support email', input('support_email', { type: 'email', value: m.support_email || '' }))}${field('Website', input('website', { value: m.website || '' }))}${field('Minimum payout (minor units)', input('minPayout', { type: 'number', value: m.minPayout }))}</div>
    <label class="check"><input type="checkbox" name="dualControl" ${m.dualControl ? 'checked' : ''}> Dual control: every payout needs Digital Hub review</label><div class="err" id="formErr"></div><div><button class="btn primary" type="submit">Save</button></div></form>`;
  if (t === 'checkout') body = `<form class="card stack" data-form="threeds"><h2>Card authentication & capture</h2><div class="form-grid">
    ${field('3DS policy', `<select name="mode"><option value="always" ${m.threeDS.mode === 'always' ? 'selected' : ''}>Always authenticate</option><option value="risk" ${m.threeDS.mode === 'risk' ? 'selected' : ''} ${m.non3ds ? '' : 'disabled'}>Risk-based (non-3DS where permitted)</option></select>`, m.non3ds ? `Acquirer authorization ${esc(m.non3ds.ref)} on file.` : 'Risk-based mode needs written acquirer authorization (request it under Go live).')}
    ${field('Step-up risk threshold (10–90)', input('riskThreshold', { type: 'number', value: m.threeDS.riskThreshold, extra: 'min="10" max="90"' }))}
    ${field('Capture', select('captureMode', [['auto', 'Automatic on authorization'], ['manual', 'Manual within 7 days']], m.captureMode))}
    <label class="check" style="align-self:end"><input type="checkbox" name="lowValueExemption" ${m.threeDS.lowValueExemption ? 'checked' : ''}> Request low-value exemption (EEA/UK, under €30)</label></div><div class="err" id="formErr"></div><div><button class="btn primary" type="submit">Save</button></div></form>`;
  if (t === 'team') {
    const d = await api('GET', '/m-api/team');
    body = `<div class="card"><div class="card-head"><h2>Team</h2>${can('team') ? '<button class="btn primary" data-act="inviteMember">Add member</button>' : ''}</div>${table([{ h: 'Name', v: u => `${esc(u.name)}<div class="faint" style="font-size:.75rem">${esc(u.email)}</div>` }, { h: 'Role', v: u => esc(d.roles[u.role]?.label || u.role) }, { h: '2FA', v: u => badge(u.mfa_enabled ? 'enabled' : 'pending', u.mfa_enabled ? 'on' : 'off') }, { h: 'Status', v: u => badge(u.status) }, { h: 'Last sign-in', v: u => fmtDT(u.last_login) }, { h: '', v: u => u.role !== 'owner' && u.status === 'active' && can('team') ? `<button class="btn sm ghost" data-act="removeMember" data-id="${u.id}">Remove</button>` : '' }], d.users)}
      <p class="faint" style="margin-top:8px">Roles: ${Object.values(d.roles).map(r => `<b>${esc(r.label)}</b> (${esc(r.perms.join(', '))})`).join(' · ')}</p></div>`;
  }
  return head('Business', 'Settings & team') + tabs('set', [['profile', 'Profile & payouts'], ['checkout', 'Checkout & 3DS'], ['team', 'Team']], 'profile') + body;
};
FORM.settings = async f => { await api('PATCH', '/m-api/settings', { ...f, minPayout: +f.minPayout }); toast('Saved'); await loadMe(); };
FORM.threeds = async f => { await api('PATCH', '/m-api/settings', { captureMode: f.captureMode, threeDS: { mode: f.mode, riskThreshold: +f.riskThreshold, lowValueExemption: f.lowValueExemption } }); toast('Saved'); await loadMe(); };
ACT.inviteMember = () => formModal('Add team member', 'invite', `${field('Name', input('name', { req: true }))}${field('Email', input('email', { type: 'email', req: true }))}${field('Role', select('role', [['admin', 'Admin'], ['finance', 'Finance'], ['developer', 'Developer'], ['support', 'Support'], ['viewer', 'Viewer']]))}`, 'Add member');
FORM.invite = async f => { const r = await api('POST', '/m-api/team', f); closeModal(); await render(); secretModal('Temporary password', `Share this with <b>${esc(r.user.email)}</b> through a secure channel. They should change it and enable 2FA on first sign-in.`, r.temporary_password); };
ACT.removeMember = d => confirmBox('Remove member?', 'They lose access immediately.', 'Remove', () => api('DELETE', '/m-api/team/' + d.id));
