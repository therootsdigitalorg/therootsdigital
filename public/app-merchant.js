'use strict';
/* Merchant dashboard: Digital Hub Wallet + Cash App Pay. */
NAV.merchant = [
  ['Payments', [['home', 'Home'], ['payments', 'Transactions'], ['links', 'Payment links'], ['disputes', 'Refunds & disputes']]],
  ['Wallet', [['balances', 'Digital Hub Wallet'], ['destinations', 'Payout bank accounts']]],
  ['Integrate', [['developers', 'Developers & API'], ['integrations', 'WooCommerce & plugins']]],
  ['Business', [['golive', 'Go live'], ['settings', 'Settings']]],
];
const M = () => App.me.merchant;
const usd = m => fmt(m, 'USD');
const caStatus = s => badge(String(s || 'NOT_REGISTERED').toLowerCase(), String(s || 'not registered').replace(/_/g, ' ').toLowerCase());
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
  { h: 'Method', v: p => p.method === 'cashapp' ? '<span class="tag">Cash App Pay</span>' : `<span class="tag">${esc(p.method)} (legacy)</span>` },
  { h: 'Amount', r: 1, v: p => fmt(p.amount, p.currency) },
  { h: 'Net', r: 1, v: p => p.net != null ? fmt(p.net, p.currency) : '<span class="faint">—</span>' },
  { h: 'Status', v: p => badge(p.status) },
];
const payRow = p => `class="click" tabindex="0" data-act="openPayment" data-id="${p.id}"`;

/* ---------------- home ---------------- */
VIEWS.home = async () => {
  const d = await api('GET', '/m-api/overview'), m = M(), done = d.onboarding.filter(s => s.done).length, b = d.balances.USD || { pending: 0, available: 0, reserve: 0, hold: 0 };
  return head('Digital Hub Wallet', m.name, `${App.mode === 'test' ? 'Test data' : 'Live data'} · last 30 days · Cash App Pay: ${esc(d.cashapp.environment)}`, `<button class="btn" data-act="newLink">New payment link</button>${App.mode === 'test' && d.cashapp.credentials === 'simulator' ? '<button class="btn" data-act="samplePayments">Create test payments</button>' : ''}<a class="btn primary" href="#/balances">Wallet</a>`)
    + statusBanner() + liveBlocked(d.live_ready)
    + `<div class="grid g4">
      <div class="card kpi"><div class="label">Available</div><div class="value">${usd(b.available)}</div><div class="sub">ready to pay out</div></div>
      <div class="card kpi"><div class="label">Pending settlement</div><div class="value">${usd(b.pending)}</div><div class="sub">captured, awaiting Cash App settlement</div></div>
      <div class="card kpi"><div class="label">Gross volume</div><div class="value">${usd(d.gross_usd)}</div><div class="sub">${d.count} payments · ${d.attempts ? Math.round(d.count / d.attempts * 100) : 0}% success</div></div>
      <div class="card kpi"><div class="label">Fees · refunds · disputes</div><div class="value">${usd(d.fees_usd)}</div><div class="sub">${usd(d.refunded_usd)} refunded · ${d.disputes_open} open disputes</div></div></div>
    <div class="split"><div class="card"><div class="card-head"><h2>Daily volume</h2><span class="faint">14 days</span></div>${barChart(d.series)}</div>
      <div class="card"><div class="card-head"><h2>Go-live progress</h2>${badge(done === d.onboarding.length ? 'done' : 'pending', `${done}/${d.onboarding.length}`)}</div><div class="progress" style="margin-bottom:10px"><div style="width:${Math.round(done / d.onboarding.length * 100)}%"></div></div>
        <div class="stack" style="gap:6px">${d.onboarding.filter(s => !s.done).slice(0, 4).map(s => `<div class="row" style="justify-content:space-between"><span>${esc(s.label)}</span>${badge('pending', 'to do')}</div>`).join('') || '<p class="muted">All steps complete.</p>'}</div><a href="#/golive" style="margin-top:10px;display:inline-block">Open checklist →</a>
        ${d.attention.length ? `<div class="divider" style="margin:12px 0"></div><h3>Needs attention</h3><div class="stack" style="margin-top:8px">${d.attention.slice(0, 5).map(a => `<button class="btn ghost" style="justify-content:space-between" data-act="openPayment" data-id="${a.payment}"><span>${esc(a.status.replace(/_/g, ' '))}</span><span class="num">${fmt(a.amount, a.currency)}</span></button>`).join('')}</div>` : ''}</div></div>
    <div class="card"><div class="card-head"><h2>Recent payments</h2><a href="#/payments">All transactions →</a></div>${table(payCols, d.recent, { rowAttr: payRow, empty: App.mode === 'test' ? 'No test payments yet. Create a payment link and pay it with the sandbox.' : 'No live payments yet.' })}</div>`;
};
ACT.samplePayments = () => run(() => api('POST', '/m-api/test/sample-payments'), { ok: 'Test payments created through the Cash App simulator' });

