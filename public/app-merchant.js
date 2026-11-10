'use strict';
/* Merchant dashboard views — MetaMask USDC on Base (non-custodial: customers pay straight into the merchant's verified wallet). */
NAV.merchant = [
  ['Payments', [['home', 'Home'], ['payments', 'Transactions'], ['links', 'Payment links'], ['refunds', 'Refunds']]],
  ['Money', [['wallet', 'Receiving wallet'], ['balances', 'Balances & fees']]],
  ['Integrate', [['developers', 'Developers & API'], ['integrations', 'Plugins & integrations']]],
  ['Business', [['golive', 'Go live'], ['settings', 'Settings & team']]],
];
const M = () => App.me.merchant;
const liveBlocked = d => App.mode === 'live' && d ? note('warn', 'Live mode not active', esc(d) + ' You can keep working in test mode (Base Sepolia).') : '';
function statusBanner() {
  const m = M();
  if (m.status === 'suspended') return note('danger', 'Account suspended', 'New payments are blocked. Contact Digital Hub support.');
  if (m.status === 'rejected') return note('danger', 'Verification rejected', 'Update your business details under Go live and resubmit.');
  if (m.status === 'pending') return note('info', 'Test mode only', `Business verification is ${m.kyb.submitted ? 'under review' : 'not submitted yet'}. <a href="#/golive">Go live →</a>`);
  return '';
}
const walletBanner = () => !(M().receiving || {})[App.mode] ? note('warn', 'No receiving wallet', `Customers cannot pay you on ${App.mode === 'test' ? 'Base Sepolia' : 'Base'} until you verify a receiving wallet with MetaMask. <a href="#/wallet">Set up receiving wallet →</a>`) : '';
const netName = n => ({ base_sepolia: 'Base Sepolia', base: 'Base' }[n] || n || '');
const units = (u, cur = 'USDC') => u == null ? '—' : `${DHMetaMask.formatUnits(u)} ${cur}`;
const txLink = (net, h) => h ? `<a class="mono" href="${esc(EXPLORER[net] + '/tx/' + h)}" target="_blank" rel="noopener">${esc(short(h, 10, 6))}</a>` : '—';
const addrLink = (net, a) => a ? `<a class="mono" href="${esc(EXPLORER[net] + '/address/' + a)}" target="_blank" rel="noopener">${esc(short(a, 8, 6))}</a>` : '—';
const payCols = [
  { h: 'Date', v: p => `<span class="num">${fmtDT(p.created)}</span>` },
  { h: 'Payment', v: p => `<span class="mono">${esc(short(p.id, 8, 4))}</span>` },
  { h: 'Customer', v: p => `${esc(p.customer?.email || '—')}<div class="faint mono" style="font-size:.72rem">${esc(short(p.crypto?.payer || '', 8, 6))}</div>` },
  { h: 'Method', v: p => p.method === 'usdc' ? `USDC · ${esc(netName(p.crypto.network))}` : p.card ? `${esc(p.card.brand)} ••${esc(p.card.last4)}` : p.crypto ? `${p.crypto.asset} · ${esc(p.crypto.network)}` : esc(p.method) },
  { h: 'Amount', r: 1, v: p => fmt(p.amount, p.method === 'usdc' ? 'USDC' : p.currency) },
  { h: 'Conf.', r: 1, v: p => p.crypto ? `${p.crypto.confirmations}/${p.crypto.confirmations_required}` : '—' },
  { h: 'Status', v: p => badge(p.status) },
];
const payRow = p => `class="click" tabindex="0" data-act="openPayment" data-id="${p.id}"`;

/* ---------------- shared MetaMask helper for dashboard transfers (refunds, fee settlements) ---------------- */
async function mmTransfer({ chain, from, to: token, data }) {
  const w = await DHMetaMask.connect(chain);
  if (from && !DHMetaMask.same(w.account, from)) throw new Error(`MetaMask is on ${short(w.account, 8, 6)}. Switch MetaMask to ${short(from, 8, 6)} (your receiving wallet) and try again.`);
  await DHMetaMask.ensureChain(w.provider, chain);
  return DHMetaMask.sendTransfer(w.provider, { from: w.account, to: token, data });
}
const mmErr = e => typeof e?.code === 'number' ? DHMetaMask.message(e) : e?.message || DHMetaMask.message(e);

/* ---------------- home ---------------- */
VIEWS.home = async () => {
  const d = await api('GET', '/m-api/overview'), m = M(), done = d.onboarding.filter(s => s.done).length, x = d.direct;
  return head('Dashboard', m.name, `${App.mode === 'test' ? 'Base Sepolia test data' : 'Base mainnet'} · last 30 days`, `${liveIf(d.in_flight > 0, 8000)}<button class="btn" data-act="newLink">New payment link</button><a class="btn primary" href="#/wallet">Receiving wallet</a>`)
    + statusBanner() + liveBlocked(d.live_ready) + walletBanner()
    + `<div class="grid g4">
      <div class="card kpi"><div class="label">Received in your wallet</div><div class="value">${fmt(x.received, 'USDC')}</div><div class="sub">verified on-chain, net of refunds</div></div>
      <div class="card kpi"><div class="label">Paid invoices</div><div class="value">${d.count}</div><div class="sub">${d.in_flight} in flight · ${d.attempts} attempts</div></div>
      <div class="card kpi"><div class="label">Refunded</div><div class="value">${fmt(x.refunded, 'USDC')}</div><div class="sub">${x.owed_to_customers ? fmt(x.owed_to_customers, 'USDC') + ' overpayment owed back' : 'sent from your wallet'}</div></div>
      <div class="card kpi"><div class="label">Digital Hub fees due</div><div class="value">${fmt(x.fees_due, 'USDC')}</div><div class="sub"><a href="#/balances">Fee statements →</a></div></div></div>
    <div class="split"><div class="card"><div class="card-head"><h2>Daily volume</h2><span class="faint">14 days · USDC</span></div>${barChart(d.series)}</div>
      <div class="card"><div class="card-head"><h2>Go-live progress</h2>${badge(done === d.onboarding.length ? 'done' : 'pending', `${done}/${d.onboarding.length}`)}</div><div class="progress" style="margin-bottom:10px"><div style="width:${Math.round(done / d.onboarding.length * 100)}%"></div></div>
        <div class="stack" style="gap:6px">${d.onboarding.filter(s => !s.done).slice(0, 4).map(s => `<div class="row" style="justify-content:space-between"><span>${esc(s.label)}</span>${badge('pending', 'to do')}</div>`).join('') || '<p class="muted">All steps complete.</p>'}</div><a href="#/golive" style="margin-top:10px;display:inline-block">Open go-live checklist →</a>
        ${d.wallet ? `<div class="divider" style="margin:12px 0"></div><h3>Receiving wallet</h3><div class="row" style="justify-content:space-between;margin-top:6px">${addrLink(App.mode === 'test' ? 'base_sepolia' : 'base', d.wallet.address)}${badge(d.wallet.status)}</div>` : ''}
        ${d.attention.length ? `<div class="divider" style="margin:12px 0"></div><h3>Needs attention</h3><div class="stack" style="margin-top:8px">${d.attention.slice(0, 5).map(a => `<button class="btn ghost" style="justify-content:space-between" data-act="openPayment" data-id="${a.payment}"><span>${esc(a.status.replace(/_/g, ' '))}</span><span class="num">${fmt(a.amount, 'USDC')}</span></button>`).join('')}</div>` : ''}</div></div>
    <div class="card"><div class="card-head"><h2>Recent payments</h2><a href="#/payments">All transactions →</a></div>${table(payCols, d.recent, { rowAttr: payRow, empty: App.mode === 'test' ? 'No test payments yet. Verify your receiving wallet, then open a payment link and pay with Base Sepolia test USDC from MetaMask.' : 'No live payments yet.' })}</div>`;
};

