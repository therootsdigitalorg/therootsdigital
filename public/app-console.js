'use strict';
/* DIGITAL HUB — Card Payments & Crypto Settlement: single-business Super Admin console.
   Data comes from /api/v1/admin (server/routes/console.js); Infura & Blockchain reuses /a-api/chain.
   Nothing in the browser decides that money moved: statuses are what the server verified with Authorize.Net or on Base. */

NAV.console = [
  ['Payments', [['overview', 'Overview'], ['transactions', 'Card Transactions'], ['authorize-net', 'Authorize.Net'], ['customers', 'Customers'], ['links', 'Payment Links'], ['woocommerce', 'WooCommerce Integration']]],
  ['Settlement', [['settlements', 'Settlements'], ['wallet', 'Crypto Wallet'], ['infura', 'Infura & Blockchain'], ['transfers', 'USDC Transfers']]],
  ['Operations', [['refunds', 'Refunds & Disputes'], ['webhooks', 'Webhook Logs'], ['reports', 'Reports & Analytics'], ['security', 'Security & Audit Logs'], ['settings', 'Settings']]],
];
const cx = (method, path, body) => api(method, '/api/v1/admin' + path, body);
const usd = c => fmt(c, 'USD');
const codeField = () => field('Authenticator code', input('code', { req: true, extra: 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"' }), 'Current 6-digit code from your authenticator app.');
const statusBadges = s => `<div class="status4" title="Card · USD settlement · Conversion · USDC payout">${badge(s.card)}${s.usd_settlement ? badge(s.usd_settlement, 'USD ' + s.usd_settlement) : ''}${s.conversion !== 'not_requested' ? badge(s.conversion, 'conv ' + s.conversion) : ''}${s.usdc_payout !== 'not_initiated' ? badge(s.usdc_payout, 'USDC ' + s.usdc_payout) : ''}</div>`;
const STATUS_HELP = `<div class="st-legend">
  <div><b>Card</b>Created · Pending · Authorized · Captured · Declined · Voided · Refunded · Disputed</div>
  <div><b>USD settlement</b>Pending · Settled · Reconciled · Failed</div>
  <div><b>Conversion</b>Not requested · Pending · Processing · Completed · Failed</div>
  <div><b>USDC payout</b>Not initiated · Pending · Submitted · Confirmed · Failed</div></div>`;
function bars(series) {
  const W = 720, H = 200, padL = 52, padB = 26, padT = 12, padR = 8, max = Math.max(100, ...series.map(s => s.amount));
  const raw = max / 100 / 4, p10 = Math.pow(10, Math.floor(Math.log10(raw || 1))), f = raw / p10, step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p10 || 1;
  const top = Math.ceil(max / 100 / step) * step, bw = (W - padL - padR) / series.length, y = v => H - padB - (v / 100) / top * (H - padB - padT);
  let g = '<defs><linearGradient id="gbar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#4F7CFF"/></linearGradient></defs>';
  for (let t = 0; t <= top; t += step) { const yy = y(t * 100); g += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="${padL - 6}" y="${yy + 3}" text-anchor="end">$${t >= 1000 ? (t / 1000) + 'k' : t}</text>`; }
  series.forEach((s, i) => { const x = padL + i * bw + bw * .2, w = bw * .6, yy = y(s.amount); g += `<rect x="${x}" y="${yy}" width="${w}" height="${H - padB - yy}" fill="url(#gbar)" rx="3"><title>${esc(s.label)}: ${usd(s.amount)}</title></rect>`; if (i % 2 === 0) g += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${esc(s.label)}</text>`; });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Captured card volume per day">${g}</svg></div>`;
}
const kpi = (label, value, sub = '', hero = false) => `<div class="card kpi${hero ? ' hero' : ''}"><span class="label">${esc(label)}</span><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

/* ================= Overview ================= */
VIEWS.overview = async () => {
  const o = await cx('GET', '/overview'), k = o.kpis, i = o.integrations, an = i.authorize_net;
  const setup = [
    !an.configured && ['Connect Authorize.Net', `Add your ${an.env} API Login ID, Transaction Key and Signature Key.`, 'authorize-net'],
    an.configured && !an.last_test?.ok && ['Test the Authorize.Net connection', 'Confirms the credentials are accepted.', 'authorize-net'],
    an.configured && !an.webhook && ['Register the Authorize.Net webhook', 'Lets Authorize.Net tell Digital Hub about payments instantly (signed).', 'authorize-net'],
    !i.woocommerce && ['Connect your WooCommerce store', 'Install “Digital Hub Payments” and paste the generated keys.', 'woocommerce'],
    !i.wallet && ['Verify your MetaMask wallet', 'USDC payouts can only be tracked to a wallet you proved you control.', 'wallet'],
    !i.infura.configured && ['Add your Infura API key', 'Used to verify USDC transfers on Base.', 'infura'],
  ].filter(Boolean);
  return head('Overview', o.business.name, `${App.mode === 'test' ? 'Test mode — Authorize.Net sandbox and Base Sepolia.' : 'Live mode.'} Card payments are confirmed only after Digital Hub verifies them with Authorize.Net.`,
      `<a class="btn" href="#/transactions">Card transactions</a><a class="btn primary" href="#/links">New payment link</a>`)
    + (setup.length ? `<div class="card stack"><div class="card-head" style="margin:0"><h2>Finish setup</h2><span class="tag">${setup.length} step${setup.length > 1 ? 's' : ''}</span></div>${setup.map(([t, d, r]) => `<div class="row" style="justify-content:space-between;gap:12px;border-top:1px solid var(--line);padding-top:10px"><div><b>${esc(t)}</b><div class="faint">${esc(d)}</div></div><a class="btn sm" href="#/${r}">Open</a></div>`).join('')}</div>` : '')
    + `<div class="grid g4">${kpi('Captured · 30 days', usd(k.captured), `${k.captured_count} payment${k.captured_count === 1 ? '' : 's'}`, true)}${kpi('Awaiting capture', usd(k.authorized), `${k.authorized_count} authorization(s)`)}${kpi('Refunded · 30 days', usd(k.refunded), `${k.disputed} disputed`)}${kpi('Declined · held', `${k.declined} · ${k.held}`, 'declined · processor review')}</div>`
    + `<div class="grid g2"><div class="card"><div class="card-head"><h2>Captured volume</h2><span class="faint">last 14 days · USD</span></div>${bars(o.series)}</div>
       <div class="card stack"><h2>Money flow</h2>${kv([['Acquirer receivable', usd(o.settlement?.acquirer_receivable || 0)], ['Bank clearing (settled, not reconciled)', usd(o.settlement?.bank_clearing || 0)], ['Bank (reconciled)', usd(o.settlement?.bank || 0)], ['In conversion', usd(o.settlement?.in_conversion || 0)], ['USDC in transit', fmt(o.settlement?.usdc_in_transit || 0, 'USDC')], ['USDC in your wallet (verified)', fmt(o.settlement?.usdc_wallet || 0, 'USDC')]])}
       <div class="pill-row">${badge(an.configured ? 'enabled' : 'pending', 'Authorize.Net ' + an.env)}${badge(an.webhook ? 'enabled' : 'pending', 'webhook')}${badge(i.infura.configured ? 'enabled' : 'pending', 'Infura')}${badge(i.wallet ? 'verified' : 'pending', 'wallet')}${badge(o.live.cards ? 'live' : 'test', o.live.cards ? 'live cards ON' : 'live cards off')}${badge(o.live.payouts ? 'live' : 'test', o.live.payouts ? 'live payouts ON' : 'live payouts off')}</div></div></div>`
    + (o.alerts.length ? `<div class="card"><div class="card-head"><h2>Open alerts</h2></div>${table([{ h: 'When', v: a => fmtDT(a.created_at) }, { h: 'Severity', v: a => badge(a.severity) }, { h: 'Alert', v: a => esc(a.kind.replace(/_/g, ' ')) }, { h: 'Detail', v: a => esc(a.detail) }], o.alerts)}</div>` : '')
    + `<div class="card"><div class="card-head"><h2>Recent card transactions</h2><a class="btn sm ghost" href="#/transactions">All</a></div>${txTable(o.recent)}</div>`;
};
function txTable(rows, empty = 'No card transactions yet. Payments appear here after customers pay on the Authorize.Net secure page.') {
  return table([{ h: 'Date', v: p => fmtDT(p.created) }, { h: 'Customer', v: p => `${esc(p.customer.name || '—')}<div class="faint">${esc(p.customer.email || '')}</div>` },
    { h: 'Card', v: p => p.card ? `${esc(p.card.brand)} •••• ${esc(p.card.last4)}` : '<span class="faint">—</span>' }, { h: 'Invoice', v: p => `<span class="mono">${esc(p.invoice)}</span>${p.order_id ? `<div class="faint">Woo #${esc(p.order_id)}</div>` : ''}` },
    { h: 'Status', v: p => statusBadges(p.statuses) }, { h: 'Amount', r: 1, v: p => usd(p.amount) + (p.refunded ? `<div class="faint">−${usd(p.refunded)}</div>` : '') }],
    rows, { empty, rowAttr: p => `class="click" tabindex="0" data-act="tx" data-id="${p.id}"` });
}

/* ================= Card transactions ================= */
VIEWS.transactions = async () => {
  const f = App.filters.tx || {}, r = await cx('GET', '/transactions' + qs({ q: f.q, status: f.status, limit: 50, offset: f.offset || 0 }));
  const live = r.data.some(p => ['created', 'pending', 'authorized'].includes(p.statuses.card));
  return head('Payments', 'Card transactions', 'Authorize.Net Accept Hosted payments. Statuses are kept separate: card, USD settlement, conversion and USDC payout.', liveIf(live, 8000))
    + `<div class="card stack">${STATUS_HELP}</div>`
    + `<div class="filters">${fInput('tx', 'q', 'Search', 'invoice, transaction ID, email, last 4, order')}${fSelect('tx', 'status', 'Card status', [['', 'All'], ...['created', 'pending', 'authorized', 'captured', 'declined', 'voided', 'partially_refunded', 'refunded', 'disputed'].map(s => [s, s.replace(/_/g, ' ')])])}</div>`
    + txTable(r.data, f.q || f.status ? 'No transactions match.' : undefined) + pager('tx', r.total, 50);
};
function pager(bag, total, size) { const off = App.filters[bag]?.offset || 0; if (total <= size) return ''; return `<div class="row" style="justify-content:flex-end;gap:8px"><span class="faint">${off + 1}–${Math.min(off + size, total)} of ${total}</span><button class="btn sm" data-act="page" data-bag="${bag}" data-to="${Math.max(0, off - size)}" ${off ? '' : 'disabled'}>Previous</button><button class="btn sm" data-act="page" data-bag="${bag}" data-to="${off + size}" ${off + size < total ? '' : 'disabled'}>Next</button></div>`; }
ACT.page = d => { (App.filters[d.bag] ||= {}).offset = +d.to; render(); };
ACT.tx = d => openDrawer(async () => {
  const p = await cx('GET', '/transactions/' + d.id), s = p.statuses, unsettled = !['settled', 'reconciled'].includes(s.usd_settlement);
  App.cache.tx = p;
  const acts = [
    `<button class="btn" data-act="txRefresh" data-id="${p.id}">Check with Authorize.Net</button>`,
    s.card === 'authorized' && can('payments.manage') && `<button class="btn primary" data-act="txCapture" data-id="${p.id}">Capture</button>`,
    ['authorized', 'captured'].includes(s.card) && unsettled && can('payments.manage') && `<button class="btn danger" data-act="txVoid" data-id="${p.id}">Void</button>`,
    ['captured', 'partially_refunded'].includes(s.card) && can('payments.manage') && `<button class="btn" data-act="txRefund" data-id="${p.id}">Refund</button>`,
    ['captured', 'partially_refunded', 'refunded'].includes(s.card) && can('payments.manage') && `<button class="btn ghost" data-act="txDispute" data-id="${p.id}">Record chargeback</button>`,
  ].filter(Boolean).join('');
  return { title: `${usd(p.amount)} · ${p.customer.name || p.customer.email || 'Card payment'}`,
    body: `${statusBadges(s)}<div class="divider"></div>${kv([['Invoice', `<span class="mono">${esc(p.invoice)}</span>`], ['Authorize.Net transaction', p.trans_id ? `<span class="mono">${esc(p.trans_id)}</span>` : '<span class="faint">not paid yet</span>'], ['Processor status', esc(p.raw_status || '—')],
      ['Card', p.card ? `${esc(p.card.brand)} •••• ${esc(p.card.last4)}` : '—'], ['Auth code', esc(p.auth_code || '—')], ['AVS / CVV', `${esc(p.avs || '—')} / ${esc(p.cvv || '—')}`], ['Customer', `${esc(p.customer.name || '—')} · ${esc(p.customer.email || '')}`],
      ['Captured', usd(p.captured)], ['Refunded', usd(p.refunded)], ['Batch', esc(p.batch || '—')], ['WooCommerce order', esc(p.order_id || '—')], ['Last verified', p.checked_at ? fmtDT(p.checked_at) : '—'], ['Description', esc(p.description)]])}
      <h3>Timeline</h3><ul class="timeline">${p.events.slice().reverse().map(e => `<li><b>${esc(e.status.replace(/_/g, ' '))}</b> <span class="faint">${fmtDT(e.at)}</span><div class="faint">${esc(e.note || '')}</div></li>`).join('')}</ul>
      ${p.refunds.length ? '<h3>Refunds</h3>' + table([{ h: 'When', v: r => fmtDT(r.created_at) }, { h: 'Status', v: r => badge(r.status) }, { h: 'Authorize.Net', v: r => `<span class="mono">${esc(r.anet_trans_id || '—')}</span>` }, { h: 'Amount', r: 1, v: r => usd(r.amount) }], p.refunds) : ''}
      ${p.disputes.length ? '<h3>Chargebacks</h3>' + table([{ h: 'When', v: r => fmtDT(r.created_at) }, { h: 'Status', v: r => badge(r.status) }, { h: 'Reference', v: r => esc(r.reference || '—') }, { h: 'Amount', r: 1, v: r => usd(r.amount) }], p.disputes) : ''}
      <h3>Ledger</h3>${table([{ h: 'Account', v: l => esc(l.account.replace(/_/g, ' ')) }, { h: 'Memo', v: l => esc(l.memo) }, { h: 'Amount', r: 1, v: l => fmt(l.amount, l.currency) }], p.ledger, { empty: 'Nothing booked yet (bookings start at capture).' })}`,
    foot: acts };
});
ACT.txRefresh = d => run(() => cx('POST', `/transactions/${d.id}/refresh`), { ok: 'Checked with Authorize.Net' });
ACT.txCapture = d => formModal('Capture authorization', 'txCapture', note('info', '', 'Captures through Authorize.Net (priorAuthCapture). Leave empty to capture the full authorized amount.') + field('Amount (USD)', input('amount', { ph: (App.cache.tx.amount / 100).toFixed(2), extra: 'inputmode="decimal"' })), 'Capture', { data: { id: d.id } });
FORM.txCapture = async (f, form) => { await cx('POST', `/transactions/${form.dataset.id}/capture`, f); closeModal(); toast('Captured'); await render(); await refreshDrawer(); };
ACT.txVoid = d => confirmBox('Void this payment?', 'The authorization or unsettled capture is cancelled at Authorize.Net. The customer is not charged.', 'Void payment', () => cx('POST', `/transactions/${d.id}/void`));
ACT.txRefund = d => formModal('Refund', 'txRefund', note('info', '', 'Unsettled payments can only be voided in full. Settled payments are refunded to the card through Authorize.Net.') + field('Amount (USD)', input('amount', { ph: ((App.cache.tx.captured - App.cache.tx.refunded) / 100).toFixed(2), extra: 'inputmode="decimal"' }), 'Empty = everything not yet refunded.') + field('Reason', input('reason', { ph: 'requested by customer' })), 'Refund', { data: { id: d.id } });
FORM.txRefund = async (f, form) => { const r = await cx('POST', `/transactions/${form.dataset.id}/refund`, f); closeModal(); toast(r.voided ? 'Voided (not yet settled)' : 'Refund accepted by Authorize.Net'); await render(); await refreshDrawer(); };
ACT.txDispute = d => formModal('Record chargeback', 'txDispute', note('warn', '', 'Authorize.Net has no chargeback webhook: record the chargeback notice from your processor here so the books match.') + field('Amount (USD)', input('amount', { ph: (App.cache.tx.captured / 100).toFixed(2) })) + field('Reason', input('reason', { req: true })) + field('Case reference', input('reference')), 'Record', { data: { id: d.id } });
FORM.txDispute = async (f, form) => { await cx('POST', `/transactions/${form.dataset.id}/dispute`, f); closeModal(); toast('Chargeback recorded'); await render(); await refreshDrawer(); };

/* ================= Authorize.Net ================= */
VIEWS['authorize-net'] = async () => {
  const c = await cx('GET', '/authorize-net');
  const envCard = e => { const x = c.environments[e], lt = x.last_test;
    return `<div class="card stack"><div class="card-head" style="margin:0"><h2>${e === 'sandbox' ? 'Sandbox (test mode)' : 'Production (live mode)'}</h2>${badge(x.configured ? 'enabled' : 'pending', x.configured ? 'configured' : 'not configured')}</div>
      ${kv([['Source', esc(x.source || '—')], ['API Login ID', x.login_id ? `<span class="mono">${esc(x.login_id)}</span>` : '—'], ['Transaction Key', x.transaction_key ? `<span class="mono">${esc(x.transaction_key)}</span>` : '—'], ['Signature Key', x.signature_key ? badge('enabled', 'stored') : badge('pending', 'missing')],
        ['Last test', lt ? `${badge(lt.ok ? 'pass' : 'fail', lt.ok ? 'accepted' : 'failed')} <span class="faint">${fmtDT(lt.at)} ${esc(lt.code || '')}</span>` : '<span class="faint">never</span>'], ['Webhook', x.webhook ? `${badge('enabled', 'registered')} <span class="faint">${fmtDT(x.webhook.at)}</span>` : badge('pending', 'not registered')], ['API endpoint', `<span class="mono">${esc(x.api)}</span>`], ['Hosted page', `<span class="mono">${esc(x.hosted)}</span>`]])}
      <div class="row">${x.source !== 'environment' && can('platform.settings') ? `<button class="btn primary" data-act="anetCreds" data-env="${e}">${x.configured ? 'Update keys' : 'Add keys'}</button>` : ''}${x.configured ? `<button class="btn" data-act="anetTest" data-env="${e}">Test connection</button><button class="btn" data-act="anetHook" data-env="${e}">${x.webhook ? 'Re-check webhook' : 'Register webhook'}</button>` : ''}${x.configured && x.source !== 'environment' ? `<button class="btn ghost" data-act="anetRemove" data-env="${e}">Remove</button>` : ''}</div></div>`; };
  return head('Integrations', 'Authorize.Net', 'Customers type their card on Authorize.Net’s secure hosted payment page (Accept Hosted). Card numbers and CVV never reach Digital Hub.')
    + `<div class="grid g2">${envCard('sandbox')}${envCard('production')}</div>`
    + `<div class="grid g2"><div class="card stack"><h2>Payment flow</h2><p class="muted">${c.flow === 'authOnly' ? 'Authorize only: funds are held; you capture each payment from Card Transactions (WooCommerce orders go on hold until captured).' : 'Authorize and capture: payments are captured immediately and the order is marked paid once verified.'}</p>
        <div class="row"><button class="btn ${c.flow === 'authCapture' ? 'primary' : ''}" data-act="anetFlow" data-flow="authCapture">Authorize + capture</button><button class="btn ${c.flow === 'authOnly' ? 'primary' : ''}" data-act="anetFlow" data-flow="authOnly">Authorize only</button></div></div>
      <div class="card stack"><h2>Webhook</h2><p class="muted">Every notification is verified with your Signature Key (HMAC-SHA512, X-ANET-Signature) and then re-checked with a server-side transaction lookup before anything changes.</p>
        <div class="secret">${esc(c.webhook_url)}</div><button class="btn sm" data-act="copy" data-text="${esc(c.webhook_url)}">Copy URL</button><details><summary class="faint">Events</summary><ul class="faint">${c.events.map(e => `<li class="mono">${esc(e)}</li>`).join('')}</ul></details></div></div>`
    + note('info', 'Where to find the keys', 'Authorize.Net Merchant Interface → Account → Settings → Security Settings → <b>API Credentials &amp; Keys</b> (API Login ID, new Transaction Key, new Signature Key). Sandbox accounts: developer.authorize.net → Sandbox. Keys are encrypted (AES-256-GCM) on the server and never shown again in full.');
};
ACT.anetCreds = d => formModal(`Authorize.Net ${d.env} keys`, 'anetCreds', field('API Login ID', input('login_id', { extra: 'autocomplete="off" spellcheck="false"' })) + field('Transaction Key', input('transaction_key', { type: 'password', extra: 'autocomplete="new-password"' }), '16 characters. Leave empty to keep the stored key.') + field('Signature Key', input('signature_key', { type: 'password', extra: 'autocomplete="new-password"' }), '128 hexadecimal characters. Needed to verify webhooks.') + codeField(), 'Save encrypted', { data: { env: d.env } });
FORM.anetCreds = async (f, form) => { await cx('POST', '/authorize-net/' + form.dataset.env, f); closeModal(); toast('Saved. Now test the connection.'); render(); };
ACT.anetTest = d => run(async () => { const r = await cx('POST', `/authorize-net/${d.env}/test`); toast(r.ok ? r.message : 'Rejected: ' + r.message, r.ok ? '' : 'err'); });
ACT.anetHook = d => run(() => cx('POST', `/authorize-net/${d.env}/webhook`), { ok: 'Webhook registered with Authorize.Net' });
ACT.anetRemove = d => formModal(`Remove ${d.env} keys`, 'anetRemove', note('warn', '', 'Card checkout in this mode stops until new keys are added.') + codeField(), 'Remove', { data: { env: d.env } });
FORM.anetRemove = async (f, form) => { await cx('POST', `/authorize-net/${form.dataset.env}/remove`, f); closeModal(); toast('Removed'); render(); };
ACT.anetFlow = d => run(() => cx('POST', '/settings/flow', { flow: d.flow }), { ok: 'Payment flow updated' });

/* ================= Customers ================= */
VIEWS.customers = async () => {
  const f = App.filters.cus || {}, r = await cx('GET', '/customers' + qs({ q: f.q }));
  return head('Payments', 'Customers', 'Built from the name, email and billing details customers enter at checkout. No card data is stored.')
    + `<div class="filters">${fInput('cus', 'q', 'Search', 'name or email')}</div>`
    + table([{ h: 'Customer', v: c => `${esc(c.name || '—')}<div class="faint">${esc(c.email)}</div>` }, { h: 'Location', v: c => esc([c.billing?.city, c.billing?.state, c.billing?.country].filter(Boolean).join(', ') || '—') }, { h: 'Payments', r: 1, v: c => c.payments || 0 }, { h: 'Paid', r: 1, v: c => usd(c.total || 0) }, { h: 'Refunded', r: 1, v: c => usd(c.refunded || 0) }, { h: 'Last payment', v: c => fmtDT(c.last_payment_at) }],
      r.data, { empty: 'No customers yet.', rowAttr: c => `class="click" tabindex="0" data-act="customer" data-id="${c.id}"` });
};
ACT.customer = d => openDrawer(async () => { const c = await cx('GET', '/customers/' + d.id); return { title: c.name || c.email, body: kv([['Email', esc(c.email)], ['Phone', esc(c.phone || '—')], ['Billing', esc(Object.values(c.billing || {}).filter(Boolean).join(', ') || '—')], ['First seen', fmtDT(c.first_seen)], ['Total paid', usd(c.total || 0)], ['Refunded', usd(c.refunded || 0)]]) + '<h3>Payments</h3>' + txTable(c.payments, 'No payments.') }; });

/* ================= Payment links ================= */
VIEWS.links = async () => {
  const rows = await cx('GET', '/links');
  return head('Payments', 'Payment links', 'Share a link; the customer pays by card on the Authorize.Net secure page.', can('payments.manage') ? '<button class="btn primary" data-act="newLink">New payment link</button>' : '')
    + table([{ h: 'Created', v: l => fmtDT(l.created) }, { h: 'Description', v: l => esc(l.description) }, { h: 'Link', v: l => `<span class="mono">${esc(short(l.url, 30, 10))}</span> <button class="btn sm ghost" data-act="copy" data-text="${esc(l.url)}">Copy</button>` }, { h: 'Type', v: l => l.reusable ? 'reusable' : 'one-time' }, { h: 'Paid', r: 1, v: l => l.paid }, { h: 'Status', v: l => badge(l.active ? 'active' : 'disabled', l.active ? 'active' : 'inactive') }, { h: 'Amount', r: 1, v: l => usd(l.amount) }, { h: '', v: l => l.active && can('payments.manage') ? `<button class="btn sm ghost" data-act="linkOff" data-id="${l.id}">Deactivate</button>` : '' }],
      rows, { empty: 'No payment links yet.' });
};
ACT.newLink = () => formModal('New payment link', 'newLink', `<div class="form-grid">${field('Amount (USD)', input('amount', { req: true, extra: 'inputmode="decimal"' }))}${field('Expires after (days)', input('expires_in_days', { ph: 'never' }))}</div>${field('Description', input('description', { req: true, ph: 'What the customer pays for' }))}<label class="row"><input type="checkbox" name="reusable"> Reusable (many customers can pay)</label>`, 'Create link');
FORM.newLink = async f => { const l = await cx('POST', '/links', f); closeModal(); secretModal('Payment link ready', 'Share this link with your customer:', l.url); render(); };
ACT.linkOff = d => confirmBox('Deactivate link?', 'Customers can no longer pay with it.', 'Deactivate', () => cx('POST', `/links/${d.id}/deactivate`));

/* ================= WooCommerce ================= */
VIEWS.woocommerce = async () => {
  const w = await cx('GET', '/woocommerce');
  return head('Integrations', 'WooCommerce integration', `Plugin “${esc(w.plugin.name)}” v${esc(w.plugin.version)} — card payments through the Authorize.Net hosted page; orders are marked paid only from Digital Hub’s signed webhook.`,
      `<a class="btn" href="${esc(w.plugin.download)}">Download plugin</a>${can('platform.settings') ? '<button class="btn primary" data-act="wooConnect">Connect store</button>' : ''}`)
    + `<div class="card stack"><h2>Set up in 4 steps</h2><ol class="muted" style="margin:0;padding-left:18px"><li>Download and install the plugin in WordPress (Plugins → Add New → Upload).</li><li>Click <b>Connect store</b> here and enter your shop address. You get the Digital Hub URL, a secret key and a webhook secret.</li><li>WooCommerce → Settings → Payments → Digital Hub Payments: paste them, tick Test mode, enable.</li><li>Place a test order and pay with an Authorize.Net sandbox test card.</li></ol>
      ${kv([['Checkout API', `<span class="mono">POST ${esc(w.api.checkout)}</span>`], ['Status API', `<span class="mono">GET ${esc(w.api.status)}</span>`], ['Webhook path on the store', `<span class="mono">${esc(w.plugin.webhook_path)}</span>`]])}</div>`
    + `<div class="card"><div class="card-head"><h2>Connected stores (webhooks)</h2></div>${table([{ h: 'URL', v: e => `<span class="mono">${esc(e.url)}</span>` }, { h: 'Status', v: e => badge(e.status) }, { h: 'Delivered', r: 1, v: e => e.delivered }, { h: 'Failing', r: 1, v: e => e.failing ? badge('failed', String(e.failing)) : '0' }, { h: 'Last', v: e => e.last ? `${badge(e.last.status)} <span class="faint">${esc(e.last.type)} ${fmtDT(e.last.at)}</span>` : '—' }, { h: '', v: e => can('platform.settings') ? `<button class="btn sm ghost" data-act="wooHookDel" data-id="${e.id}">Delete</button>` : '' }], w.endpoints, { empty: 'No store connected yet.' })}</div>`
    + `<div class="card"><div class="card-head"><h2>API keys</h2></div>${table([{ h: 'Name', v: k => esc(k.name) }, { h: 'Type', v: k => esc(k.type) }, { h: 'Key', v: k => `<span class="mono">${esc(k.type === 'publishable' ? k.plain : k.prefix + '…' + k.last4)}</span>` }, { h: 'Last used', v: k => fmtDT(k.last_used) }, { h: 'Status', v: k => badge(k.status) }, { h: '', v: k => k.status === 'active' && k.type === 'secret' && can('platform.settings') ? `<button class="btn sm ghost" data-act="wooKeyRevoke" data-id="${k.id}">Revoke</button>` : '' }], w.keys)}</div>`
    + `<div class="card"><div class="card-head"><h2>Recent WooCommerce orders</h2></div>${table([{ h: 'Created', v: s => fmtDT(s.created) }, { h: 'Order', v: s => esc(s.metadata.order_id) }, { h: 'Status', v: s => badge(s.status) }, { h: 'Amount', r: 1, v: s => usd(s.amount) }], w.orders, { empty: 'No orders yet.' })}</div>`;
};
ACT.wooConnect = () => formModal('Connect a WooCommerce store', 'wooConnect', field('Store address', input('store_url', { req: true, ph: 'https://yourshop.com' }), `Creates a ${App.mode} secret key and a signed webhook to <span class="mono">/wc-api/digitalhub/</span> on your store.`), 'Connect');
FORM.wooConnect = async f => { const r = await cx('POST', '/woocommerce/connect', f); closeModal(); const s = r.plugin_settings;
  openModal({ title: `Store connected · ${r.store}`, wide: true, body: `<p>Paste these into WooCommerce → Settings → Payments → Digital Hub Payments. The secrets are shown <b>once</b>.</p>${kv([['Digital Hub URL', `<span class="mono">${esc(s.digital_hub_url)}</span>`], ['Test mode', s.test_mode ? 'yes' : 'no'], [s.test_mode ? 'Test secret key' : 'Live secret key', `<div class="secret">${esc(s.secret_key)}</div>`], ['Webhook signing secret', `<div class="secret">${esc(s.webhook_secret)}</div>`]])}`,
    foot: `<button class="btn" data-act="copy" data-text="${esc(s.secret_key)}">Copy key</button><button class="btn" data-act="copy" data-text="${esc(s.webhook_secret)}">Copy webhook secret</button><button class="btn primary" data-act="closeModal">Done</button>` }); render(); };
ACT.wooHookDel = d => confirmBox('Delete webhook?', 'The store stops receiving payment updates.', 'Delete', () => cx('POST', `/woocommerce/webhooks/${d.id}/delete`));
ACT.wooKeyRevoke = d => confirmBox('Revoke key?', 'The store can no longer create checkouts with it.', 'Revoke', () => cx('POST', `/woocommerce/keys/${d.id}/revoke`));

/* ================= Settlements ================= */
VIEWS.settlements = async () => {
  const s = await cx('GET', '/settlements'), sm = s.summary, prov = s.providers;
  App.cache.settlements = s;
  const reconciledFree = s.settlements.filter(x => x.status === 'reconciled' && ['not_requested', 'failed'].includes(x.conversion_status));
  return head('Settlement', 'Settlements', 'Authorize.Net settles card batches to your bank in USD. Reconcile each batch with the bank deposit, then record the USD → USDC conversion.',
      `${can('payouts.execute') ? '<button class="btn" data-act="syncBatches">Sync settled batches</button>' : ''}${reconciledFree.length && can('payouts.approve') ? '<button class="btn primary" data-act="newConversion">Record conversion</button>' : ''}`)
    + `<div class="grid g4">${kpi('Acquirer receivable', usd(sm.acquirer_receivable), 'captured, not yet settled')}${kpi('Bank clearing', usd(sm.bank_clearing), 'settled, awaiting bank match')}${kpi('Bank', usd(sm.bank), 'reconciled deposits')}${kpi('In conversion', usd(sm.in_conversion), fmt(sm.usdc_in_transit, 'USDC') + ' in transit')}</div>`
    + `<div class="card"><div class="card-head"><h2>USD settlements (Authorize.Net batches)</h2><span class="faint">${sm.last_sync ? 'Last sync ' + fmtDT(sm.last_sync.at) : 'Never synced'}</span></div>
      ${table([{ h: 'Settled', v: x => fmtDT(x.settled_at) }, { h: 'Batch', v: x => `<span class="mono">${esc(x.batch_id)}</span>` }, { h: 'Charges', r: 1, v: x => `${usd(x.charge_amount)}<div class="faint">${x.charge_count}</div>` }, { h: 'Refunds', r: 1, v: x => `${usd(x.refund_amount)}<div class="faint">${x.refund_count}</div>` }, { h: 'Net', r: 1, v: x => usd(x.net) },
        { h: 'USD', v: x => badge(x.status) + (x.unmatched.length ? `<div class="faint">${x.unmatched.length} not from Digital Hub</div>` : '') }, { h: 'Bank', v: x => x.bank ? `${usd(x.bank.amount)}<div class="faint">${esc(x.bank.reference)}${x.bank.difference ? ' · fees ' + usd(x.bank.difference) : ''}</div>` : '—' }, { h: 'Conversion', v: x => badge(x.conversion_status) }, { h: 'USDC payout', v: x => badge(x.payout_status) },
        { h: '', v: x => x.status === 'settled' && can('payouts.execute') ? `<button class="btn sm" data-act="reconcile" data-id="${x.id}" data-net="${x.net}">Reconcile</button>` : '' }], s.settlements, { empty: 'No settled batches yet. Authorize.Net settles once a day; click “Sync settled batches” afterwards.' })}</div>`
    + `<div class="card"><div class="card-head"><h2>Conversions (USD → USDC)</h2><span class="tag">Mode ${esc(s.settlement_mode.mode)} · ${esc(s.settlement_mode.provider)}</span></div>
      ${table([{ h: 'Created', v: c => fmtDT(c.created_at) }, { h: 'Venue', v: c => esc(c.venue || '—') }, { h: 'USD', r: 1, v: c => usd(c.usd_amount) }, { h: 'USDC', r: 1, v: c => c.usdc_amount ? fmt(c.usdc_amount, 'USDC') : '—' }, { h: 'Status', v: c => badge(c.status) },
        { h: '', v: c => !can('payouts.execute') ? '' : c.status === 'pending' ? `<button class="btn sm" data-act="convStep" data-id="${c.id}" data-step="processing">USD sent</button><button class="btn sm ghost" data-act="convStep" data-id="${c.id}" data-step="failed">Failed</button>` : c.status === 'processing' ? `<button class="btn sm primary" data-act="convStep" data-id="${c.id}" data-step="completed">USDC obtained</button><button class="btn sm ghost" data-act="convStep" data-id="${c.id}" data-step="failed">Failed</button>` : c.status === 'completed' ? '<a class="btn sm" href="#/transfers">Track payout</a>' : '' }], s.conversions, { empty: 'No conversions yet.' })}</div>`
    + `<div class="card stack"><h2>Settlement providers</h2><p class="muted">Mode A (manual reconciliation) is active. Mode B adapters can be switched on only after a provider has approved your account and its adapter is implemented and tested against the provider’s sandbox. No provider API is called by this build.</p>
      ${table([{ h: 'Provider', v: p => `<b>${esc(p.name)}</b><div class="faint">${esc(p.description)}</div>` }, { h: 'Mode', v: p => p.mode }, { h: 'Status', v: p => p.active ? badge('active') : badge(p.integrated ? 'enabled' : 'pending', p.integrated ? 'available' : 'not integrated') }, { h: 'Approval on file', v: p => p.approval ? `${esc(p.approval.reference)} <span class="faint">${fmtDate(p.approval.at)}</span>` : '—' }, { h: 'Docs', v: p => p.docs ? `<a href="${esc(p.docs)}" target="_blank" rel="noopener">API reference</a>` : '' }], prov)}</div>`;
};
ACT.syncBatches = () => run(async () => { const r = await cx('POST', '/settlements/sync', {}); toast(`${r.batches} batch(es) found · ${r.created} new${r.unmatched ? ` · ${r.unmatched} transaction(s) not from Digital Hub` : ''}`); }, {});
ACT.reconcile = d => formModal('Reconcile with bank deposit', 'reconcile', note('info', '', `Batch net ${usd(+d.net)}. Enter the deposit exactly as it appears on your bank statement. A difference (for example processor fees withheld) needs a note and is booked as processing fees.`)
  + `<div class="form-grid">${field('Deposit amount (USD)', input('bank_amount', { req: true, value: (+d.net / 100).toFixed(2), extra: 'inputmode="decimal"' }))}${field('Deposit date', input('bank_date', { type: 'date' }))}</div>${field('Bank reference', input('reference', { req: true, ph: 'statement line / transfer ID' }))}${field('Note', input('note', { ph: 'required if the amount differs' }))}`, 'Reconcile', { data: { id: d.id } });
FORM.reconcile = async (f, form) => { await cx('POST', `/settlements/${form.dataset.id}/reconcile`, f); closeModal(); toast('Reconciled'); render(); };
ACT.newConversion = () => { const rows = App.cache.settlements.settlements.filter(x => x.status === 'reconciled' && ['not_requested', 'failed'].includes(x.conversion_status));
  formModal('Record a USD → USDC conversion (Mode A)', 'newConversion', note('info', '', 'You convert at your own bank / exchange. Digital Hub records each step and later verifies the USDC arriving in your MetaMask wallet on Base.')
    + `<div class="stack">${rows.map(x => `<label class="row"><input type="checkbox" name="settlement_ids" value="${x.id}" data-multi checked> Batch <span class="mono">${esc(x.batch_id)}</span> · ${usd(x.bank.amount)} deposited</label>`).join('')}</div>`
    + `<div class="form-grid">${field('USD to convert', input('usd_amount', { ph: 'all deposited', extra: 'inputmode="decimal"' }))}${field('Venue', input('venue', { ph: 'e.g. exchange or OTC desk' }))}</div>${field('Note', input('note'))}`, 'Create'); };
FORM.newConversion = async f => { await cx('POST', '/conversions', f); closeModal(); toast('Conversion recorded (pending)'); render(); };
ACT.convStep = d => {
  const body = d.step === 'processing' ? field('Bank transfer reference (USD sent)', input('reference', { req: true }))
    : d.step === 'completed' ? `<div class="form-grid">${field('USDC obtained', input('usdc_amount', { req: true, extra: 'inputmode="decimal"' }))}${field('Trade reference', input('reference'))}</div>`
    : field('Reason', input('reason', { req: true }));
  formModal({ processing: 'USD sent for conversion', completed: 'USDC obtained', failed: 'Mark conversion failed' }[d.step], 'convStep', body, 'Save', { data: { id: d.id, step: d.step } });
};
FORM.convStep = async (f, form) => { await cx('POST', `/conversions/${form.dataset.id}/${form.dataset.step}`, f); closeModal(); toast('Conversion updated'); render(); };

/* ================= Crypto wallet ================= */
VIEWS.wallet = async () => {
  const w = await cx('GET', '/wallet'); App.cache.chain = w.chain;
  return head('Settlement', 'Crypto wallet', 'Your MetaMask wallet receives USDC payouts on Base. You prove ownership by signing a free message — no transaction, no approval, no fees.', can('destinations.review') ? '<button class="btn primary" data-act="walletAdd">Add wallet</button>' : '')
    + note('ok', 'Your keys stay with you', esc(w.note))
    + table([{ h: 'Wallet', v: x => `<b>${esc(x.label)}</b><div class="mono">${esc(x.address)}</div>` }, { h: 'Status', v: x => badge(x.status) }, { h: 'Receives', v: x => [x.receiving_test && badge('test', 'Base Sepolia'), x.receiving_live && badge('live', 'Base Mainnet')].filter(Boolean).join(' ') || '—' }, { h: 'Verified', v: x => fmtDT(x.verified_at) },
      { h: '', v: x => can('destinations.review') ? [x.status === 'pending_signature' && `<button class="btn sm primary" data-act="walletVerify" data-id="${x.id}">Verify with MetaMask</button>`, x.status === 'verified' && `<button class="btn sm" data-act="walletApprove" data-id="${x.id}" data-addr="${esc(x.address)}">Approve for mainnet</button>`, ['verified', 'approved'].includes(x.status) && !x.receiving_test && `<button class="btn sm" data-act="walletRecv" data-id="${x.id}" data-mode="test">Use for test</button>`, x.status === 'approved' && !x.receiving_live && `<button class="btn sm" data-act="walletRecv" data-id="${x.id}" data-mode="live">Use for live</button>`, `<a class="btn sm ghost" href="${esc(x.explorer[App.mode])}" target="_blank" rel="noopener">Explorer</a>`, `<button class="btn sm ghost" data-act="walletRemove" data-id="${x.id}">Remove</button>`].filter(Boolean).join('') : '' }],
      w.wallets, { empty: 'No wallet yet. Add your MetaMask address and sign to prove you control it.' })
    + `<div class="grid g2">${kpi('USDC confirmed in your wallet', fmt(w.balances.usdc_wallet, 'USDC'), 'verified payouts (ledger)', true)}${kpi('USDC in transit', fmt(w.balances.usdc_in_transit, 'USDC'), 'converted, payout not yet confirmed')}</div>`;
};
ACT.walletAdd = () => formModal('Add your MetaMask wallet', 'walletAdd', field('Address', `<div class="row"><input name="address" id="w-addr" required placeholder="0x…" spellcheck="false" style="flex:1"><button class="btn" type="button" data-act="walletFromMM">From MetaMask</button></div>`, 'Public address only. Never enter a private key or seed phrase anywhere.') + field('Label', input('label', { ph: 'Treasury MetaMask' })), 'Add');
ACT.walletFromMM = () => run(async () => { try { const w = await DHMetaMask.connect(App.cache.chain); $('#w-addr').value = w.account; } catch (e) { throw new Error(DHMetaMask.message(e)); } }, { noRefresh: true });
FORM.walletAdd = async f => { await cx('POST', '/wallet', f); closeModal(); toast('Added. Now verify it with MetaMask.'); render(); };
ACT.walletVerify = d => run(async () => {
  const ch = await cx('POST', `/wallet/${d.id}/challenge`);
  let w, signature;
  try { w = await DHMetaMask.connect(ch.chain); if (!DHMetaMask.same(w.account, ch.address)) throw new Error(`MetaMask is on ${short(w.account, 8, 6)}. Select ${short(ch.address, 8, 6)} and try again.`); signature = await DHMetaMask.sign(w.provider, w.account, ch.message); }
  catch (e) { throw new Error(e.message?.startsWith('MetaMask is on') ? e.message : DHMetaMask.message(e)); }
  await cx('POST', `/wallet/${d.id}/verify`, { signature });
}, { ok: 'Wallet ownership verified' });
ACT.walletApprove = d => formModal('Approve wallet for Base Mainnet', 'walletApprove', note('warn', '', `Live USDC payouts will be tracked to <span class="mono">${esc(d.addr)}</span>. Check it character by character in MetaMask.`) + field(`Type the last 6 characters (${esc(d.addr.slice(-6))})`, input('confirm', { req: true, extra: 'maxlength="6" spellcheck="false"' })) + codeField(), 'Approve', { data: { id: d.id } });
FORM.walletApprove = async (f, form) => { await cx('POST', `/wallet/${form.dataset.id}/approve`, f); closeModal(); toast('Wallet approved'); render(); };
ACT.walletRecv = d => run(() => cx('POST', `/wallet/${d.id}/receiving`, { mode: d.mode }), { ok: 'Receiving wallet updated' });
ACT.walletRemove = d => confirmBox('Remove wallet?', 'It will no longer receive tracked payouts.', 'Remove', () => cx('POST', `/wallet/${d.id}/remove`));

/* ================= Infura & Blockchain ================= */
VIEWS.infura = async () => {
  const c = await api('GET', '/a-api/chain'), inf = c.infura || {};
  const net = (k, n) => `<div class="card stack"><div class="card-head" style="margin:0"><h2>${esc(n.chainName)} <span class="faint">(${n.chainId})</span></h2>${badge(n.enabled ? 'enabled' : 'disabled', n.enabled ? 'on' : 'off')}</div>
    ${kv([['USDC contract', `<span class="mono">${esc(n.usdc)}</span>${n.usdc_pinned ? ' <span class="tag">pinned</span>' : ''}`], ['Token check', n.token ? badge(n.token.ok ? 'pass' : 'fail', n.token.ok ? `${n.token.symbol || 'USDC'} · ${n.token.decimals} dp` : 'failed') : '<span class="faint">not run</span>'], ['Finality', `${n.confirmations} confirmations · ${esc(n.finality)}`], ['RPC source', esc(n.rpc_source || '—')], ['Endpoints', (n.rpcs || []).map(r => `<div class="mono faint">${esc(r.url || r.label || '')} ${r.ok === false ? '✗' : r.ok ? '✓' : ''}${r.ms ? ' ' + r.ms + ' ms' : ''}</div>`).join('') || '—'], ['Monitor', n.monitor?.at ? `head ${n.monitor.head || '—'} · ${fmtDT(n.monitor.at)}` : '—']])}
    ${can('platform.settings') ? `<button class="btn sm" data-act="chainProbe" data-key="${k}">Test RPC + token</button>` : ''}</div>`;
  return head('Settlement', 'Infura & Blockchain', 'Base Sepolia (84532) for testing, Base Mainnet (8453) for production. Used to verify USDC payouts into your wallet. Keys stay on the server.')
    + `<div class="card stack"><div class="card-head" style="margin:0"><h2>Infura</h2>${badge(inf.configured ? 'enabled' : 'pending', inf.configured ? 'connected' : 'not connected')}</div>
      ${kv([['Source', esc(inf.source || '—')], ['Key', inf.key ? `<span class="mono">${esc(inf.key)}</span>` : '—']])}
      <div class="row">${can('platform.settings') && inf.source !== 'environment' ? `<button class="btn primary" data-act="infuraKey">${inf.configured ? 'Replace key' : 'Connect Infura'}</button>${inf.configured ? '<button class="btn ghost" data-act="infuraRemove">Remove</button>' : ''}` : ''}</div>
      <p class="faint">developer.metamask.io → Infura → API keys → copy the key (32 hex characters). It is tested against Base, encrypted and never sent to the browser. Public Base RPC stays as failover.</p></div>`
    + `<div class="grid g2">${Object.entries(c.networks).map(([k, n]) => net(k, n)).join('')}</div>`
    + `<div class="card stack"><h2>Base Mainnet</h2><p class="muted">Platform mode: <b>${esc(c.platform_mode)}</b>. Mainnet is switched on only when the production checks pass (LIVE_PAYMENTS, HTTPS, encryption key, 2FA…).</p>${can('platform.settings') ? `<div class="row">${c.platform_mode === 'live' ? '<button class="btn ghost" data-act="chainMode" data-mode="sandbox">Switch mainnet off</button>' : '<button class="btn" data-act="chainMode" data-mode="live">Enable Base Mainnet</button>'}</div>` : ''}</div>`;
};
ACT.infuraKey = () => formModal('Connect Infura', 'infuraKey', field('Infura API key', input('api_key', { req: true, extra: 'spellcheck="false" autocomplete="off"' })) + field('API key secret (optional)', input('api_secret', { type: 'password', extra: 'autocomplete="new-password"' }), 'Only if “Require API key secret” is on in Infura.'), 'Test and save');
FORM.infuraKey = async f => { await api('POST', '/a-api/chain/infura', f); closeModal(); toast('Infura connected'); render(); };
ACT.infuraRemove = () => confirmBox('Remove Infura key?', 'Verification falls back to public Base endpoints.', 'Remove', () => api('POST', '/a-api/chain/infura', { remove: true }));
ACT.chainProbe = d => run(() => api('POST', `/a-api/chain/probe/${d.key}`), { ok: 'Checked' });
ACT.chainMode = d => confirmBox(d.mode === 'live' ? 'Enable Base Mainnet?' : 'Switch Base Mainnet off?', d.mode === 'live' ? 'Real USDC payouts can then be verified on mainnet. Every production check must pass.' : 'Mainnet verification stops.', 'Continue', () => api('POST', '/a-api/chain/mode', { mode: d.mode }), d.mode !== 'live');

/* ================= USDC transfers ================= */
VIEWS.transfers = async () => {
  const r = await cx('GET', '/payouts'), live = r.payouts.some(p => p.status === 'submitted');
  return head('Settlement', 'USDC transfers', 'USDC withdrawn from your conversion venue to your MetaMask wallet. Paste the transaction hash: Digital Hub checks chain, USDC contract, recipient, exact amount and finality. It never signs or sends anything.', liveIf(live, 8000))
    + (r.wallet ? note('info', 'Receiving wallet', `<span class="mono">${esc(r.wallet.address)}</span> · ${esc(r.wallet.label)}`) : note('warn', 'No wallet', 'Add and verify your MetaMask wallet first (Crypto Wallet).'))
    + (r.ready.length && can('payouts.approve') ? `<div class="card"><div class="card-head"><h2>Conversions ready for payout</h2></div>${table([{ h: 'Completed', v: c => fmtDT(c.steps.at(-1).at) }, { h: 'Venue', v: c => esc(c.venue || '—') }, { h: 'USDC obtained', r: 1, v: c => fmt(c.usdc_amount, 'USDC') }, { h: '', v: c => `<button class="btn sm primary" data-act="payoutNew" data-id="${c.id}" data-max="${c.usdc_amount}">Track payout</button>` }], r.ready)}</div>` : '')
    + table([{ h: 'Created', v: p => fmtDT(p.created_at) }, { h: 'Network', v: p => esc(p.network_name) }, { h: 'Recipient', v: p => `<span class="mono">${esc(short(p.recipient, 8, 6))}</span>` }, { h: 'Transaction', v: p => p.tx ? `<a class="mono" href="${esc(p.explorer)}" target="_blank" rel="noopener">${esc(short(p.tx.hash, 10, 6))}</a>` : '—' },
      { h: 'Status', v: p => badge(p.status) + (p.result?.reason ? `<div class="faint">${esc(p.result.reason)}</div>` : p.result?.confirmations ? `<div class="faint">${p.result.confirmations}/${p.result.required || '?'} confirmations</div>` : '') }, { h: 'Amount', r: 1, v: p => fmt(p.amount, 'USDC') },
      { h: '', v: p => !can('payouts.execute') ? '' : p.status === 'pending' ? `<button class="btn sm primary" data-act="payoutTx" data-id="${p.id}">Enter tx hash</button><button class="btn sm ghost" data-act="payoutFail" data-id="${p.id}">Failed</button>` : p.status === 'submitted' ? `<button class="btn sm" data-act="payoutCheck" data-id="${p.id}">Check now</button>` : '' }],
      r.payouts, { empty: 'No USDC payouts tracked yet.' });
};
ACT.payoutNew = d => formModal('Track USDC payout', 'payoutNew', note('info', '', 'Enter the exact USDC amount that will arrive (after the venue’s withdrawal fee). The payout is confirmed only if the on-chain amount matches exactly.') + field('USDC amount', input('amount', { req: true, value: (+d.max / 100).toFixed(2), extra: 'inputmode="decimal"' })) + field('Note', input('note')), 'Create', { data: { id: d.id } });
FORM.payoutNew = async (f, form) => { await cx('POST', '/payouts', { ...f, conversion_id: form.dataset.id }); closeModal(); toast('Payout created — enter the transaction hash once the withdrawal is sent'); render(); };
ACT.payoutTx = d => formModal('Transaction hash', 'payoutTx', field('Base transaction hash', input('hash', { req: true, ph: '0x…', extra: 'spellcheck="false"' }), 'From your exchange’s withdrawal details or BaseScan.'), 'Verify', { data: { id: d.id } });
FORM.payoutTx = async (f, form) => { const r = await cx('POST', `/payouts/${form.dataset.id}/tx`, f); closeModal(); toast(r.status === 'confirmed' ? 'Confirmed on Base' : r.status === 'failed' ? 'Rejected: ' + (r.result?.reason || '') : 'Submitted — waiting for confirmations', r.status === 'failed' ? 'err' : ''); render(); };
ACT.payoutCheck = d => run(() => cx('POST', `/payouts/${d.id}/check`), { ok: 'Checked on Base' });
ACT.payoutFail = d => formModal('Mark payout failed', 'payoutFail', field('Reason', input('reason', { req: true })), 'Mark failed', { data: { id: d.id } });
FORM.payoutFail = async (f, form) => { await cx('POST', `/payouts/${form.dataset.id}/fail`, f); closeModal(); render(); };

/* ================= Refunds & disputes ================= */
VIEWS.refunds = async () => {
  const r = await cx('GET', '/refunds'), t = tab('rd', 'refunds');
  return head('Operations', 'Refunds & disputes', 'Refund or void from a card transaction. Chargebacks are recorded from your processor’s notice.')
    + tabs('rd', [['refunds', `Refunds (${r.refunds.length})`], ['disputes', `Chargebacks (${r.disputes.length})`]], 'refunds')
    + (t === 'refunds' ? table([{ h: 'When', v: x => fmtDT(x.created_at) }, { h: 'Invoice', v: x => `<span class="mono">${esc(x.invoice || '—')}</span>` }, { h: 'Customer', v: x => esc(x.customer || '—') }, { h: 'Authorize.Net', v: x => `<span class="mono">${esc(x.anet_trans_id || '—')}</span>` }, { h: 'Reason', v: x => esc(x.reason || '—') }, { h: 'Status', v: x => badge(x.status) + (x.settlement_status ? ' ' + badge(x.settlement_status, 'USD ' + x.settlement_status) : '') }, { h: 'Amount', r: 1, v: x => usd(x.amount) }], r.refunds, { empty: 'No refunds.', rowAttr: x => `class="click" data-act="tx" data-id="${x.payment_id}"` })
      : table([{ h: 'When', v: x => fmtDT(x.created_at) }, { h: 'Invoice', v: x => `<span class="mono">${esc(x.invoice || '—')}</span>` }, { h: 'Reference', v: x => esc(x.reference || '—') }, { h: 'Reason', v: x => esc(x.reason || '—') }, { h: 'Status', v: x => badge(x.status) }, { h: 'Amount', r: 1, v: x => usd(x.amount) }, { h: '', v: x => x.status === 'open' && can('payments.manage') ? `<button class="btn sm" data-act="dispResolve" data-id="${x.id}" data-won="1">Won</button><button class="btn sm ghost" data-act="dispResolve" data-id="${x.id}" data-won="">Lost</button>` : '' }], r.disputes, { empty: 'No chargebacks.' }));
};
ACT.dispResolve = d => formModal(d.won ? 'Chargeback won' : 'Chargeback lost', 'dispResolve', field('Note', input('note', { ph: 'outcome details' })), 'Save', { data: { id: d.id, won: d.won } });
FORM.dispResolve = async (f, form) => { await cx('POST', `/disputes/${form.dataset.id}/resolve`, { ...f, won: !!form.dataset.won }); closeModal(); render(); };

/* ================= Webhook logs ================= */
VIEWS.webhooks = async () => {
  const r = await cx('GET', '/webhook-logs'), t = tab('wl', 'in');
  return head('Operations', 'Webhook logs', 'Inbound: Authorize.Net notifications (signature verified, then re-checked by API lookup). Outbound: signed events sent to your WooCommerce store.')
    + tabs('wl', [['in', 'Inbound (Authorize.Net)'], ['out', 'Outbound (WooCommerce)']], 'in')
    + (t === 'in' ? table([{ h: 'Received', v: e => fmtDT(e.at) }, { h: 'Event', v: e => `<span class="mono">${esc(e.type)}</span>` }, { h: 'Env', v: e => esc(e.env || '—') }, { h: 'Signature', v: e => badge(e.signature === 'verified' ? 'verified' : 'rejected', e.signature) }, { h: 'Result', v: e => badge(e.status) + (e.error ? `<div class="faint">${esc(e.error)}</div>` : '') }, { h: 'Transaction', v: e => `<span class="mono">${esc(e.trans_id || '—')}</span>` }, { h: 'Payment', v: e => e.payment ? `<a data-act="tx" data-id="${e.payment}">open</a>` : '—' }], r.inbound, { empty: 'No inbound webhooks yet.' })
      : table([{ h: 'Created', v: d => fmtDT(d.at) }, { h: 'Event', v: d => `<span class="mono">${esc(d.type)}</span>` }, { h: 'URL', v: d => `<span class="mono faint">${esc(short(d.url, 28, 14))}</span>` }, { h: 'Status', v: d => badge(d.status) + (d.error ? `<div class="faint">${esc(d.error)}</div>` : '') }, { h: 'Attempts', r: 1, v: d => d.attempts }, { h: 'HTTP', v: d => esc(d.code || '—') }, { h: '', v: d => ['failed', 'retrying'].includes(d.status) && can('platform.settings') ? `<button class="btn sm" data-act="whRetry" data-id="${d.id}">Retry</button>` : '' }], r.outbound, { empty: 'No outbound events yet.' }));
};
ACT.whRetry = d => run(() => cx('POST', `/webhook-logs/${d.id}/retry`), { ok: 'Queued for retry' });

/* ================= Reports ================= */
VIEWS.reports = async () => {
  const f = App.filters.rep || {}, r = await cx('GET', '/reports' + qs({ from: f.from, to: f.to })), t = r.totals;
  const csv = '/api/v1/admin/reports/transactions.csv' + qs({ mode: App.mode, from: f.from, to: f.to });
  return head('Operations', 'Reports & analytics', `${fmtDate(r.from)} – ${fmtDate(r.to - 1)}`, `<a class="btn" href="${esc(csv)}">Download CSV</a>`)
    + `<div class="filters">${field('From', `<input type="date" data-filter="rep.from" value="${esc(f.from || '')}">`)}${field('To', `<input type="date" data-filter="rep.to" value="${esc(f.to || '')}">`)}</div>`
    + `<div class="grid g4">${kpi('Captured', usd(t.captured), `${t.transactions} transactions`, true)}${kpi('Refunded', usd(t.refunded))}${kpi('Net', usd(t.net))}${kpi('Approval rate', t.approval_rate == null ? '—' : t.approval_rate + '%', 'of attempts that reached the processor')}</div>`
    + `<div class="grid g2"><div class="card"><div class="card-head"><h2>By card status</h2></div>${table([{ h: 'Status', v: x => badge(x[0]) }, { h: 'Count', r: 1, v: x => x[1] }], Object.entries(r.by_status), { empty: 'No data.' })}</div>
      <div class="card"><div class="card-head"><h2>Settlements in range</h2></div>${table([{ h: 'Batch', v: x => `<span class="mono">${esc(x.batch)}</span>` }, { h: 'USD', v: x => badge(x.status) }, { h: 'Conversion', v: x => badge(x.conversion) }, { h: 'Payout', v: x => badge(x.payout) }, { h: 'Net', r: 1, v: x => usd(x.net) }], r.settlements, { empty: 'None.' })}</div></div>`
    + `<div class="card"><div class="card-head"><h2>Daily</h2></div>${table([{ h: 'Date', v: d => esc(d.date) }, { h: 'Transactions', r: 1, v: d => d.count }, { h: 'Declined', r: 1, v: d => d.declined }, { h: 'Captured', r: 1, v: d => usd(d.captured) }, { h: 'Refunded', r: 1, v: d => usd(d.refunded) }], r.daily, { empty: 'No transactions in range.' })}</div>`
    + `<div class="card"><div class="card-head"><h2>Ledger (double entry)</h2><span class="faint">${r.trial_balance.map(b => `${b.currency}: debits ${fmt(b.debits, b.currency)} = credits ${fmt(b.credits, b.currency)}`).join(' · ')}</span></div>${table([{ h: 'Account', v: a => esc(a.account.replace(/_/g, ' ')) }, { h: 'Currency', v: a => esc(a.currency) }, { h: 'Balance (debit +)', r: 1, v: a => fmt(a.total, a.currency) }], r.ledger, { empty: 'No entries.' })}</div>`;
};

/* ================= Security & audit ================= */
VIEWS.security = async () => {
  const f = App.filters.sec || {}, r = await cx('GET', '/security' + qs({ q: f.q })), t = tab('sec', 'audit');
  return head('Operations', 'Security & audit logs', 'Every change is recorded with who, what and when.')
    + `<div class="grid g4">${kpi('Two-factor', esc(r.policy.mfa))}${kpi('Staff with 2FA', `${r.staff.filter(s => s.mfa_enabled).length}/${r.staff.length}`)}${kpi('Rejected webhooks', r.rejected_webhooks, 'bad or missing signatures')}${kpi('Session', r.policy.session_hours + ' h', esc(r.policy.login_lockout))}</div>`
    + tabs('sec', [['audit', 'Audit log'], ['staff', 'Staff'], ['policy', 'Policy']], 'audit')
    + (t === 'audit' ? `<div class="filters">${fInput('sec', 'q', 'Search', 'actor, action, target')}</div>` + table([{ h: 'When', v: a => fmtDT(a.created_at) }, { h: 'Actor', v: a => esc(a.actor) }, { h: 'Action', v: a => `<span class="mono">${esc(a.action)}</span>` }, { h: 'Target', v: a => `<span class="mono faint">${esc(short(a.target, 14, 6))}</span>` }, { h: 'Detail', v: a => esc(a.detail) }], r.audit, { empty: 'No entries.' })
      : t === 'staff' ? table([{ h: 'Name', v: s => `${esc(s.name)}<div class="faint">${esc(s.email)}</div>` }, { h: 'Role', v: s => esc(s.role.replace(/_/g, ' ')) }, { h: '2FA', v: s => badge(s.mfa_enabled ? 'enabled' : 'pending', s.mfa_enabled ? 'on' : 'off') }, { h: 'Status', v: s => badge(s.status) }, { h: 'Last sign-in', v: s => fmtDT(s.last_login) }], r.staff)
      : `<div class="card">${kv(Object.entries(r.policy).map(([k, v]) => [k.replace(/_/g, ' '), esc(String(v))]))}</div>`);
};

/* ================= Settings (incl. production readiness, backup) ================= */
VIEWS.settings = async () => {
  const t = tab('set', 'business');
  const top = head('Operations', 'Settings', '', '') + tabs('set', [['business', 'Business'], ['readiness', 'Production readiness'], ['data', 'Backup & data'], ['platform', 'Platform']], 'business');
  if (t === 'readiness') {
    const r = await cx('GET', '/readiness'), groups = [...new Set(r.checks.map(c => c.group))];
    return top + note(r.ready_cards ? 'ok' : 'warn', r.ready_cards ? 'Ready for live card payments' : 'Not ready for live payments', 'Live card payments and live USDC payouts are OFF by default and can be switched on only when every required check passes.')
      + groups.map(g => `<div class="card"><div class="card-head"><h2>${esc(g)}</h2></div>${r.checks.filter(c => c.group === g).map(c => `<div class="check ${c.ok ? 'ok' : c.required ? '' : 'opt'}"><span class="dot"></span><div><b>${esc(c.label)}</b>${c.required ? '' : ' <span class="tag">payouts only</span>'}<div class="faint">${esc(c.detail || '')}</div></div></div>`).join('')}</div>`).join('')
      + (can('platform.settings') ? `<div class="card stack"><h2>Live switches</h2>${kv([['Live card payments', badge(r.state.cardsLive ? 'live' : 'test', r.state.cardsLive ? 'ON' : 'off')], ['Live USDC payouts', badge(r.state.payoutsLive ? 'live' : 'test', r.state.payoutsLive ? 'ON' : 'off')]])}
        <div class="row"><button class="btn ${r.state.cardsLive ? 'ghost' : 'primary'}" data-act="liveSwitch" data-key="cards_live" data-on="${r.state.cardsLive ? '' : '1'}" ${!r.ready_cards && !r.state.cardsLive ? 'disabled' : ''}>${r.state.cardsLive ? 'Turn live cards off' : 'Enable live cards'}</button><button class="btn ${r.state.payoutsLive ? 'ghost' : ''}" data-act="liveSwitch" data-key="payouts_live" data-on="${r.state.payoutsLive ? '' : '1'}" ${!r.ready_payouts && !r.state.payoutsLive ? 'disabled' : ''}>${r.state.payoutsLive ? 'Turn live payouts off' : 'Enable live payouts'}</button></div></div>` : '');
  }
  const s = await cx('GET', '/settings');
  if (t === 'data') return top + `<div class="grid g2"><div class="card stack"><h2>Backup</h2><p class="muted">Full export (gzipped JSON): every record, the append-only ledger and settings. Secrets stay encrypted. Take one before any migration.</p>${s.backup ? kv([['Last backup', fmtDT(s.backup.at)], ['By', esc(s.backup.by)], ['Size', fileSize(s.backup.bytes)]]) : '<p class="faint">No backup yet.</p>'}${can('platform.settings') ? `<a class="btn primary" href="/api/v1/admin/backup?mode=${App.mode}">Download backup</a>` : ''}<p class="faint">Command line: <span class="mono">npm run backup</span></p></div>
      <div class="card stack"><h2>Single-business migration</h2>${s.migration ? kv([['Migrated', fmtDT(s.migration.at)], ['Retired merchant records', String((s.migration.retired_merchants || []).length)], ['Note', esc(s.migration.note)]]) : '<p class="faint">—</p>'}<p class="faint">No historical record was deleted. MULTI_MERCHANT=1 restores the multi-merchant platform.</p></div></div>`
    + (s.adopt_candidates.length ? `<div class="card stack"><h2>Existing store connections</h2><p class="muted">These retired records still have API keys or webhooks (for example a WooCommerce store connected before the redesign). Adopt one as the business to keep that store working without reinstalling the plugin.</p>${table([{ h: 'Record', v: c => `${esc(c.name)}<div class="faint mono">${esc(c.id)}</div>` }, { h: 'Keys', r: 1, v: c => c.keys }, { h: 'Webhooks', r: 1, v: c => c.webhooks }, { h: '', v: c => can('platform.settings') ? `<button class="btn sm" data-act="adopt" data-id="${c.id}" data-name="${esc(c.name)}">Adopt as business</button>` : '' }], s.adopt_candidates)}</div>` : '');
  if (t === 'platform') return top + `<div class="card">${kv([['Product', esc(s.platform.product)], ['Public URL', `<span class="mono">${esc(s.platform.public_url)}</span>`], ['Two-factor', s.platform.require_staff_mfa ? badge('enabled', 'mandatory') : badge('pending', 'optional (REQUIRE_STAFF_MFA=0)')], ['LIVE_PAYMENTS', badge(s.platform.live_payments ? 'live' : 'test', s.platform.live_payments ? 'on' : 'off')], ['Card flow', esc(s.platform.anet_flow)], ['Multi-merchant', 'off (MULTI_MERCHANT=0)'], ['Retired merchant records', String(s.retired_merchants)]])}</div>`;
  const b = s.business;
  return top + `<form class="card stack" data-form="business"><h2>Business profile</h2><p class="muted">Shown to customers on the checkout and on the Authorize.Net payment page.</p>
    <div class="form-grid">${field('Business name', input('name', { req: true, value: b.name }))}${field('Legal name', input('legal_name', { value: b.legal_name }))}${field('Support email', input('support_email', { type: 'email', value: b.support_email }))}${field('Website', input('website', { value: b.website }))}${field('Statement descriptor', input('descriptor', { value: b.descriptor, extra: 'maxlength="22"' }), 'Max 22 characters.')}${field('Country', input('country', { value: b.country, extra: 'maxlength="2"' }))}</div>
    <div class="err" id="formErr"></div>${can('platform.settings') ? '<button class="btn primary" type="submit">Save</button>' : ''}</form>`;
};
FORM.business = async f => { await cx('PATCH', '/settings/business', f); toast('Saved'); render(); };
ACT.liveSwitch = d => formModal(d.on ? 'Enable live mode' : 'Turn off', 'liveSwitch', (d.on ? note('warn', 'Real money', d.key === 'cards_live' ? 'Customers will be charged real cards through Authorize.Net production.' : 'USDC payouts will be tracked on Base Mainnet.') : '') + codeField(), d.on ? 'Enable' : 'Turn off', { data: { key: d.key, on: d.on } });
FORM.liveSwitch = async (f, form) => { await cx('POST', '/readiness', { [form.dataset.key]: !!form.dataset.on, code: f.code }); closeModal(); toast('Updated'); render(); };
ACT.adopt = d => formModal(`Adopt “${d.name}” as the business`, 'adopt', note('warn', '', 'Its API keys and webhooks become the business’s. The current business record stays as history.') + codeField(), 'Adopt', { data: { id: d.id } });
FORM.adopt = async (f, form) => { await cx('POST', '/settings/adopt', { merchant_id: form.dataset.id, code: f.code }); closeModal(); toast('Business record switched'); await loadMe(); };