/* ---------------- payments ---------------- */
VIEWS.payments = async () => {
  const f = App.filters.pay ||= { q: '', status: '', offset: 0 };
  const d = await api('GET', '/m-api/payments' + qs(f));
  return head('Payments', 'Transactions', 'Every Cash App Pay payment with its Cash App IDs, fees, refunds, ledger entries and events.')
    + `<div class="card"><div class="grid g3">${fInput('pay', 'q', 'Search', 'ID, email, Cash App payment ID, order ID')}${fSelect('pay', 'status', 'Status', [['', 'All statuses'], ...['awaiting_customer', 'processing', 'authorized', 'captured', 'settled', 'declined', 'expired', 'canceled', 'partially_refunded', 'refunded', 'disputed', 'chargeback_lost'].map(s => [s, s.replace(/_/g, ' ')])])}</div></div>`
    + table(payCols, d.data, { rowAttr: payRow, empty: 'No payments match.' })
    + `<div class="pager"><span class="faint">${d.total} payments</span><div class="row">${f.offset > 0 ? '<button class="btn sm" data-act="page" data-bag="pay" data-dir="-1">Previous</button>' : ''}${f.offset + 50 < d.total ? '<button class="btn sm" data-act="page" data-bag="pay" data-dir="1">Next</button>' : ''}</div></div>`;
};
ACT.page = d => { const f = App.filters[d.bag]; f.offset = Math.max(0, (f.offset || 0) + 50 * d.dir); render(); };
function paymentBody(d, admin) {
  const p = d.payment, c = p.cash_app || {};
  let b = `<div class="row" style="justify-content:space-between"><div><div class="co-amt" style="font-size:1.5rem">${fmt(p.amount, p.currency)}</div><div class="muted">${esc(p.description)}</div></div>${badge(p.status)}</div>`;
  b += kv([['Payment ID', `<span class="mono">${esc(p.id)}</span> <button class="btn sm ghost" data-act="copy" data-text="${esc(p.id)}">Copy</button>`], admin && ['Merchant', esc(d.merchant?.name)], ['Mode', badge(p.livemode ? 'live' : 'test')],
    ['Customer', `${esc(p.customer?.name || '—')} · ${esc(p.customer?.email || 'no email')}`], ['Created', fmtDT(p.created)],
    Object.keys(p.metadata || {}).length && ['Metadata', `<span class="mono">${esc(JSON.stringify(p.metadata))}</span>`], p.decline_code && ['Decline code', `<span class="mono">${esc(p.decline_code)}</span>`]]);
  if (p.method === 'cashapp') b += `<h3>Cash App Pay</h3>` + kv([['Environment', esc(c.environment)], ['Customer request', `<span class="mono">${esc(c.customer_request_id || '—')}</span> ${c.request_status ? badge(c.request_status.toLowerCase(), c.request_status) : ''}`],
    ['Cash App payment', `<span class="mono">${esc(c.payment_id || '—')}</span> ${c.payment_status ? badge(c.payment_status.toLowerCase(), c.payment_status) : ''}`], c.capture_before && ['Capture before', fmtDT(Date.parse(c.capture_before))]]);
  b += `<h3>Amounts</h3>` + kv([['Gross', fmt(p.amount, p.currency)], p.fees && ['Cash App fee', '−' + fmt(p.fees.provider, p.currency)], p.fees && ['Platform fee', '−' + fmt(p.fees.platform, p.currency)], p.net != null && ['Net to wallet', `<b>${fmt(p.net, p.currency)}</b>`], p.amount_refunded && ['Refunded', '−' + fmt(p.amount_refunded, p.currency)]]);
  if (d.dispute) b += `<h3>Dispute</h3>` + kv([['Reason', esc(d.dispute.reason)], ['State', badge(d.dispute.status, d.dispute.state)], ['Amount', fmt(d.dispute.amount, d.dispute.currency)], ['Respond by', fmtDate(d.dispute.response_due_at)],
    d.dispute.evidence?.length && ['Evidence sent', d.dispute.evidence.map(e => `<div><span class="tag">${esc(e.category)}</span> ${esc(e.text)}</div>`).join('')]]);
  if (d.refunds?.length) b += `<h3>Refunds</h3>` + table([{ h: 'Date', v: r => fmtDT(r.created) }, { h: 'Amount', r: 1, v: r => fmt(r.amount, r.currency) }, { h: 'Cash App refund', v: r => `<span class="mono">${esc(short(r.cash_app_refund_id || '—', 10, 4))}</span>` }, { h: 'Status', v: r => badge(r.status) }], d.refunds);
  b += `<h3>Timeline</h3><ul class="timeline">${[...d.events].reverse().map(e => `<li><div><b>${esc(e.status.replace(/_/g, ' '))}</b> <span class="t">${fmtDT(e.at)}</span><div class="muted" style="font-size:.84rem">${esc(e.note || '')}</div></div></li>`).join('')}</ul>`;
  b += `<h3>Ledger <span class="faint" style="font-weight:500">(debit +, credit −)</span></h3>` + table([{ h: 'Journal', v: e => `<span class="mono">${esc(e.journal_key.split(':').slice(1).join(':'))}</span>` }, { h: 'Account', v: e => esc(e.account) }, { h: 'Amount', r: 1, v: e => fmt(e.amount, e.currency) }], d.ledger, { empty: 'No money has moved: the wallet records funds only after Cash App confirms them.' });
  if (d.webhooks?.length) b += `<h3>Events sent to your server</h3>` + table([{ h: 'Event', v: e => `<span class="mono">${esc(e.type)}</span>` }, { h: 'Time', v: e => fmtDT(e.created) }], d.webhooks);
  if (d.provider_events?.length) b += `<h3>Cash App events received</h3>` + table([{ h: 'Event', v: e => esc(e.type) }, { h: 'Signature', v: e => esc(e.sig) }], d.provider_events);
  if (d.api_logs?.length) b += `<h3>Cash App API calls</h3>` + table([{ h: 'Time', v: l => fmtDT(l.created_at) }, { h: 'Call', v: l => `<span class="mono">${esc(l.method)} ${esc(l.path)}</span>` }, { h: 'HTTP', r: 1, v: l => l.http ?? '—' }, { h: 'Result', v: l => badge(l.status) + (l.error ? ` <span class="faint">${esc(l.error)}</span>` : '') }], d.api_logs);
  return b;
}
ACT.openPayment = d => openDrawer(async () => {
  const x = await api('GET', '/m-api/payments/' + d.id), p = x.payment, B = (act, l, c = '') => `<button class="btn ${c}" data-act="${act}" data-id="${p.id}">${l}</button>`;
  let foot = '';
  if (['awaiting_customer', 'processing', 'authorized'].includes(p.status)) foot += B('syncPayment', 'Check status with Cash App');
  if (p.status === 'authorized') foot += B('cancelPayment', 'Void', 'danger') + B('capturePayment', 'Capture', 'primary');
  if (x.refundable > 0 && can('refunds')) foot += B('refundPayment', 'Refund');
  if (x.dispute?.status === 'needs_response') foot += `<button class="btn" data-act="disputeOpen" data-id="${x.dispute.id}">Respond to dispute</button>`;
  App.cache.payment = x;
  return { title: 'Payment', body: paymentBody(x, false), foot };
});
ACT.syncPayment = d => run(() => api('POST', `/m-api/payments/${d.id}/sync`), { ok: 'Status refreshed from Cash App' });
ACT.capturePayment = d => run(() => api('POST', `/m-api/payments/${d.id}/capture`), { ok: 'Payment captured' });
ACT.cancelPayment = d => confirmBox('Void this authorization?', 'Cash App releases the hold on the customer\'s funds.', 'Void', () => api('POST', `/m-api/payments/${d.id}/cancel`));
ACT.refundPayment = () => {
  const x = App.cache.payment, p = x.payment;
  formModal('Refund payment', 'refund', field('Amount (USD)', input('amount', { type: 'number', value: (x.refundable / 100).toFixed(2), req: true, extra: `step="0.01" min="0.01" max="${(x.refundable / 100).toFixed(2)}"` }), `Up to ${fmt(x.refundable, 'USD')}. Cash App returns the money to the customer's Cash App account. Fees are not returned.`)
    + field('Reason', select('reason', ['requested_by_customer', 'duplicate', 'fraudulent', 'item_returned'])), 'Refund', { data: { id: p.id, idem: 'idem_' + uid() } });
};
FORM.refund = async (f, form) => { const r = await api('POST', `/m-api/payments/${form.dataset.id}/refund`, { ...f, amount: toMinor(f.amount), idempotency_key: form.dataset.idem }); closeModal(); toast(r.replayed ? 'Already submitted (duplicate ignored)' : r.status === 'succeeded' ? 'Refund confirmed by Cash App' : r.status === 'pending' ? 'Refund sent; waiting for Cash App to confirm' : 'Refund ' + r.status); await render(); refreshDrawer(); };