/* ---------------- payments ---------------- */
VIEWS.payments = async () => {
  const f = App.filters.pay ||= { q: '', status: '', offset: 0 };
  const d = await api('GET', '/m-api/payments' + qs(f));
  return head('Payments', 'Transactions', 'Every USDC payment with the payer wallet, on-chain transactions, confirmations, fees and ledger entries.', liveIf(d.data.some(p => ['awaiting_payment', 'confirming'].includes(p.status))))
    + `<div class="card"><div class="grid g3">${fInput('pay', 'q', 'Search', 'ID, email, wallet, order ID')}${fSelect('pay', 'status', 'Status', [['', 'All statuses'], ...['awaiting_payment', 'confirming', 'confirmed', 'underpaid', 'overpaid', 'expired', 'canceled', 'partially_refunded', 'refunded'].map(s => [s, s.replace(/_/g, ' ')])])}</div></div>`
    + table(payCols, d.data, { rowAttr: payRow, empty: 'No payments match.' })
    + `<div class="pager"><span class="faint">${d.total} payments</span><div class="row">${f.offset > 0 ? '<button class="btn sm" data-act="page" data-bag="pay" data-dir="-1">Previous</button>' : ''}${f.offset + 50 < d.total ? '<button class="btn sm" data-act="page" data-bag="pay" data-dir="1">Next</button>' : ''}</div></div>`;
};
ACT.page = d => { const f = App.filters[d.bag]; f.offset = Math.max(0, (f.offset || 0) + 50 * d.dir); render(); };
function paymentBody(d, admin) {
  const p = d.payment, c = d.crypto, cur = p.method === 'usdc' ? 'USDC' : p.crypto ? p.crypto.asset : p.currency;
  let b = `<div class="row" style="justify-content:space-between"><div><div class="co-amt" style="font-size:1.5rem">${fmt(p.amount, cur)}</div><div class="muted">${esc(p.description)}</div></div>${badge(p.status)}</div>`;
  b += kv([['Payment ID', `<span class="mono">${esc(p.id)}</span> <button class="btn sm ghost" data-act="copy" data-text="${esc(p.id)}">Copy</button>`], admin && ['Merchant', esc(d.merchant?.name)], ['Mode', badge(p.livemode ? 'live' : 'test')],
    ['Customer', `${esc(p.customer?.email || '—')}`], ['Created', fmtDT(p.created)], ['Invoice', `<span class="mono">${esc(short(p.checkout_session, 10, 6))}</span>`],
    Object.keys(p.metadata || {}).length && ['Metadata', `<span class="mono">${esc(JSON.stringify(p.metadata))}</span>`]]);
  if (p.method === 'usdc' && c) {
    b += `<h3>On-chain (${esc(netName(c.network))}, chain ${c.chain_id})</h3>` + kv([['Payer wallet', addrLink(c.network, c.payer) + ' <span class="tag">signature verified</span>'], ['Merchant wallet', addrLink(c.network, c.recipient)], ['USDC contract', addrLink(c.network, c.token)],
      ['Expected', units(c.amountUnits)], ['Received (final)', units(c.receivedUnits)], ['Confirmations', `${c.confirmations}/${c.required} · finality: ${esc(c.finality)}`], ['Invoice anchored at block', `${c.startBlock}`], c.excess && ['Owed back to customer', fmt(c.excess, 'USDC')],
      ['Payment window', `until ${fmtDT(c.expiresAt)}`]]);
    b += table([{ h: 'Transaction', v: t => txLink(c.network, t.hash) + `<div class="faint" style="font-size:.72rem">${esc(t.source || '')}</div>` }, { h: 'Block', r: 1, v: t => t.blockNumber || '—' }, { h: 'Amount', r: 1, v: t => t.valueUnits ? units(t.valueUnits) : '—' }, { h: 'Conf.', r: 1, v: t => t.confirmations ?? 0 }, { h: 'Status', v: t => badge(t.status) + (t.reason ? `<div class="faint" style="font-size:.72rem;max-width:260px">${esc(t.reason)}</div>` : '') }], c.txs, { empty: 'No transaction yet — the customer has not sent USDC.' });
  } else if (c) b += `<h3>Stablecoin (legacy)</h3>` + kv([['Provider', esc(c.provider)], ['Asset · network', `${c.asset} · ${esc(c.network)}`], ['Amount due', fmt(c.quoteAmount, c.asset)], ['Received', fmt(c.received, c.asset)]]);
  b += `<h3>Amounts</h3>` + kv([['Invoice', fmt(p.amount, cur)], p.fees && ['Digital Hub fee (billed separately)', fmt(p.fees.platform, cur)], p.amount_refunded && ['Refunded', '−' + fmt(p.amount_refunded, cur)]]);
  if (d.refunds?.length) b += `<h3>Refunds</h3>` + table([{ h: 'Date', v: r => fmtDT(r.created ?? r.created_at) }, { h: 'Amount', r: 1, v: r => fmt(r.amount, r.currency) }, { h: 'To', v: r => r.to ? `<span class="mono">${esc(short(r.to, 8, 6))}</span>` : '—' }, { h: 'Tx', v: r => r.tx_hash ? txLink(r.network, r.tx_hash) : '—' }, { h: 'Status', v: r => badge(r.status) }], d.refunds);
  b += `<h3>Timeline</h3><ul class="timeline">${[...d.events].reverse().map(e => `<li><div><b>${esc(e.status.replace(/_/g, ' '))}</b> <span class="t">${fmtDT(e.at)}</span><div class="muted" style="font-size:.84rem;overflow-wrap:anywhere">${esc(e.note || '')}</div></div></li>`).join('')}</ul>`;
  b += `<h3>Ledger <span class="faint" style="font-weight:500">(debit +, credit −)</span></h3>` + table([{ h: 'Journal', v: e => `<span class="mono">${esc(e.journal_key.split(':').slice(1).join(':').slice(0, 24))}</span>` }, { h: 'Account', v: e => esc(e.account) }, { h: 'Amount', r: 1, v: e => fmt(e.amount, e.currency) }], d.ledger, { empty: 'Nothing is booked until the transfer is final on-chain.' });
  if (d.webhooks?.length) b += `<h3>Events</h3>` + table([{ h: 'Event', v: e => `<span class="mono">${esc(e.type)}</span>` }, { h: 'Time', v: e => fmtDT(e.created) }], d.webhooks);
  return b;
}
ACT.openPayment = d => openDrawer(async () => {
  const x = await api('GET', '/m-api/payments/' + d.id), p = x.payment, B = (act, l, c = '') => `<button class="btn ${c}" data-act="${act}" data-id="${p.id}">${l}</button>`;
  let foot = '';
  if (p.method === 'usdc' && ['awaiting_payment', 'confirming', 'underpaid'].includes(p.status)) foot += B('checkPayment', 'Re-check on-chain');
  if (x.refundable > 0 && can('refunds')) foot += B('refundPayment', 'Refund');
  if (p.status === 'underpaid' && can('payments')) foot += B('acceptPartial', 'Accept partial', 'primary');
  App.cache.payment = x;
  return { title: 'Payment', body: paymentBody(x, false), foot };
});
ACT.checkPayment = d => run(() => api('POST', `/m-api/payments/${d.id}/check`), { ok: 'Checked against the chain' });
ACT.acceptPartial = d => confirmBox('Accept partial payment?', 'Mark the invoice paid at the amount actually received on-chain. Your store will be told it is paid.', 'Accept', () => api('POST', `/m-api/payments/${d.id}/accept-partial`), false);
ACT.refundPayment = d => {
  const x = App.cache.payment, p = x.payment;
  formModal('Refund in USDC', 'refund', note('info', 'Non-custodial', 'Digital Hub never holds your funds. This creates a refund request; you then send the USDC from your receiving wallet with MetaMask. The refund completes when that transfer is verified on-chain.')
    + field('Amount (USDC)', input('amount', { type: 'number', value: (x.refundable / 100).toFixed(2), req: true, extra: `step="0.01" min="0.01" max="${(x.refundable / 100).toFixed(2)}"` }), `Up to ${fmt(x.refundable, 'USDC')}.`)
    + field('Send to (customer wallet)', input('address', { value: p.crypto?.payer || '', req: true, extra: 'spellcheck="false" autocomplete="off"' }), 'Defaults to the wallet that paid. Change it only if the customer asks in writing.')
    + field('Reason', select('reason', ['requested_by_customer', 'duplicate', 'fraudulent', 'item_returned', 'overpayment'])), 'Create refund', { data: { id: p.id, idem: 'idem_' + uid() } });
};
FORM.refund = async (f, form) => { const r = await api('POST', `/m-api/payments/${form.dataset.id}/refund`, { ...f, amount: toMinor(f.amount), idempotency_key: form.dataset.idem }); closeModal(); toast('Refund created — send it with MetaMask'); closeDrawer(); location.hash = '#/refunds'; setTimeout(() => ACT.openRefund({ id: r.id }), 200); };