/* ---------------- refunds & disputes ---------------- */
const EVIDENCE = ['GENERIC_EVIDENCE', 'PROOF_OF_DELIVERY_DOCUMENTATION', 'TRACKING_NUMBER', 'RECEIPT', 'CARDHOLDER_COMMUNICATION', 'CANCELLATION_OR_REFUND_DOCUMENTATION', 'PRODUCT_OR_SERVICE_DESCRIPTION', 'REBUTTAL_EXPLANATION', 'ONLINE_OR_APP_ACCESS_LOG', 'DUPLICATE_CHARGE_DOCUMENTATION'];
VIEWS.disputes = async () => {
  const t = tab('rd', 'disputes');
  const body = t === 'disputes'
    ? table([{ h: 'Opened', v: d => fmtDT(d.created) }, { h: 'Payment', v: d => `<span class="mono">${esc(short(d.payment))}</span>` }, { h: 'Reason', v: d => esc(d.reason) }, { h: 'Amount', r: 1, v: d => fmt(d.amount, d.currency) }, { h: 'Respond by', v: d => fmtDate(d.response_due_at) }, { h: 'State', v: d => badge(d.status, d.state) },
        { h: '', v: d => d.status === 'needs_response' ? `<button class="btn sm primary" data-act="disputeOpen" data-id="${d.id}">Respond</button>` : '' }], await api('GET', '/m-api/disputes'), { empty: 'No disputes. Cash App opens them when a customer contests a payment.' })
    : table([{ h: 'Date', v: r => fmtDT(r.created) }, { h: 'Payment', v: r => `<span class="mono">${esc(short(r.payment))}</span>` }, { h: 'Amount', r: 1, v: r => fmt(r.amount, r.currency) }, { h: 'Reason', v: r => esc(r.reason || '—') }, { h: 'Cash App refund', v: r => `<span class="mono">${esc(short(r.cash_app_refund_id || '—', 10, 4))}</span>` }, { h: 'Status', v: r => badge(r.status) }], await api('GET', '/m-api/refunds'), { empty: 'No refunds yet.', rowAttr: r => `class="click" data-act="openPayment" data-id="${r.payment}"` });
  return head('Payments', 'Refunds & disputes', 'Refunds and disputes run through Cash App. Disputed amounts are held from your available wallet balance until Cash App decides.') + tabs('rd', [['disputes', 'Disputes'], ['refunds', 'Refunds']], 'disputes') + body;
};
ACT.disputeOpen = d => openModal({ title: 'Respond to dispute', body: `<p class="muted">Add evidence first, then challenge. Or accept the dispute to let the customer keep the money.</p>
  <form class="stack" data-form="evidence" id="mf" data-id="${d.id}">${field('Evidence type', select('category', EVIDENCE.map(e => [e, e.replace(/_/g, ' ').toLowerCase()])))}${field('Evidence (up to 500 characters)', '<textarea name="text" required minlength="10" maxlength="500"></textarea>')}<div class="err" id="formErr"></div></form>`,
  foot: `<button class="btn danger" data-act="disputeDo" data-id="${d.id}" data-a="accept">Accept dispute</button><button class="btn" type="submit" form="mf">Add evidence</button><button class="btn primary" data-act="disputeDo" data-id="${d.id}" data-a="challenge">Challenge</button>` });
FORM.evidence = async (f, form) => { await api('POST', `/m-api/disputes/${form.dataset.id}/evidence`, f); form.reset(); toast('Evidence sent to Cash App'); };
ACT.disputeDo = d => confirmBox(d.a === 'accept' ? 'Accept this dispute?' : 'Challenge this dispute?', d.a === 'accept' ? 'The customer keeps the disputed amount. This cannot be undone.' : 'Cash App reviews your evidence and decides.', d.a === 'accept' ? 'Accept' : 'Challenge', async () => { await api('POST', `/m-api/disputes/${d.id}/${d.a}`); closeDrawer(); }, d.a === 'accept');