/* ---------------- refunds ---------------- */
VIEWS.refunds = async () => {
  const rs = await api('GET', '/m-api/refunds');
  return head('Payments', 'Refunds', 'Refunds go from your receiving wallet straight back to the customer. Each one is verified on-chain before your store and the ledger are updated.', liveIf(rs.some(r => r.status === 'pending')))
    + note('info', 'How it works', '1 · Create the refund from a payment (or your store / the API). 2 · Click <b>Send with MetaMask</b> — MetaMask asks you to approve a plain USDC transfer. 3 · Digital Hub verifies the transfer and confirmations, then sends <span class="mono">payment.refunded</span> to WooCommerce.')
    + table([{ h: 'Created', v: r => fmtDT(r.created) }, { h: 'Refund', v: r => `<span class="mono">${esc(short(r.id, 8, 4))}</span>` }, { h: 'Payment', v: r => `<span class="mono">${esc(short(r.payment, 8, 4))}</span>` }, { h: 'Amount', r: 1, v: r => fmt(r.amount, r.currency) }, { h: 'To', v: r => r.to ? `<span class="mono">${esc(short(r.to, 8, 6))}</span>` : '—' }, { h: 'Tx', v: r => r.tx_hash ? txLink(r.network, r.tx_hash) : '—' }, { h: 'Status', v: r => badge(r.status) }],
      rs, { rowAttr: r => `class="click" data-act="openRefund" data-id="${r.id}"`, empty: 'No refunds.' });
};
ACT.openRefund = d => { App.cache.refundId = d.id; openDrawer(refundDrawer); };
async function refundDrawer() {
  const r = await api('GET', '/m-api/refunds/' + App.cache.refundId), net = r.network;
  let b = `<div class="row" style="justify-content:space-between"><div class="co-amt" style="font-size:1.5rem">${fmt(r.amount, 'USDC')}</div>${badge(r.status)}</div>`
    + kv([['Refund', `<span class="mono">${esc(r.id)}</span>`], ['Payment', `<span class="mono">${esc(r.payment)}</span>`], ['From (your wallet)', addrLink(net, r.from)], ['To (customer)', addrLink(net, r.to)], ['Network', esc(netName(net))], ['Reason', esc(r.reason)], r.tx_hash && ['Transaction', txLink(net, r.tx_hash) + (r.confirmations != null ? ` · ${r.confirmations} conf.` : '')]]);
  if (r.last_error) b += note('danger', 'Last transaction rejected', esc(r.last_error));
  if (r.status === 'requires_action') b += note('warn', 'Action needed', `Send exactly <b>${esc(units(r.action.amount_units))}</b> from ${esc(short(r.from, 8, 6))} to ${esc(short(r.to, 8, 6))} on ${esc(r.action.chain.chainName)}. MetaMask will show a USDC transfer — never an approval.`)
    + `<details><summary class="faint" style="cursor:pointer">Sent it another way? Enter the transaction hash</summary><form class="stack" data-form="refundHash" style="margin-top:8px">${field('Transaction hash', input('hash', { req: true, ph: '0x…', extra: 'spellcheck="false" autocomplete="off"' }))}<div class="err" id="formErr"></div><button class="btn" type="submit">Verify transaction</button></form></details>`;
  if (r.status === 'pending') b += note('info', 'Verifying', 'Waiting for confirmations on-chain. This page refreshes when you reopen it.');
  b += `<h3>History</h3><ul class="timeline">${[...(r.events || [])].reverse().map(e => `<li><div><b>${esc(e.status.replace(/_/g, ' '))}</b> <span class="t">${fmtDT(e.at)}</span><div class="muted" style="font-size:.84rem;overflow-wrap:anywhere">${esc(e.note || '')}</div></div></li>`).join('')}</ul>`;
  App.cache.refund = r;
  const foot = r.status === 'requires_action' && can('refunds') ? `<button class="btn danger" data-act="cancelRefund">Cancel refund</button><button class="btn primary" data-act="sendRefund">Send with MetaMask</button>` : r.status === 'pending' ? `<button class="btn" data-act="refreshDrawer">Refresh</button>` : '';
  return { title: 'Refund', body: b, foot };
}
ACT.refreshDrawer = () => refreshDrawer();
ACT.sendRefund = () => run(async () => {
  const r = App.cache.refund;
  let hash; try { hash = await mmTransfer({ chain: r.action.chain, from: r.from, to: r.action.token, data: r.action.data }); } catch (e) { throw new Error(mmErr(e)); }
  await api('POST', `/m-api/refunds/${r.id}/tx`, { hash });
}, { ok: 'Transaction sent — verifying on-chain' });
FORM.refundHash = async f => { await api('POST', `/m-api/refunds/${App.cache.refund.id}/tx`, f); toast('Transaction submitted for verification'); await refreshDrawer(); render(); };
ACT.cancelRefund = () => confirmBox('Cancel this refund?', 'Only cancel if you have not sent the USDC.', 'Cancel refund', () => api('POST', `/m-api/refunds/${App.cache.refund.id}/cancel`));