/* ---------------- payment links ---------------- */
VIEWS.links = async () => {
  const links = await api('GET', '/m-api/links');
  return head('Payments', 'Payment links', 'No-code checkout: share a link by chat, email, social media or QR code. Customers pay with Cash App Pay.', `<button class="btn primary" data-act="newLink">New payment link</button>`)
    + statusBanner()
    + table([{ h: 'Created', v: l => fmtDate(l.created) }, { h: 'Description', v: l => esc(l.description) + (l.reusable ? ' <span class="tag">reusable</span>' : '') }, { h: 'Amount', r: 1, v: l => fmt(l.amount, l.currency) },
      { h: 'Paid', r: 1, v: l => l.paid }, { h: 'Status', v: l => badge(l.status) },
      { h: '', v: l => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-act="shareLink" data-url="${esc(l.url)}" data-desc="${esc(l.description)}">Share</button><a class="btn sm" href="${esc(l.url)}" target="_blank" rel="noopener">Open</a><button class="btn sm ghost" data-act="linkStatus" data-id="${l.id}" data-active="${l.status === 'active' ? '' : '1'}">${l.status === 'active' ? 'Deactivate' : 'Activate'}</button></div>` }], links, { empty: 'No payment links yet.' });
};
ACT.newLink = () => formModal('New payment link', 'link', `${field('Amount (USD)', input('amount', { type: 'number', req: true, ph: '0.00', extra: 'step="0.01" min="1"' }))}
  ${field('Description', input('description', { req: true, extra: 'maxlength="200"', ph: 'What the customer pays for' }))}
  <div class="form-grid">${field('Expires', select('expires_in_days', [['0', 'Never'], ['1', 'In 1 day'], ['7', 'In 7 days'], ['30', 'In 30 days']], '0'))}<label class="check" style="align-self:end"><input type="checkbox" name="reusable" checked> Reusable (many customers)</label></div>`, 'Create link');
FORM.link = async f => { const l = await api('POST', '/m-api/links', { amount: toMinor(f.amount), currency: 'USD', description: f.description, expires_in_days: +f.expires_in_days, reusable: f.reusable }); closeModal(); await render(); ACT.shareLink({ url: l.url, desc: l.description }); };
ACT.shareLink = d => openModal({ title: 'Share payment link', body: `<div class="row" style="align-items:flex-start"><div class="qr" id="lq"></div><div class="stack" style="flex:1;min-width:200px"><b>${esc(d.desc)}</b><div class="addr">${esc(d.url)}</div><div class="row"><button class="btn sm primary" data-act="copy" data-text="${esc(d.url)}">Copy link</button><a class="btn sm" href="${esc(d.url)}" target="_blank" rel="noopener">Open checkout</a></div>
  <span class="faint">Embed on any website:</span><pre class="code">${esc(`<a href="${d.url}" class="dh-pay-button">Pay with Cash App Pay</a>\n<script src="${location.origin}/js/digitalhub.js" async></script>`)}</pre></div></div>`, wide: true, onMount: () => qrInto($('#lq'), d.url) });
ACT.linkStatus = d => run(() => api('POST', `/m-api/links/${d.id}/status`, { active: !!d.active }), { ok: 'Link updated' });

/* ---------------- Digital Hub Wallet ---------------- */
VIEWS.balances = async () => {
  const [d, w] = await Promise.all([api('GET', '/m-api/balances'), api('GET', '/m-api/wallet')]);
  const t = tab('wal', 'activity');
  let body = '';
  if (t === 'activity') body = table([{ h: 'Time', v: e => fmtDT(e.at) }, { h: 'Entry', v: e => esc(e.memo) }, { h: 'Balance', v: e => `<span class="tag">${esc(e.account.replace('merchant_', '').replace('_', ' '))}</span>` }, { h: 'Reference', v: e => `<span class="mono">${esc(short(e.ref || '', 8, 4))}</span>` }, { h: 'Change', r: 1, v: e => `<b>${fmt(-e.amount, e.currency)}</b>` }], w.entries, { empty: 'No wallet activity yet.' });
  if (t === 'settlements') body = table([{ h: 'Settled', v: s => fmtDT(s.settled_at) }, { h: 'Payment', v: s => `<span class="mono">${esc(short(s.payment))}</span>` }, { h: 'Net', r: 1, v: s => usd(s.net) }, { h: 'Reserve held', r: 1, v: s => usd(s.reserve || 0) }, { h: 'Cash App settlement', v: s => esc(s.reference || (App.mode === 'test' ? 'sandbox (simulated)' : '—')) }], w.settlements, { empty: 'No settlements yet.' });
  if (t === 'payouts') body = table([{ h: 'Requested', v: p => fmtDT(p.created) }, { h: 'Debit', r: 1, v: p => fmt(p.amount, p.currency) }, { h: 'Fee', r: 1, v: p => fmt(p.fee, p.destination_currency) }, { h: 'Receives', r: 1, v: p => `<b>${fmt(p.amount_received, p.destination_currency)}</b>` }, { h: 'To', v: p => esc(p.destination) }, { h: 'Reference', v: p => esc(p.reference || '—') }, { h: 'Status', v: p => badge(p.status) + (p.reasons?.length && p.status === 'pending_approval' ? `<div class="faint" style="font-size:.72rem">${esc(p.reasons.join('; '))}</div>` : '') }], d.payouts, { empty: 'No payouts yet.' });
  return head('Wallet', 'Digital Hub Wallet', 'A record of verified Cash App payments, fees, refunds, disputes, settlements and payouts. Captured funds are pending until Cash App settles them; settled funds become available, minus the rolling reserve.', can('payouts') ? `<button class="btn primary" data-act="newPayout">Request payout</button>` : '')
    + statusBanner() + (d.hold ? note('danger', 'Settlement hold', esc(d.hold.reason)) : '') + balanceCards(d.balances)
    + tabs('wal', [['activity', 'Wallet activity'], ['settlements', 'Settlements'], ['payouts', 'Payouts']], 'activity') + body;
};
ACT.newPayout = () => run(async () => {
  const [b, dst] = await Promise.all([api('GET', '/m-api/balances'), api('GET', '/m-api/destinations')]);
  const curs = Object.entries(b.balances).filter(([, x]) => x.available > 0);
  if (!curs.length) throw new Error('No available balance to pay out yet.');
  const banks = dst.banks.map(x => [x.id, `${x.currency} · ${x.bank_name} ••${x.last4}`, x.status]);
  if (!banks.some(x => x[2] === 'verified')) throw new Error('Add a bank account and wait for Digital Hub to verify it.');
  openModal({ title: 'Request payout', body: `<form class="stack" data-form="payout" id="mf" data-idem="idem_${uid()}"><div class="form-grid">${field('From balance', `<select name="currency" id="po-cur">${curs.map(([c, x]) => `<option value="${c}">${c} · ${fmt(x.available, c)}</option>`).join('')}</select>`)}
    ${field('Amount', input('amount', { type: 'number', req: true, extra: 'step="0.01" min="0.01" id="po-amt"' }))}</div>
    ${field('Bank account', `<select name="destination" id="po-dst">${banks.map(([idv, l, st]) => `<option value="${idv}" ${st !== 'verified' ? 'disabled' : ''}>${esc(l)}${st !== 'verified' ? ' (' + st.replace(/_/g, ' ') + ')' : ''}</option>`).join('')}</select>`)}
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
      box.innerHTML = kv([['You send', fmt(q.amount, q.sourceCur)], q.sourceCur !== q.destCur && ['Rate', `1 ${q.sourceCur} = ${q.rate.toFixed(4)} ${q.destCur}`], ['Fee', '−' + fmt(q.fee, q.destCur)], ['Bank receives', `<b>${fmt(q.receive, q.destCur)}</b>`], ['Approval', q.reasons.length ? esc(q.reasons.join('; ')) : 'Automatic'], q.amount > q.available && ['Available', `<span class="err">Only ${fmt(q.available, q.sourceCur)}</span>`]]);
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }, 250);
}
FORM.payout = async (f, form) => { const r = await api('POST', '/m-api/payouts', { currency: f.currency, amount: toMinor(f.amount), destination: f.destination, idempotency_key: form.dataset.idem }); closeModal(); toast(r.replayed ? 'Duplicate submit ignored' : r.status === 'completed' ? 'Payout sent' : 'Payout submitted for approval'); render(); };

/* ---------------- payout bank accounts ---------------- */
VIEWS.destinations = async () => {
  const d = await api('GET', '/m-api/destinations'), add = can('payouts');
  return head('Wallet', 'Payout bank accounts', 'Where Digital Hub sends your available wallet balance. Each account is reviewed before any payout.')
    + `<div class="card"><div class="card-head"><h2>Bank accounts</h2>${add ? '<button class="btn" data-act="addBank">Add bank account</button>' : ''}</div>${table([{ h: 'Bank', v: b => esc(b.bank_name) }, { h: 'Currency', v: b => b.currency }, { h: 'Account', v: b => `••${esc(b.last4)}` }, { h: 'Status', v: b => badge(b.status) }, { h: '', v: b => add ? `<button class="btn sm ghost" data-act="removeDest" data-id="${b.id}">Remove</button>` : '' }], d.banks, { empty: 'No bank accounts yet.' })}</div>`;
};
ACT.addBank = () => formModal('Add bank account', 'bank', `<div class="form-grid">${field('Currency', select('currency', FIAT, 'USD'))}${field('Bank name', input('bank_name', { req: true }))}</div>
  ${field('Account holder', input('holder', { req: true, value: M().legal_name }), 'Must match your legal business name.')}${field('Account number or IBAN', input('account', { req: true, extra: 'autocomplete="off"' }), 'Stored encrypted; only the last 4 are shown.')}
  ${field('Routing number / SWIFT', input('routing'))}`, 'Submit for review');
FORM.bank = async f => { await api('POST', '/m-api/banks', f); closeModal(); toast('Bank account submitted for review'); render(); };
ACT.removeDest = d => confirmBox('Remove bank account?', 'Payouts to it stop. Completed payouts are unaffected.', 'Remove', () => api('DELETE', '/m-api/destinations/' + d.id));

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
      <p class="faint" style="margin-top:8px">Secret keys are shown once and stored only as SHA-256 hashes. Keep them on your server or in the WooCommerce plugin settings — never in browser code.</p></div>`;
  }
  if (t === 'webhooks') {
    const d = await api('GET', '/m-api/webhooks');
    body = `<div class="card"><div class="card-head"><h2>Webhook endpoints · ${App.mode}</h2><button class="btn primary" data-act="newEndpoint">Add endpoint</button></div>
      ${table([{ h: 'URL', v: e => `<span class="mono">${esc(e.url)}</span>` }, { h: 'Events', v: e => e.enabled_events.map(x => `<span class="tag">${esc(x === '*' ? 'all events' : x)}</span>`).join(' ') }, { h: 'Status', v: e => badge(e.status) },
        { h: '', v: e => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-act="testEndpoint" data-id="${e.id}">Send test</button><button class="btn sm" data-act="revealSecret" data-id="${e.id}">Signing secret</button><button class="btn sm ghost" data-act="toggleEndpoint" data-id="${e.id}" data-enabled="${e.status === 'enabled' ? '' : '1'}">${e.status === 'enabled' ? 'Disable' : 'Enable'}</button><button class="btn sm danger" data-act="deleteEndpoint" data-id="${e.id}">Delete</button></div>` }], d.endpoints, { empty: 'No endpoints yet. The WooCommerce plugin needs one.' })}
      <p class="faint" style="margin-top:8px">Each event is POSTed with <span class="mono">DigitalHub-Signature: t=…,v1=HMAC-SHA256(secret, t + "." + body)</span>. Reject signatures older than 5 minutes and deduplicate by event ID.</p></div>`;
    App.cache.eventTypes = d.event_types;
  }
  if (t === 'logs') body = table([{ h: 'Time', v: d => fmtDT(d.last_attempt || d.created_at) }, { h: 'Event', v: d => `<span class="mono">${esc(d.type)}</span>` }, { h: 'Endpoint', v: d => `<span class="mono">${esc(short(d.url.replace(/^https?:\/\//, ''), 22, 10))}</span>` }, { h: 'HTTP', r: 1, v: d => d.code ?? '—' }, { h: 'Attempts', r: 1, v: d => d.attempts }, { h: 'Status', v: d => badge(d.status) + (d.error ? `<div class="faint" style="font-size:.72rem">${esc(d.error)}</div>` : '') }, { h: '', v: d => d.status !== 'delivered' ? `<button class="btn sm" data-act="retryDelivery" data-id="${d.id}">Retry</button>` : '' }], await api('GET', '/m-api/deliveries'), { empty: 'No deliveries yet.' });
  if (t === 'events') { const evs = await api('GET', '/m-api/events'); App.cache.events = Object.fromEntries(evs.map(e => [e.id, e])); body = table([{ h: 'Time', v: e => fmtDT(e.created) }, { h: 'Type', v: e => `<span class="mono">${esc(e.type)}</span>` }, { h: 'Object', v: e => `<span class="mono">${esc(e.data.object.id || '')}</span>` }], evs, { empty: 'No events yet.', rowAttr: e => `class="click" data-act="showEvent" data-id="${e.id}"` }); }
  if (t === 'api') body = apiReference();
  return head('Integrate', 'Developers & API', `REST API at <span class="mono">${esc(location.origin)}/v1</span>. Use test keys while building; live keys after go-live.`)
    + tabs('dev', [['keys', 'API keys'], ['webhooks', 'Webhooks'], ['logs', 'Delivery logs'], ['events', 'Events'], ['api', 'API reference']], 'keys') + body;
};
const SCOPE_LABELS = { 'checkout:write': 'Create checkout sessions', 'payments:read': 'Read payments', 'payments:write': 'Capture / void', 'refunds:write': 'Refunds', 'balance:read': 'Wallet & payouts', 'links:write': 'Payment links', 'payouts:write': 'Request payouts', 'webhooks:write': 'Manage webhooks', 'events:read': 'Read events' };
ACT.newKey = () => formModal(`Create ${App.mode} secret key`, 'key', `${field('Name', input('name', { req: true, ph: 'WooCommerce store' }))}
  <label class="check"><input type="checkbox" name="full" checked> Full access</label><div class="field"><span>Or restrict to</span><div class="form-grid">${Object.entries(SCOPE_LABELS).map(([s, l]) => `<label class="check"><input type="checkbox" name="scopes" value="${s}" data-multi> ${esc(l)}</label>`).join('')}</div></div>
  ${field('IP allowlist (optional)', input('allowed_ips', { ph: '203.0.113.10, 198.51.100.7' }), 'Only these server IPs may use the key.')}`, 'Create key');
FORM.key = async f => { const r = await api('POST', '/m-api/keys', { name: f.name, scopes: f.full ? ['*'] : f.scopes, allowed_ips: f.allowed_ips }); closeModal(); await render(); secretModal('Your new secret key', `Store <b>${esc(r.key.name)}</b> in your server's secret manager or WooCommerce plugin settings.`, r.secret); };
ACT.rollKey = d => confirmBox('Roll this key?', 'A new key is issued now; the old one keeps working for 24 hours.', 'Roll key', async () => { const r = await api('POST', `/m-api/keys/${d.id}/roll`); setTimeout(() => secretModal('Rolled key', 'Replace the old key within 24 hours.', r.secret), 60); }, false);
ACT.revokeKey = d => confirmBox('Revoke key?', 'Requests using this key fail immediately. This cannot be undone.', 'Revoke', () => api('POST', `/m-api/keys/${d.id}/revoke`));
ACT.newEndpoint = () => formModal(`Add ${App.mode} webhook endpoint`, 'endpoint', `${field('Endpoint URL', input('url', { type: 'url', req: true, ph: 'https://yourshop.com/wc-api/digitalhub/' }), 'HTTPS required in production.')}
  <label class="check"><input type="checkbox" name="all" checked> All events</label><div class="form-grid">${(App.cache.eventTypes || []).map(e => `<label class="check"><input type="checkbox" name="events" value="${e}" data-multi> <span class="mono" style="font-size:.78rem">${e}</span></label>`).join('')}</div>`, 'Add endpoint', { wide: true });
FORM.endpoint = async f => { const r = await api('POST', '/m-api/webhooks', { url: f.url, events: f.all ? ['*'] : f.events }); closeModal(); await render(); secretModal('Signing secret', 'Paste this into the WooCommerce plugin (or your server) to verify the DigitalHub-Signature header.', r.secret); };
ACT.revealSecret = d => run(async () => { const r = await api('POST', `/m-api/webhooks/${d.id}/secret`); openModal({ title: 'Signing secret', body: `<div class="secret">${esc(r.secret)}</div>`, foot: `<button class="btn" data-act="rotateSecret" data-id="${d.id}">Rotate</button><button class="btn primary" data-act="copy" data-text="${esc(r.secret)}">Copy</button>` }); }, { noRefresh: true });
ACT.rotateSecret = d => run(async () => { const r = await api('POST', `/m-api/webhooks/${d.id}/rotate`); secretModal('New signing secret', 'The previous secret stops working now.', r.secret); }, { noRefresh: true });
ACT.toggleEndpoint = d => run(() => api('POST', `/m-api/webhooks/${d.id}/status`, { enabled: !!d.enabled }));
ACT.testEndpoint = d => run(() => api('POST', `/m-api/webhooks/${d.id}/test`), { ok: 'Test event queued — see Delivery logs' });
ACT.deleteEndpoint = d => confirmBox('Delete endpoint?', 'Events stop being sent to this URL.', 'Delete', () => api('DELETE', '/m-api/webhooks/' + d.id));
ACT.retryDelivery = d => run(() => api('POST', `/m-api/deliveries/${d.id}/retry`), { ok: 'Retry queued' });
ACT.showEvent = d => openModal({ title: App.cache.events[d.id].type, wide: true, body: `<pre class="code">${esc(JSON.stringify(App.cache.events[d.id], null, 2))}</pre>` });
function apiReference() {
  const E = [['POST', '/v1/checkout/sessions', 'Create a hosted Cash App Pay checkout (amount in cents, currency USD, description, success_url, cancel_url, metadata)'], ['GET', '/v1/checkout/sessions/{id}', 'Retrieve a session (also with the publishable key)'],
    ['GET', '/v1/payments', 'List payments'], ['GET', '/v1/payments/{id}', 'Retrieve a payment, including its Cash App IDs'], ['POST', '/v1/payments/{id}/capture', 'Capture an authorized payment (manual capture mode)'], ['POST', '/v1/payments/{id}/cancel', 'Void an authorization'],
    ['POST', '/v1/refunds', 'Refund all or part of a payment through Cash App (payment, amount, reason)'], ['GET', '/v1/refunds', 'List refunds'], ['GET', '/v1/balance', 'Wallet balances: pending, available, reserve, hold'],
    ['POST', '/v1/payment_links', 'Create a payment link'], ['GET', '/v1/payment_links', 'List links'], ['GET', '/v1/payouts', 'List payouts'], ['POST', '/v1/payouts', 'Request a payout to a verified bank account'],
    ['GET', '/v1/events', 'List events'], ['POST', '/v1/webhook_endpoints', 'Create an endpoint — returns the signing secret once'], ['GET', '/v1/account', 'Account and available payment methods']];
  return `<div class="card stack"><h2>Conventions</h2>${kv([['Base URL', `<span class="mono">${esc(location.origin)}/v1</span>`], ['Auth', '<span class="mono">Authorization: Bearer dh_test_sk_…</span>'], ['Amounts', 'Integers in cents (2500 = $25.00); USD only'], ['Idempotency', '<span class="mono">Idempotency-Key</span> header on every POST'], ['Errors', '<span class="mono">{"error":{"type","code","message"}}</span>']])}</div>`
    + table([{ h: 'Method', v: e => `<span class="tag">${e[0]}</span>` }, { h: 'Path', v: e => `<span class="mono">${esc(e[1])}</span>` }, { h: 'Description', v: e => esc(e[2]) }], E);
}

/* ---------------- WooCommerce & plugins ---------------- */
const SNIP = {
  curl: o => `curl ${o}/v1/checkout/sessions \\\n  -H "Authorization: Bearer $DH_SECRET_KEY" \\\n  -H "Idempotency-Key: order_1001" \\\n  -d amount=2500 -d currency=USD \\\n  -d description="Order #1001" \\\n  -d "metadata[order_id]=1001" \\\n  -d success_url=https://yourshop.com/thanks \\\n  -d cancel_url=https://yourshop.com/cart`,
  node: o => `const DigitalHub = require('./digitalhub');\nconst dh = new DigitalHub(process.env.DH_SECRET_KEY, { baseUrl: '${o}' });\nconst session = await dh.checkout.create({\n  amount: 2500, currency: 'USD', description: 'Order #1001',\n  metadata: { order_id: '1001' },\n  success_url: 'https://yourshop.com/thanks', cancel_url: 'https://yourshop.com/cart',\n}, { idempotencyKey: 'order_1001' });\nres.redirect(session.url);`,
  verifyPhp: () => `$raw = file_get_contents('php://input');\nparse_str(str_replace(',', '&', $_SERVER['HTTP_DIGITALHUB_SIGNATURE'] ?? ''), $sig);\n$expected = hash_hmac('sha256', $sig['t'] . '.' . $raw, getenv('DH_WEBHOOK_SECRET'));\nif (!hash_equals($expected, $sig['v1'] ?? '') || abs(time() - (int)$sig['t']) > 300) {\n  http_response_code(400); exit;\n}\n$event = json_decode($raw, true); // dedupe by $event['id']`,
};
VIEWS.integrations = async () => {
  const o = location.origin, lang = tab('lang', 'curl');
  return head('Integrate', 'WooCommerce & plugins', 'Connect your WooCommerce store to your Digital Hub Wallet. Customers pay with Cash App Pay; orders update automatically after Cash App confirms the payment.')
    + `<div class="grid g2"><div class="card integration"><div class="row"><span class="logo">W</span><h2>WordPress · WooCommerce</h2></div>
      <ol class="stepper"><li>Download the plugin and upload it in <b>Plugins → Add New → Upload</b>, then activate it.</li><li>Open <b>WooCommerce → Settings → Payments → Cash App Pay (Digital Hub)</b>.</li>
        <li>Paste your Digital Hub URL <span class="mono">${esc(o)}</span> and your <b>secret key</b> (Developers → API keys). Test keys first.</li>
        <li>In Developers → Webhooks, add <span class="mono">https://YOUR-SHOP/wc-api/digitalhub/</span> and paste its signing secret into the plugin.</li>
        <li>Place a test order. The order is marked paid only after the signed webhook confirms Cash App captured the payment.</li></ol>
      <div class="row"><a class="btn primary" href="/downloads/digitalhub-woocommerce.zip">Download plugin (.zip)</a><a class="btn" href="#/developers">Get API key</a></div></div>
    <div class="card integration"><div class="row"><span class="logo">&lt;/&gt;</span><h2>Any website · pay button</h2></div><div class="muted">Create a payment link, then paste this anywhere.<pre class="code" style="margin-top:8px">${esc(`<a href="${o}/l/YOUR_LINK" class="dh-pay-button">Pay with Cash App Pay</a>\n<script src="${o}/js/digitalhub.js" async></script>`)}</pre></div>
      <div class="row"><a class="btn" href="#/links">Payment links</a><a class="btn" href="/downloads/digitalhub-node-sdk.zip">Node.js SDK (.zip)</a></div></div></div>
    <div class="card"><div class="card-head"><h2>Code samples</h2></div><div class="code-tabs">${[['curl', 'Create session · cURL'], ['node', 'Create session · Node.js'], ['verifyPhp', 'Verify webhook · PHP']].map(([k, l]) => `<button data-act="tab" data-group="lang" data-tab="${k}" aria-selected="${lang === k}">${l}</button>`).join('')}</div><pre class="code">${esc(SNIP[lang](o))}</pre></div>
    ${note('info', 'Sandbox', 'In test mode, checkout runs against the Cash App sandbox (or the local simulator until sandbox credentials are set). Sandbox amount $77.71 is declined (insufficient funds).')}`;
};

/* ---------------- go live ---------------- */
VIEWS.golive = async () => {
  const d = await api('GET', '/m-api/onboarding'), done = d.steps.filter(s => s.done).length, k = d.kyb, b = k.business || {};
  const ownersRows = (k.owners.length ? k.owners : [{}]).map((o, i) => ownerRow(o, i)).join('');
  return head('Business', 'Go live', 'Verify your business, register with Cash App Pay and pass the checklist. Live Cash App payments also need Digital Hub\'s production approval from Cash App.')
    + `<div class="split"><div class="card"><div class="card-head"><h2>Checklist</h2>${badge(done === d.steps.length ? 'done' : 'pending', `${done}/${d.steps.length}`)}</div><div class="progress" style="margin-bottom:12px"><div style="width:${Math.round(done / d.steps.length * 100)}%"></div></div>
      <ol class="onb">${d.steps.map((s, i) => `<li><span class="n ${s.done ? 'done' : ''}">${s.done ? '✓' : i + 1}</span><div><b>${esc(s.label)}</b><div class="muted" style="font-size:.82rem">${esc(s.detail)}</div></div>${badge(s.done ? 'done' : 'pending', s.done ? 'done' : 'to do')}</li>`).join('')}</ol></div>
      <div class="card stack"><h2>Status</h2>${kv([['Verification', badge(d.status)], ['Cash App sandbox', caStatus(d.cashapp.test.status)], ['Cash App production', caStatus(d.cashapp.live.status)], ['Live payments', d.live_ready ? badge('pending', 'not active') : badge('active')], ['Why', esc(d.live_ready || 'Ready')]])}
        ${note('warn', 'Real money', 'Cash App Pay supports US businesses and USD. Live payments need Digital Hub\'s approved Cash App partner credentials, your registration with Cash App production, and Digital Hub activation.')}</div></div>
    <form class="card stack" data-form="kyb"><div class="card-head" style="margin:0"><h2>Business verification (KYB)</h2>${badge(k.submitted ? (d.status === 'approved' ? 'approved' : 'submitted') : 'pending', k.submitted ? (d.status === 'approved' ? 'verified' : 'under review') : 'not submitted')}</div>
      <div class="form-grid">${field('Legal entity name', input('legal_name', { req: true, value: b.legal_name || M().legal_name }))}${field('Registration number / EIN', input('registration_number', { req: true, value: b.registration_number || '' }))}
      ${field('Country of incorporation', select('country', Object.entries(COUNTRIES), b.incorporation_country || M().country))}${field('Website', input('website', { value: b.website || M().website || '' }))}
      <label class="field full"><span>Registered address</span>${input('address', { req: true, value: b.address || '' })}</label>
      <label class="field full"><span>What do you sell?</span><textarea name="description" required>${esc(b.description || '')}</textarea></label>${field('Expected monthly volume (USD)', input('monthly_volume_usd', { type: 'number', value: b.monthly_volume_usd || '' }))}</div>
      <h3>Beneficial owners (25%+)</h3><div class="stack" id="owners">${ownersRows}</div><div><button type="button" class="btn sm ghost" data-act="addOwnerRow">Add owner</button></div>
      <p class="faint">Digital Hub will request ID documents for each owner by email. Do not upload documents here.</p><div class="err" id="formErr"></div>
      <div><button class="btn primary" type="submit" ${d.status === 'approved' ? 'disabled' : ''}>${k.submitted ? 'Update submission' : 'Submit for review'}</button></div></form>`;
};
const ownerRow = (o, i) => `<div class="form-grid" data-owner="${i}" style="grid-template-columns:2fr 1fr 1fr 1fr">${field('Full name', `<input type="text" data-o="name" value="${esc(o.name || '')}">`)}${field('Ownership %', `<input type="number" data-o="pct" min="0" max="100" value="${esc(o.pct ?? '')}">`)}${field('Date of birth', `<input type="date" data-o="dob" value="${esc(o.dob || '')}">`)}${field('Nationality', `<input type="text" data-o="nationality" maxlength="2" placeholder="US" value="${esc(o.nationality || '')}">`)}</div>`;
ACT.addOwnerRow = () => { const box = $('#owners'); box.insertAdjacentHTML('beforeend', ownerRow({}, box.children.length)); };
FORM.kyb = async (f, form) => { f.owners = $$('[data-owner]', form).map(r => Object.fromEntries($$('[data-o]', r).map(i => [i.dataset.o, i.value]))).filter(o => o.name); await api('POST', '/m-api/kyb', f); toast('Submitted. Digital Hub compliance will review it.'); await loadMe(); };

/* ---------------- settings (incl. Cash App Pay) ---------------- */
VIEWS.settings = async () => {
  const t = tab('set', 'cashapp'), m = M(); let body = '';
  if (t === 'cashapp') {
    const d = await api('GET', '/m-api/cashapp'), a = d.details?.address || {};
    const envCard = (mode, s) => `<div class="card stack"><div class="card-head" style="margin:0"><h2>${mode === 'test' ? 'Sandbox' : 'Production'}</h2>${caStatus(s.status)}</div>
      ${kv([['Environment', esc(s.environment)], ['Platform credentials', badge(s.credentials === 'missing' ? 'pending' : 'active', s.credentials)], ['Cash App brand', `<span class="mono">${esc(s.brand_id || '—')}</span>`], ['Cash App merchant', `<span class="mono">${esc(s.merchant_id || '—')}</span>`], ['Registered', fmtDT(s.registered_at)], s.error && ['Last error', `<span class="err">${esc(s.error)}</span>`]])}
      ${mode === 'test' ? `<button class="btn ${s.ready ? '' : 'primary'}" data-act="cashappRegister">${s.merchant_id ? 'Refresh status from Cash App' : 'Register with Cash App sandbox'}</button>` : '<p class="faint">Digital Hub registers you with Cash App production after your business is verified.</p>'}</div>`;
    body = note('info', 'How it works', 'Digital Hub is your Cash App Pay partner. Its Cash App API credentials stay on Digital Hub\'s servers; your business is registered with Cash App as a merchant under Digital Hub, and every confirmed payment lands in your Digital Hub Wallet.')
      + `<div class="grid g2">${envCard('test', d.test)}${envCard('live', d.live)}</div>
      <form class="card stack" data-form="cashappDetails"><div class="card-head" style="margin:0"><h2>Business details for Cash App</h2><button class="btn primary" type="submit">Save details</button></div>
        <p class="muted">Cash App Pay merchants must be US businesses. These details are sent to Cash App when you register.</p>
        <div class="form-grid"><label class="field full"><span>Street address</span>${input('address_line_1', { req: true, value: a.address_line_1 || '' })}</label>${field('Suite / unit', input('address_line_2', { value: a.address_line_2 || '' }))}${field('City', input('locality', { req: true, value: a.locality || '' }))}
        ${field('State (2 letters)', input('administrative_district_level_1', { req: true, value: a.administrative_district_level_1 || '', extra: 'maxlength="2"' }))}${field('ZIP code', input('postal_code', { req: true, value: a.postal_code || '' }))}
        ${field('Merchant category code (MCC)', input('category', { req: true, value: d.details?.category || m.mcc || '', extra: 'maxlength="4" inputmode="numeric"' }), '4 digits, e.g. 5651 clothing, 5812 restaurants, 5999 misc. retail.')}${field('Store website', input('site_url', { type: 'url', value: d.details?.site_url || '' }))}</div><div class="err" id="formErr"></div></form>
      <div class="card"><div class="card-head"><h2>Cash App API log · ${App.mode}</h2><span class="faint">calls Digital Hub made for your account</span></div>${table([{ h: 'Time', v: l => fmtDT(l.created_at) }, { h: 'Operation', v: l => esc((l.op || '').replace(/_/g, ' ')) }, { h: 'Call', v: l => `<span class="mono">${esc(l.method)} ${esc(l.path)}</span>` }, { h: 'HTTP', r: 1, v: l => l.http ?? '—' }, { h: 'ms', r: 1, v: l => l.ms }, { h: 'Result', v: l => badge(l.status) + (l.error ? ` <span class="faint">${esc(l.error)}</span>` : '') }], d.logs, { empty: App.mode === 'test' && d.test.credentials === 'simulator' ? 'The local simulator does not make Cash App API calls.' : 'No Cash App calls yet.' })}</div>`;
  }
  if (t === 'profile') body = `<form class="card stack" data-form="settings"><h2>Public profile</h2><div class="form-grid">${field('Display name (shown at checkout)', input('name', { value: m.name, req: true }))}${field('Support email', input('support_email', { type: 'email', value: m.support_email || '' }))}${field('Website', input('website', { value: m.website || '' }))}${field('Minimum payout (cents)', input('minPayout', { type: 'number', value: m.minPayout }))}</div>
    <div class="form-grid">${field('Capture', select('captureMode', [['auto', 'Automatic: capture when the customer approves'], ['manual', 'Manual: authorize now, capture later']], m.captureMode))}</div>
    <label class="check"><input type="checkbox" name="dualControl" ${m.dualControl ? 'checked' : ''}> Dual control: every payout needs Digital Hub review</label><div class="err" id="formErr"></div><div><button class="btn primary" type="submit">Save</button></div></form>`;
  if (t === 'team') {
    const d = await api('GET', '/m-api/team');
    body = `<div class="card"><div class="card-head"><h2>Team</h2>${can('team') ? '<button class="btn primary" data-act="inviteMember">Add member</button>' : ''}</div>${table([{ h: 'Name', v: u => `${esc(u.name)}<div class="faint" style="font-size:.75rem">${esc(u.email)}</div>` }, { h: 'Role', v: u => esc(d.roles[u.role]?.label || u.role) }, { h: '2FA', v: u => badge(u.mfa_enabled ? 'enabled' : 'pending', u.mfa_enabled ? 'on' : 'off') }, { h: 'Status', v: u => badge(u.status) }, { h: 'Last sign-in', v: u => fmtDT(u.last_login) }, { h: '', v: u => u.role !== 'owner' && u.status === 'active' && can('team') ? `<button class="btn sm ghost" data-act="removeMember" data-id="${u.id}">Remove</button>` : '' }], d.users)}</div>`;
  }
  return head('Business', 'Settings') + tabs('set', [['cashapp', 'Cash App Pay'], ['profile', 'Profile & payments'], ['team', 'Team']], 'cashapp') + body;
};
FORM.cashappDetails = async f => { await api('POST', '/m-api/cashapp/details', { address: { address_line_1: f.address_line_1, address_line_2: f.address_line_2, locality: f.locality, administrative_district_level_1: f.administrative_district_level_1, postal_code: f.postal_code }, category: f.category, site_url: f.site_url }); toast('Details saved'); await loadMe(); };
ACT.cashappRegister = () => run(() => api('POST', '/m-api/cashapp/register'), { ok: 'Cash App sandbox registration updated' });
FORM.settings = async f => { await api('PATCH', '/m-api/settings', { ...f, minPayout: +f.minPayout }); toast('Saved'); await loadMe(); };
ACT.inviteMember = () => formModal('Add team member', 'invite', `${field('Name', input('name', { req: true }))}${field('Email', input('email', { type: 'email', req: true }))}${field('Role', select('role', [['admin', 'Admin'], ['finance', 'Finance'], ['developer', 'Developer'], ['support', 'Support'], ['viewer', 'Viewer']]))}`, 'Add member');
FORM.invite = async f => { const r = await api('POST', '/m-api/team', f); closeModal(); await render(); secretModal('Temporary password', `Share this with <b>${esc(r.user.email)}</b> securely. They should change it and enable 2FA on first sign-in.`, r.temporary_password); };
ACT.removeMember = d => confirmBox('Remove member?', 'They lose access immediately.', 'Remove', () => api('DELETE', '/m-api/team/' + d.id));