/* ---------------- payment links ---------------- */
VIEWS.links = async () => {
  const links = await api('GET', '/m-api/links');
  return head('Payments', 'Payment links', 'No-code checkout: share a link by chat, email, social media or a QR code. Customers pay in USDC with MetaMask, straight into your wallet.', `<button class="btn primary" data-act="newLink">New payment link</button>`)
    + statusBanner() + walletBanner()
    + table([{ h: 'Created', v: l => fmtDate(l.created) }, { h: 'Description', v: l => esc(l.description) + (l.reusable ? ' <span class="tag">reusable</span>' : '') }, { h: 'Amount', r: 1, v: l => fmt(l.amount, 'USDC') },
      { h: 'Network', v: () => `<span class="tag">${App.mode === 'test' ? 'Base Sepolia' : 'Base'}</span>` }, { h: 'Paid', r: 1, v: l => l.paid }, { h: 'Status', v: l => badge(l.status) },
      { h: '', v: l => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-act="shareLink" data-url="${esc(l.url)}" data-desc="${esc(l.description)}">Share</button><a class="btn sm" href="${esc(l.url)}" target="_blank" rel="noopener">Open</a><button class="btn sm ghost" data-act="linkStatus" data-id="${l.id}" data-active="${l.status === 'active' ? '' : '1'}">${l.status === 'active' ? 'Deactivate' : 'Activate'}</button></div>` }], links, { empty: 'No payment links yet.' });
};
ACT.newLink = () => formModal('New payment link', 'link', `<div class="form-grid">${field('Amount (USD = USDC)', input('amount', { type: 'number', req: true, ph: '0.00', extra: 'step="0.01" min="0.50"' }))}${field('Settles in', '<input type="text" value="USDC on ' + (App.mode === 'test' ? 'Base Sepolia' : 'Base') + '" disabled>')}</div>
  ${field('Description', input('description', { req: true, extra: 'maxlength="200"', ph: 'What the customer pays for' }))}
  <div class="form-grid">${field('Expires', select('expires_in_days', [['0', 'Never'], ['1', 'In 1 day'], ['7', 'In 7 days'], ['30', 'In 30 days']], '0'))}<label class="check" style="align-self:end"><input type="checkbox" name="reusable" checked> Reusable (many customers)</label></div>`, 'Create link');
FORM.link = async f => { const l = await api('POST', '/m-api/links', { amount: toMinor(f.amount), currency: 'USD', description: f.description, payment_methods: ['usdc'], expires_in_days: +f.expires_in_days, reusable: f.reusable }); closeModal(); await render(); ACT.shareLink({ url: l.url, desc: l.description }); };
ACT.shareLink = d => openModal({ title: 'Share payment link', body: `<div class="row" style="align-items:flex-start"><div class="qr" id="lq"></div><div class="stack" style="flex:1;min-width:200px"><b>${esc(d.desc)}</b><div class="addr">${esc(d.url)}</div><div class="row"><button class="btn sm primary" data-act="copy" data-text="${esc(d.url)}">Copy link</button><a class="btn sm" href="${esc(d.url)}" target="_blank" rel="noopener">Open checkout</a></div>
  <span class="faint">Embed on any website:</span><pre class="code">${esc(`<a href="${d.url}" class="dh-pay-button">Pay with USDC</a>\n<script src="${location.origin}/js/digitalhub.js" async></script>`)}</pre></div></div>`, wide: true, onMount: () => qrInto($('#lq'), d.url) });
ACT.linkStatus = d => run(() => api('POST', `/m-api/links/${d.id}/status`, { active: !!d.active }), { ok: 'Link updated' });

/* ---------------- receiving wallet ---------------- */
VIEWS.wallet = async () => {
  const d = await api('GET', '/m-api/wallets'), net = App.mode === 'test' ? 'base_sepolia' : 'base', add = can('settings');
  return head('Money', 'Receiving wallet', 'Customers pay USDC directly into this wallet. Prove you control it by signing a free message in MetaMask — Digital Hub never asks for your seed phrase or private key.', add ? '<button class="btn primary" data-act="addWallet">Add wallet</button>' : '')
    + walletBanner()
    + `<div class="grid g2"><div class="card stack"><h2>Test (Base Sepolia)</h2>${d.receiving.test ? walletLine(d.wallets.find(w => w.id === d.receiving.test), 'base_sepolia') : '<p class="muted">No test receiving wallet yet. Any wallet you verify by signature can receive test payments.</p>'}</div>
       <div class="card stack"><h2>Live (Base mainnet)</h2>${d.receiving.live ? walletLine(d.wallets.find(w => w.id === d.receiving.live), 'base') : '<p class="muted">Live payments need a wallet that Digital Hub compliance has approved after your signature.</p>'}</div></div>`
    + table([{ h: 'Label', v: w => esc(w.label) }, { h: 'Address', v: w => addrLink(net, w.address) }, { h: 'Ownership', v: w => w.verified_at ? `signed ${fmtDT(w.verified_at)}` : '<span class="faint">not signed</span>' }, { h: 'Status', v: w => badge(w.status) + (w.review?.note ? `<div class="faint" style="font-size:.72rem">${esc(w.review.note)}</div>` : '') },
      { h: '', v: w => add ? `<div class="row" style="flex-wrap:nowrap">${w.status === 'pending_signature' ? `<button class="btn sm primary" data-act="verifyWallet" data-id="${w.id}" data-address="${esc(w.address)}">Verify with MetaMask</button>` : ''}
        ${['verified', 'approved'].includes(w.status) && d.receiving.test !== w.id ? `<button class="btn sm" data-act="setReceiving" data-id="${w.id}" data-mode="test">Use for test</button>` : ''}${w.status === 'approved' && d.receiving.live !== w.id ? `<button class="btn sm" data-act="setReceiving" data-id="${w.id}" data-mode="live">Use for live</button>` : ''}
        <button class="btn sm ghost" data-act="removeWallet" data-id="${w.id}">Remove</button></div>` : '' }], d.wallets, { empty: 'No wallets yet. Click “Add wallet”.' })
    + note('info', 'Security', 'Use a wallet your business controls (MetaMask account or hardware wallet connected to MetaMask). Do not use an exchange deposit address: exchanges may not credit direct token transfers, and you could not send refunds from it.');
};
const walletLine = (w, net) => w ? `<div class="row" style="justify-content:space-between">${addrLink(net, w.address)}${badge(w.status)}</div><span class="faint">${esc(w.label)}</span>` : '';
ACT.addWallet = () => formModal('Add receiving wallet', 'wallet', `${field('Base / EVM address', input('address', { req: true, ph: '0x…', extra: 'id="w-addr" spellcheck="false" autocomplete="off"' }), 'The same address works on Base Sepolia and Base mainnet.')}
  <div><button type="button" class="btn sm" data-act="walletFromMM"><span class="mm-dot"></span> Use my MetaMask account</button></div>
  ${field('Label', input('label', { ph: 'Store treasury' }))}`, 'Add and verify');
ACT.walletFromMM = () => run(async () => { try { const w = await DHMetaMask.connect(App.cache.chain || { chainIdHex: '0x14a34', chainName: 'Base Sepolia', rpcUrls: ['https://sepolia.base.org'] }); $('#w-addr').value = w.account; } catch (e) { throw new Error(mmErr(e)); } }, { noRefresh: true });
FORM.wallet = async f => { const w = await api('POST', '/m-api/wallets', f); closeModal(); await render(); ACT.verifyWallet({ id: w.id, address: w.address }); };
ACT.verifyWallet = d => run(async () => {
  const ch = await api('POST', `/m-api/wallets/${d.id}/challenge`); App.cache.chain = ch.chain;
  let w, signature;
  try {
    w = await DHMetaMask.connect(ch.chain);
    if (!DHMetaMask.same(w.account, ch.address)) throw new Error(`MetaMask is on ${short(w.account, 8, 6)}. Select ${short(ch.address, 8, 6)} in MetaMask, then click Verify again.`);
    toast('Sign the message in MetaMask (free, no transaction)');
    signature = await DHMetaMask.sign(w.provider, w.account, ch.message);
  } catch (e) { throw new Error(mmErr(e)); }
  await api('POST', `/m-api/wallets/${d.id}/verify`, { signature }); await loadMe();
}, { ok: 'Wallet ownership verified' });
ACT.setReceiving = d => run(async () => { await api('POST', `/m-api/wallets/${d.id}/receiving`, { mode: d.mode }); await loadMe(); }, { ok: 'Receiving wallet updated' });
ACT.removeWallet = d => confirmBox('Remove wallet?', 'New payments will not be sent to it. Past payments are unaffected.', 'Remove', async () => { await api('DELETE', '/m-api/wallets/' + d.id); await loadMe(); });

/* ---------------- balances & fees ---------------- */
VIEWS.balances = async () => {
  const [b, s] = await Promise.all([api('GET', '/m-api/balances'), api('GET', '/m-api/settlements')]), x = b.direct, cards = (l, v, sub) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${fmt(v, 'USDC')}</div><div class="sub">${sub}</div></div>`;
  return head('Money', 'Balances & fees', 'Your USDC never sits with Digital Hub: it is already in your wallet. This page is your double-entry record of what arrived, what you refunded and the platform fees you owe.', liveIf(s.statements.some(t => t.status === 'verifying')))
    + `<div class="grid g3">${cards('Received in your wallet', x.received, 'final on-chain receipts − refunds')}${cards('Sales', x.sales, 'paid invoices')}${cards('Refunded', x.refunded, 'verified on-chain')}
      ${cards('Owed back to customers', x.owed_to_customers, 'overpayments to refund')}${cards('Unapplied receipts', x.unapplied, 'funds on unpaid / underpaid invoices')}${cards('Digital Hub fees due', x.fees_due, 'billed on fee statements')}</div>`
    + `<div class="card"><div class="card-head"><h2>Fee statements</h2>${s.fee_wallet ? `<span class="faint">Pay to ${addrLink(App.mode === 'test' ? 'base_sepolia' : 'base', s.fee_wallet)}</span>` : '<span class="faint">Treasury wallet not configured yet</span>'}</div>
      ${table([{ h: 'Issued', v: t => fmtDT(t.created_at) }, { h: 'Period', v: t => `${fmtDate(t.period_from)} – ${fmtDate(t.period_to)}` }, { h: 'Amount', r: 1, v: t => fmt(t.amount, 'USDC') }, { h: 'Tx', v: t => t.tx?.hash ? txLink(App.mode === 'test' ? 'base_sepolia' : 'base', t.tx.hash) : '—' }, { h: 'Status', v: t => badge(t.status) + (t.last_error ? `<div class="faint" style="font-size:.72rem">${esc(t.last_error)}</div>` : '') },
        { h: '', v: t => t.action && can('payouts') ? `<button class="btn sm primary" data-act="paySettlement" data-id="${t.id}">Pay with MetaMask</button>` : '' }], s.statements, { empty: 'No fee statements yet. Digital Hub issues them periodically from accrued fees.' })}</div>`;
};
ACT.paySettlement = d => run(async () => {
  const s = await api('GET', '/m-api/settlements'), t = s.statements.find(x => x.id === d.id);
  let hash; try { hash = await mmTransfer({ chain: s.chain, from: null, to: t.action.token, data: t.action.data }); } catch (e) { throw new Error(mmErr(e)); }
  const r = await api('POST', `/m-api/settlements/${d.id}/tx`, { hash });
  if (r.status === 'open' && r.last_error) throw new Error(r.last_error);
}, { ok: 'Fee payment sent — verifying on-chain' });
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
  return head('Integrate', 'Developers & API', `REST API at <span class="mono">${esc(location.origin)}/v1</span>. Test keys use Base Sepolia; live keys use Base mainnet after go-live.`)
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
  const E = [['POST', '/v1/checkout/sessions', 'Create a hosted USDC checkout (amount in US cents, currency USD, payment_methods ["usdc"], description, success_url, cancel_url, metadata, customer_email)'], ['GET', '/v1/checkout/sessions/{id}', 'Retrieve a session (also works with the publishable key); refreshes on-chain status'],
    ['GET', '/v1/payments', 'List payments (?status, ?limit, ?offset)'], ['GET', '/v1/payments/{id}', 'Retrieve a payment with payer wallet, transactions and confirmations'],
    ['POST', '/v1/refunds', 'Create a USDC refund request (payment, amount, reason, optional address). Status requires_action until you send it with MetaMask; succeeds only after on-chain verification'], ['GET', '/v1/refunds', 'List refunds'], ['GET', '/v1/refunds/{id}', 'Retrieve a refund'],
    ['GET', '/v1/balance', 'Legacy custodial balances (empty for USDC — funds are already in your wallet)'],
    ['POST', '/v1/payment_links', 'Create a payment link (USD, payment_methods ["usdc"])'], ['GET', '/v1/payment_links', 'List links'], ['POST', '/v1/payment_links/{id}/deactivate', 'Deactivate a link'],
    ['GET', '/v1/events', 'List events (?type)'], ['GET', '/v1/events/{id}', 'Retrieve an event'],
    ['POST', '/v1/webhook_endpoints', 'Create an endpoint (url, enabled_events) — returns the signing secret once'], ['GET', '/v1/webhook_endpoints', 'List endpoints'], ['DELETE', '/v1/webhook_endpoints/{id}', 'Delete an endpoint'], ['GET', '/v1/account', 'Account, available methods, network, USDC contract and receiving wallet']];
  return `<div class="card stack"><h2>Conventions</h2>${kv([['Base URL', `<span class="mono">${esc(location.origin)}/v1</span>`], ['Auth', '<span class="mono">Authorization: Bearer dh_test_sk_…</span> (test) or <span class="mono">dh_live_sk_…</span> (live)'], ['Amounts', 'Integers in US cents (2500 = $25.00 = 25.00 USDC; on-chain 25000000 base units)'], ['Paid means', 'Transfer verified on Base: chain, USDC contract, recipient, payer, amount, receipt status, confirmations and finality'], ['Key events', '<span class="mono">crypto.payment.detected</span> (seen, not final) · <span class="mono">checkout.session.completed</span> / <span class="mono">payment.succeeded</span> (final) · <span class="mono">payment.refunded</span>'], ['Bodies', 'JSON or form-encoded'], ['Idempotency', '<span class="mono">Idempotency-Key</span> header on every POST; same key + same body replays the first response'], ['Errors', '<span class="mono">{"error":{"type","code","message"}}</span> with HTTP 400/401/403/404/409/422/429'], ['Rate limit', '100 requests / 10 s per key']])}</div>`
    + table([{ h: 'Method', v: e => `<span class="tag">${e[0]}</span>` }, { h: 'Path', v: e => `<span class="mono">${esc(e[1])}</span>` }, { h: 'Description', v: e => esc(e[2]) }], E);
}

/* ---------------- integrations (plugins, SDKs, snippets) ---------------- */
const SNIP = {
  curl: o => `curl ${o}/v1/checkout/sessions \\\n  -H "Authorization: Bearer $DH_SECRET_KEY" \\\n  -H "Idempotency-Key: order_1001" \\\n  -d amount=2500 -d currency=USD \\\n  -d "payment_methods[]=usdc" \\\n  -d description="Order #1001" \\\n  -d "metadata[order_id]=1001" \\\n  -d success_url=https://yourshop.com/thanks \\\n  -d cancel_url=https://yourshop.com/cart`,
  node: o => `// npm-free: copy sdk/node/digitalhub.js into your project\nconst DigitalHub = require('./digitalhub');\nconst dh = new DigitalHub(process.env.DH_SECRET_KEY, { baseUrl: '${o}' });\n\nconst session = await dh.checkout.create({\n  amount: 2500, currency: 'USD', payment_methods: ['usdc'],\n  description: 'Order #1001', metadata: { order_id: '1001' },\n  success_url: 'https://yourshop.com/thanks', cancel_url: 'https://yourshop.com/cart',\n}, { idempotencyKey: 'order_1001' });\n\nres.redirect(session.url); // customer pays with MetaMask; you get checkout.session.completed`,
  php: o => `<?php\n$ch = curl_init('${o}/v1/checkout/sessions');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => [\n    'Authorization: Bearer ' . getenv('DH_SECRET_KEY'),\n    'Content-Type: application/json',\n    'Idempotency-Key: order_1001',\n  ],\n  CURLOPT_POSTFIELDS => json_encode([\n    'amount' => 2500, 'currency' => 'USD', 'payment_methods' => ['usdc'],\n    'description' => 'Order #1001', 'metadata' => ['order_id' => '1001'],\n    'success_url' => 'https://yourshop.com/thanks',\n    'cancel_url' => 'https://yourshop.com/cart',\n  ]),\n]);\n$session = json_decode(curl_exec($ch), true);\nheader('Location: ' . $session['url']);`,
  python: o => `import os, requests\n\nr = requests.post(\n    "${o}/v1/checkout/sessions",\n    headers={"Authorization": f"Bearer {os.environ['DH_SECRET_KEY']}", "Idempotency-Key": "order_1001"},\n    json={"amount": 2500, "currency": "USD", "payment_methods": ["usdc"], "description": "Order #1001",\n          "metadata": {"order_id": "1001"},\n          "success_url": "https://yourshop.com/thanks", "cancel_url": "https://yourshop.com/cart"},\n)\nsession = r.json()\n# redirect the customer to session["url"]`,
  verifyNode: () => `const crypto = require('crypto');\n// Use the RAW request body (express.raw({ type: 'application/json' }))\nfunction verify(rawBody, header, secret) {\n  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));\n  const expected = crypto.createHmac('sha256', secret).update(parts.t + '.' + rawBody).digest('hex');\n  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 || ''));\n  if (!ok || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) throw new Error('bad signature');\n  return JSON.parse(rawBody); // then dedupe by event.id\n}`,
  verifyPhp: () => `$raw = file_get_contents('php://input');\nparse_str(str_replace(',', '&', $_SERVER['HTTP_DIGITALHUB_SIGNATURE'] ?? ''), $sig);\n$expected = hash_hmac('sha256', $sig['t'] . '.' . $raw, getenv('DH_WEBHOOK_SECRET'));\nif (!hash_equals($expected, $sig['v1'] ?? '') || abs(time() - (int)$sig['t']) > 300) {\n  http_response_code(400); exit;\n}\n$event = json_decode($raw, true); // dedupe by $event['id']`,
};
VIEWS.integrations = async () => {
  const o = location.origin, lang = tab('lang', 'curl'), vlang = tab('vlang', 'verifyNode');
  const card = (logo, title, text, actions) => `<div class="card integration"><div class="row"><span class="logo">${logo}</span><h2>${esc(title)}</h2></div><div class="muted">${text}</div><div class="row">${actions}</div></div>`;
  return head('Integrate', 'Plugins & integrations', 'Connect WordPress / WooCommerce, custom websites and apps. All integrations use your API keys and signed webhooks; customers always pay with MetaMask on the hosted checkout.')
    + `<div class="grid g2">
      ${card('W', 'WordPress · WooCommerce', `<ol class="stepper"><li>Download the plugin (v2) and upload it in <b>Plugins → Add New → Upload</b>.</li><li>Set the store currency to <b>USD</b> (1 USDC = 1 USD; no conversion is done).</li><li>Open <b>WooCommerce → Settings → Payments → USDC (MetaMask)</b>, paste your <b>secret key</b> and the URL <span class="mono">${esc(o)}</span>.</li><li>Add a webhook endpoint (Developers → Webhooks) with URL <span class="mono">https://YOUR-SHOP/wc-api/digitalhub/</span>; paste its signing secret into the plugin.</li><li>Place a test order and pay with Base Sepolia test USDC. The order goes <i>on hold</i> when the transfer is seen and <i>processing</i> when it is final on-chain. Refunds you send from Digital Hub are recorded on the order automatically.</li></ol>`, `<a class="btn primary" href="/downloads/digitalhub-woocommerce.zip">Download plugin (.zip)</a><a class="btn" href="#/developers">Get API key</a>`)}
      ${card('&lt;/&gt;', 'Any website · pay button', `Create a payment link, then paste this anywhere. The script turns links into styled buttons.<pre class="code" style="margin-top:8px">${esc(`<a href="${o}/l/YOUR_LINK" class="dh-pay-button">Pay with USDC</a>\n<script src="${o}/js/digitalhub.js" async></script>`)}</pre>`, `<a class="btn" href="#/links">Payment links</a>`)}
      ${card('N', 'Node.js SDK', 'Zero-dependency client for checkout sessions, payments, refunds, payment links and webhook signature verification.', `<a class="btn primary" href="/downloads/digitalhub-node-sdk.zip">Download SDK (.zip)</a>`)}
      ${card('S', 'Shopify (paused)', 'The Shopify bridge stays in the codebase but is not offered in this phase: Shopify only lists third-party gateways for approved payments partners.', '<span class="faint">Not available in this phase</span>')}</div>
    <div class="card"><div class="card-head"><h2>Create a checkout session</h2></div><div class="code-tabs">${[['curl', 'cURL'], ['node', 'Node.js'], ['php', 'PHP'], ['python', 'Python']].map(([k, l]) => `<button data-act="tab" data-group="lang" data-tab="${k}" aria-selected="${lang === k}">${l}</button>`).join('')}</div><pre class="code">${esc(SNIP[lang](o))}</pre></div>
    <div class="card"><div class="card-head"><h2>Verify webhooks</h2></div><div class="code-tabs">${[['verifyNode', 'Node.js'], ['verifyPhp', 'PHP']].map(([k, l]) => `<button data-act="tab" data-group="vlang" data-tab="${k}" aria-selected="${vlang === k}">${l}</button>`).join('')}</div><pre class="code">${esc(SNIP[vlang]())}</pre></div>
    ${note('info', 'Test first', 'Test mode runs on the real Base Sepolia testnet. Get free test USDC at faucet.circle.com (select Base Sepolia) and a little Base Sepolia ETH for gas. Nothing in test mode has monetary value.')}`;
};

/* ---------------- go live ---------------- */
VIEWS.golive = async () => {
  const d = await api('GET', '/m-api/onboarding'), done = d.steps.filter(s => s.done).length, k = d.kyb, b = k.business || {};
  const ownersRows = (k.owners.length ? k.owners : [{}]).map((o, i) => ownerRow(o, i)).join('');
  return head('Business', 'Go live', 'Complete verification, verify your receiving wallet and pass the checklist. Digital Hub compliance reviews each step before Base mainnet payments.')
    + `<div class="split"><div class="card"><div class="card-head"><h2>Checklist</h2>${badge(done === d.steps.length ? 'done' : 'pending', `${done}/${d.steps.length}`)}</div><div class="progress" style="margin-bottom:12px"><div style="width:${Math.round(done / d.steps.length * 100)}%"></div></div>
      <ol class="onb">${d.steps.map((s, i) => `<li><span class="n ${s.done ? 'done' : ''}">${s.done ? '✓' : i + 1}</span><div><b>${esc(s.label)}</b><div class="muted" style="font-size:.82rem">${esc(s.detail)}</div></div>${badge(s.done ? 'done' : 'pending', s.done ? 'done' : 'to do')}</li>`).join('')}</ol></div>
      <div class="card stack"><h2>Status</h2>${kv([['Verification', badge(d.status)], ['Payment method', 'USDC via MetaMask'], ['Test network', 'Base Sepolia (84532)'], ['Live network', 'Base mainnet (8453)'], ['Live payments', d.live_ready ? badge('pending', 'not active') : badge('active')], ['Why', esc(d.live_ready || 'Ready')]])}
        ${note('warn', 'Real money', 'On Base mainnet, customers send real USDC straight to your approved wallet. Digital Hub verifies every transfer on-chain but cannot reverse or freeze it. Card payments and other providers are not offered in this phase.')}</div></div>
    <form class="card stack" data-form="kyb"><div class="card-head" style="margin:0"><h2>Business verification (KYB)</h2>${badge(k.submitted ? (d.status === 'approved' ? 'approved' : 'submitted') : 'pending', k.submitted ? (d.status === 'approved' ? 'verified' : 'under review') : 'not submitted')}</div>
      <div class="form-grid">${field('Legal entity name', input('legal_name', { req: true, value: b.legal_name || M().legal_name }))}${field('Registration number', input('registration_number', { req: true, value: b.registration_number || '' }))}
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

/* ---------------- settings & team ---------------- */
VIEWS.settings = async () => {
  const t = tab('set', 'profile'), m = M(); let body = '';
  if (t === 'profile') body = `<form class="card stack" data-form="settings"><h2>Public profile</h2><div class="form-grid">${field('Display name (shown at checkout)', input('name', { value: m.name, req: true }))}${field('Support email', input('support_email', { type: 'email', value: m.support_email || '' }))}${field('Website', input('website', { value: m.website || '' }))}</div>
    <div class="err" id="formErr"></div><div><button class="btn primary" type="submit">Save</button></div></form>`;
  if (t === 'team') {
    const d = await api('GET', '/m-api/team');
    body = `<div class="card"><div class="card-head"><h2>Team</h2>${can('team') ? '<button class="btn primary" data-act="inviteMember">Add member</button>' : ''}</div>${table([{ h: 'Name', v: u => `${esc(u.name)}<div class="faint" style="font-size:.75rem">${esc(u.email)}</div>` }, { h: 'Role', v: u => esc(d.roles[u.role]?.label || u.role) }, { h: '2FA', v: u => badge(u.mfa_enabled ? 'enabled' : 'pending', u.mfa_enabled ? 'on' : 'off') }, { h: 'Status', v: u => badge(u.status) }, { h: 'Last sign-in', v: u => fmtDT(u.last_login) }, { h: '', v: u => u.role !== 'owner' && u.status === 'active' && can('team') ? `<button class="btn sm ghost" data-act="removeMember" data-id="${u.id}">Remove</button>` : '' }], d.users)}
      <p class="faint" style="margin-top:8px">Roles: ${Object.values(d.roles).map(r => `<b>${esc(r.label)}</b> (${esc(r.perms.join(', '))})`).join(' · ')}</p></div>`;
  }
  return head('Business', 'Settings & team') + tabs('set', [['profile', 'Profile'], ['team', 'Team']], 'profile') + body;
};
FORM.settings = async f => { await api('PATCH', '/m-api/settings', f); toast('Saved'); await loadMe(); };
ACT.inviteMember = () => formModal('Add team member', 'invite', `${field('Name', input('name', { req: true }))}${field('Email', input('email', { type: 'email', req: true }))}${field('Role', select('role', [['admin', 'Admin'], ['finance', 'Finance'], ['developer', 'Developer'], ['support', 'Support'], ['viewer', 'Viewer']]))}`, 'Add member');
FORM.invite = async f => { const r = await api('POST', '/m-api/team', f); closeModal(); await render(); secretModal('Temporary password', `Share this with <b>${esc(r.user.email)}</b> through a secure channel. They should change it and enable 2FA on first sign-in.`, r.temporary_password); };
ACT.removeMember = d => confirmBox('Remove member?', 'They lose access immediately.', 'Remove', () => api('DELETE', '/m-api/team/' + d.id));
