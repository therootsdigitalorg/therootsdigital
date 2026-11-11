'use strict';
/* Super Admin console — MetaMask USDC gateway on Base. */
NAV.admin = [
  ['Platform', [['a-overview', 'Overview'], ['a-merchants', 'Merchants'], ['a-payments', 'Transactions'], ['a-invoices', 'Invoices'], ['a-subscriptions', 'Subscriptions']]],
  ['Money', [['a-wallet', 'Digital Wallet'], ['a-settlements', 'Settlements'], ['a-refunds', 'Refunds'], ['a-ledger', 'Ledger & reconciliation']]],
  ['Integrations', [['a-woo', 'WooCommerce Integrations'], ['a-apilogs', 'API Logs'], ['a-webhooks', 'Webhook deliveries']]],
  ['Governance', [['a-risk', 'Risk & Security'], ['a-approvals', 'Approvals'], ['a-audit', 'Audit Trails'], ['a-staff', 'Staff & roles']]],
  ['Configuration', [['a-settings', 'MetaMask & Blockchain']]],
];
const mfaWarn = () => App.me.config.requireStaffMfa && !App.me.user.mfa_enabled ? note('danger', '2FA required', 'Enroll two-factor authentication before privileged actions. <a href="#/account">Set up 2FA →</a>') : (!App.me.user.mfa_enabled ? note('warn', '2FA recommended', 'Your account has no 2FA. Production deployments enforce it for all staff. <a href="#/account">Set up 2FA →</a>') : '');
const modeLabel = () => App.mode === 'test' ? 'Base Sepolia (test)' : 'Base mainnet (live)';
const curNet = () => App.mode === 'test' ? 'base_sepolia' : 'base';
const mono = (s, a = 8, b = 6) => `<span class="mono">${esc(short(s || '', a, b))}</span>`;

/* ---------------- overview ---------------- */
VIEWS['a-overview'] = async () => {
  const d = await api('GET', '/a-api/overview'), q = d.queues, u = d.usdc, mon = u.monitor;
  return head('Super admin', 'Platform overview', `All merchants · ${modeLabel()} · last 30 days`, liveIf(u.in_flight > 0 || u.refunds_open > 0, 10000) + (can('platform.settings') ? '<button class="btn" data-act="runMonitor">Scan chain now</button><button class="btn" data-act="runJobs">Run jobs</button>' : ''))
    + mfaWarn() + (u.platform_mode === 'live' ? '' : note('info', 'Sandbox platform', 'Only Base Sepolia is active. Base mainnet unlocks from <a href="#/a-settings">Settings → MetaMask</a> once every production check passes.'))
    + `<div class="grid g4"><div class="card kpi"><div class="label">USDC received by merchants</div><div class="value">${fmt(u.received, 'USDC')}</div><div class="sub">verified on-chain, direct to merchant wallets</div></div>
      <div class="card kpi"><div class="label">Paid invoices</div><div class="value">${u.paid}</div><div class="sub">${u.in_flight} in flight · ${u.exceptions} under/over-paid</div></div>
      <div class="card kpi"><div class="label">Platform fees</div><div class="value">${fmt(u.revenue, 'USDC')}</div><div class="sub">${fmt(u.fees_receivable, 'USDC')} still receivable</div></div>
      <div class="card kpi"><div class="label">Chain monitor</div><div class="value">${mon?.ok === false ? badge('fail', 'error') : mon?.head ? '#' + mon.head : badge('pending', 'idle')}</div><div class="sub">${esc(u.network.chainName)} (${u.network.chainId})${mon?.at ? ' · ' + fmtDT(mon.at) : ''}</div></div></div>
    ${mon?.ok === false ? note('danger', 'Monitor error', esc(mon.error)) : ''}
    <div class="split"><div class="card"><div class="card-head"><h2>Platform volume</h2><span class="faint">14 days</span></div>${barChart(d.series)}</div>
      <div class="card"><div class="card-head"><h2>Work queues</h2><a href="#/a-approvals">Approvals →</a></div>${kv([['Wallets awaiting review', `<a href="#/a-wallet">${q.wallets}</a>`], ['Refunds awaiting merchant', `<a href="#/a-refunds">${u.refunds_open}</a>`], ['KYB reviews', q.kyb], ['Ledger adjustments', q.adjustments], ['Open risk alerts', `<a href="#/a-risk">${q.alerts}</a>`], ['Merchants', `${d.merchants.approved} approved · ${d.merchants.pending} pending · ${d.merchants.suspended} suspended`], ['Reconciliation', '<a href="#/a-ledger">Run checks →</a>']])}</div></div>
    <div class="card"><div class="card-head"><h2>Latest audit events</h2><a href="#/a-audit">Audit Trails →</a></div>${auditTable(d.audit)}</div>`;
};
ACT.runJobs = () => run(() => api('POST', '/a-api/jobs/run'), { ok: 'Jobs ran: expiries, webhooks' });
ACT.runMonitor = () => run(async () => { const r = await api('POST', '/a-api/chain/monitor'); const s = r[curNet()]; if (s?.ok === false) throw new Error(s.error); }, { ok: 'Chain scanned' });

/* ---------------- merchants ---------------- */
VIEWS['a-merchants'] = async () => {
  const f = App.filters.am ||= { q: '', status: '' };
  const rows = await api('GET', '/a-api/merchants' + qs(f));
  return head('Super admin', 'Merchants', 'Verification, controls, fees, receiving wallets, API access and live activation for every merchant account.', can('merchants.manage') ? '<button class="btn primary" data-act="newMerchant">New merchant</button>' : '')
    + mfaWarn() + `<div class="card"><div class="grid g3">${fInput('am', 'q', 'Search', 'Name, website, ID, email')}${fSelect('am', 'status', 'Status', [['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['suspended', 'Suspended'], ['rejected', 'Rejected']])}<div class="field"><span>Total</span><div class="num" style="padding:8px 0">${rows.length} merchants</div></div></div></div>`
    + table([{ h: 'Merchant', v: m => `<b>${esc(m.name)}</b><div class="faint" style="font-size:.75rem">${esc(m.legal_name)} · ${esc(m.id)}</div>` }, { h: 'Country', v: m => esc(m.country) }, { h: 'Status', v: m => badge(m.status) + (m.kyb_submitted && m.status === 'pending' ? ' <span class="tag">KYB submitted</span>' : '') },
      { h: 'Risk', v: m => badge(m.risk === 'low' ? 'approved' : m.risk, m.risk) + (m.approved_with_exceptions && m.status === 'approved' ? ' <span class="tag">exceptions</span>' : '') }, { h: 'Live', v: m => m.live_enabled ? badge('active', 'live') : '<span class="faint">test only</span>' },
      { h: 'Volume 30d', r: 1, v: m => fmt(m.volume_30d_usd, 'USD') }], rows, { rowAttr: m => `class="click" tabindex="0" data-act="openMerchant" data-id="${m.id}"`, empty: 'No merchants match.' });
};
const CHECKS = [['registration', 'Registration certificate verified'], ['owners', 'Beneficial owners identified and ID-verified'], ['website', 'Website, products and refund policy reviewed'], ['sanctions', 'Sanctions / PEP screening clear'], ['bank', 'Business ownership of receiving wallet confirmed']];
const PERMS = [['crypto', 'USDC payments'], ['refunds', 'Refunds'], ['links', 'Payment links'], ['api', 'API access'], ['card', 'Card payments (disabled platform-wide)'], ['payouts', 'Payouts (legacy custodial)']];
ACT.openMerchant = d => { App.tabs.md = App.tabs.md || 'verify'; App.cache.mid = d.id; openDrawer(merchantDrawer); };
async function merchantDrawer() {
  const x = await api('GET', '/a-api/merchants/' + App.cache.mid), m = x.merchant, t = tab('md', 'verify'), dis = p => can(p) ? '' : 'disabled';
  let b = `<div class="row" style="justify-content:space-between"><div><b>${esc(m.legal_name)}</b><div class="faint mono">${esc(m.id)}</div></div><div class="row" style="gap:6px">${badge(m.status)}${m.approval?.with_exceptions && m.status === 'approved' ? badge('pending', 'with exceptions') : ''}${m.live_enabled ? badge('active', 'live') : ''}</div></div>`
    + (m.approval?.with_exceptions && m.status === 'approved' ? note('warn', 'Approved with exceptions', `${esc(m.approval.by)} · ${fmtDT(m.approval.at)} · "${esc(m.approval.reason)}"<br>Open at approval: ${m.approval.exceptions.map(esc).join('; ')}`) : '')
    + tabs('md', [['verify', 'Verification'], ['wallets', 'Wallets & live'], ['controls', 'Controls'], ['pricing', 'Fees'], ['access', 'Keys & users'], ['money', 'Accounting']], 'verify');
  const mfaLocked = App.me.config.requireStaffMfa && !App.me.user.mfa_enabled;
  if (mfaLocked) b = note('danger', 'Approval controls are locked', 'Two-factor authentication is required for staff before any approval, verification or control change. <a href="#/account">Set up 2FA now →</a> — it takes about a minute with Google Authenticator, Microsoft Authenticator or Authy, then come back to this merchant.') + b;
  if (t === 'verify') {
    const biz = m.kyb.business || {};
    b += kv([['Website', esc(m.website)], ['Support', esc(m.support_email)], ['Country', esc(m.country)], ['Joined', fmtDate(m.created_at)], ['KYB submitted', m.kyb.submitted ? fmtDT(m.kyb.submitted_at) : 'No'], ['Registration no.', esc(biz.registration_number)], ['Address', esc(biz.address)], ['Business', esc(biz.description)], ['Expected volume', biz.monthly_volume_usd ? fmt(biz.monthly_volume_usd * 100, 'USD') + '/month' : '—']]);
    b += `<h3>KYB checklist</h3><div class="stack">${CHECKS.map(([k, l]) => `<label class="check"><input type="checkbox" data-change="kybCheck" data-k="${k}" ${m.kyb.checks[k] ? 'checked' : ''} ${dis('merchants.manage')}> ${esc(l)}</label>`).join('')}</div>`;
    b += `<div class="card-head" style="margin:8px 0 0"><h3>Owners (KYC)</h3>${can('merchants.manage') ? '<button class="btn sm" data-act="ownerAdd">Add owner</button>' : ''}</div>` + table([{ h: 'Name', v: o => esc(o.name) }, { h: 'Owns', r: 1, v: o => (o.pct ?? '—') + '%' }, { h: 'Nationality', v: o => esc(o.nationality || '—') }, { h: 'ID', v: o => badge(o.idStatus) }, { h: '', v: o => o.idStatus !== 'verified' && can('merchants.manage') ? `<div class="row" style="flex-wrap:nowrap"><button class="btn sm danger" data-act="ownerKyc" data-i="${m.kyb.owners.indexOf(o)}" data-s="rejected">Reject</button><button class="btn sm primary" data-act="ownerKyc" data-i="${m.kyb.owners.indexOf(o)}" data-s="verified">Verify ID</button></div>` : '' }], m.kyb.owners, { empty: 'Owners not submitted yet.' });
    b += `<div class="card-head" style="margin:8px 0 0"><h3>AML screening</h3>${can('merchants.manage') ? '<button class="btn sm" data-act="amlRun">Run screening</button>' : ''}</div>` + kv([['Result', badge(m.kyb.aml.status)], ['Last run', fmtDT(m.kyb.aml.at)], ['Note', esc(m.kyb.aml.note || 'Connect a screening vendor (sanctions, PEP, adverse media) for production.')]]);
    const dq = x.documents;
    b += `<div class="card-head" style="margin:8px 0 0"><h3>Documents</h3>${can('merchants.manage') ? `<label class="btn sm" style="cursor:pointer">Upload on behalf<input type="file" accept="${DOC_ACCEPT}" hidden data-change="adminDocPick"></label>` : ''}</div>`
      + table([{ h: 'Required', v: i => esc(i.label) }, { h: 'Status', v: i => badge(i.status === 'missing' ? 'pending' : i.status, i.status) }], dq.items, { empty: 'Add owners to see the checklist.' })
      + (dq.documents.length ? table([{ h: 'Uploaded', v: d => `${esc(d.label)}${d.owner_index != null && m.kyb.owners[d.owner_index] ? ' · ' + esc(m.kyb.owners[d.owner_index].name) : ''}<div class="faint" style="font-size:.72rem">${esc(d.filename)} · ${fileSize(d.size)} · ${fmtDT(d.created)} · by ${esc(d.uploaded_by)}</div>` },
        { h: 'Status', v: d => badge(d.status) + (d.review?.note ? `<div class="faint" style="font-size:.72rem">${esc(d.review.note)}</div>` : '') },
        { h: '', v: d => `<div class="row" style="flex-wrap:nowrap">${can('merchants.manage') ? `<button class="btn sm" data-act="adminDocView" data-id="${d.id}" data-name="${esc(d.filename)}">View</button>` : ''}${d.status === 'pending' && can('merchants.manage') ? `<button class="btn sm danger" data-act="adminDocReview" data-id="${d.id}" data-s="rejected">Reject</button><button class="btn sm primary" data-act="adminDocReview" data-id="${d.id}" data-s="verified">Verify</button>` : ''}</div>` }], dq.documents) : '<p class="faint">No documents uploaded yet. The merchant uploads them under Go live → Verification documents, or upload on their behalf.</p>');
    if (!x.kyb_ready) {
      const why = [...CHECKS.filter(([k]) => !m.kyb.checks[k]).map(([, l]) => 'Tick: ' + l), ...(m.kyb.owners.length ? m.kyb.owners.filter(o => o.idStatus !== 'verified').map(o => 'Verify ID: ' + o.name) : ['Add at least one owner']), ...(m.kyb.aml.status === 'clear' ? [] : ['Run AML screening (must be clear)']), ...dq.items.filter(i => i.status !== 'verified').map(i => 'Document: ' + i.label + ' (' + i.status + ')')];
      b += note('warn', 'Before approval', '<ul style="margin:4px 0 0 18px;padding:0">' + why.map(w => `<li>${esc(w)}</li>`).join('') + '</ul>');
    }
  }
  if (t === 'wallets') {
    b += `<h3>Receiving wallets</h3>` + table([{ h: 'Address', v: w => `<a class="mono" href="${esc(w.explorer.test)}" target="_blank" rel="noopener">${esc(short(w.address, 8, 6))}</a><div class="faint" style="font-size:.72rem">${esc(w.label)}</div>` }, { h: 'Signed', v: w => w.verified_at ? fmtDT(w.verified_at) : '—' }, { h: 'Use', v: w => [x.receiving.test === w.id && '<span class="tag">test</span>', x.receiving.live === w.id && '<span class="tag">live</span>'].filter(Boolean).join(' ') || '—' }, { h: 'Status', v: w => badge(w.status) },
      { h: '', v: w => can('destinations.review') && w.status === 'verified' ? `<div class="row" style="flex-wrap:nowrap"><button class="btn sm danger" data-act="walletReview" data-id="${w.id}" data-ok="">Reject</button><button class="btn sm primary" data-act="walletReview" data-id="${w.id}" data-ok="1">Approve for live</button></div>` : '' }], x.wallets, { empty: 'The merchant has not added a wallet.' });
    b += `<h3>Live mode</h3>` + kv([['Status', m.live_enabled ? badge('active', 'enabled') : badge('pending', 'disabled')], ['Live receiving wallet', x.receiving.live ? mono(x.wallets.find(w => w.id === x.receiving.live)?.address) : 'none'], ['Platform', App.me.config.livePayments ? 'LIVE_PAYMENTS on' : 'LIVE_PAYMENTS off'], ['Why not live', esc(x.live_ready || 'ready')]])
      + `<button class="btn ${m.live_enabled ? 'danger' : 'primary'}" data-act="mLive" data-on="${m.live_enabled ? '' : '1'}" ${dis('merchants.live')}>${m.live_enabled ? 'Disable live mode' : 'Activate live mode'}</button>`;
  }
  if (t === 'controls') b += `<form class="stack" data-form="mControls"><h3>Permissions</h3><div class="form-grid">${PERMS.map(([k, l]) => `<label class="check"><input type="checkbox" name="perm_${k}" ${m.perms[k] ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
    <h3>Limits (USD)</h3><div class="form-grid">${field('Per transaction', input('perTxnUSD', { type: 'number', value: m.limits.perTxnUSD / 100 }))}${field('Daily volume', input('dailyUSD', { type: 'number', value: m.limits.dailyUSD / 100 }))}${field('30-day volume', input('monthlyUSD', { type: 'number', value: m.limits.monthlyUSD / 100 }))}${field('Daily refunds', input('refundDailyUSD', { type: 'number', value: m.limits.refundDailyUSD / 100 }))}</div>
    <h3>Risk</h3><div class="form-grid">${field('Risk tier', select('risk', ['low', 'medium', 'high'], m.risk))}${field('Max attempts per customer / hour', input('velocity', { type: 'number', value: m.controls.velocityPerHour }))}
    <label class="field full"><span>Blocked customer countries (ISO codes, comma separated)</span>${input('blocked', { value: m.controls.blockedCountries.join(', '), ph: 'e.g. KP, IR' })}</label></div>
    <div class="err" id="formErr"></div><div><button class="btn primary" type="submit" ${dis('merchants.controls')}>Save controls</button></div></form>`;
  if (t === 'pricing') { const f = m.fees; App.cache.fees = m; b += `<form class="form-grid" data-form="mPricing">${field('Digital Hub fee on USDC payments %', input('cryptoPlatPct', { type: 'number', value: f.crypto.platPct, extra: 'step="0.01"' }), 'Booked as a receivable when an invoice is paid; billed on fee statements (Settlements).')}
    <div class="err full" id="formErr"></div><button class="btn primary full" type="submit" ${dis('merchants.pricing')}>Save (applies to new payments)</button></form>`; }
  if (t === 'access') {
    if (can('merchants.controls')) b += `<div class="row"><button class="btn sm primary" data-act="adminNewKey">Create ${App.mode} API key</button><button class="btn sm" data-act="adminNewHook">Add ${App.mode} webhook</button><button class="btn sm" data-act="wooConnect" data-mid="${m.id}">Connect a WooCommerce store</button></div>`;
    b += `<h3>API keys</h3>` + table([{ h: 'Mode', v: k => badge(k.mode) }, { h: 'Key', v: k => `<span class="mono">${esc(k.prefix)}…${esc(k.last4)}</span> <span class="faint">${esc(k.name)}</span>` }, { h: 'Last used', v: k => fmtDT(k.last_used) }, { h: 'Status', v: k => badge(k.status) }, { h: '', v: k => k.status === 'active' && can('merchants.controls') ? `<button class="btn sm danger" data-act="adminRevokeKey" data-key="${k.id}">Revoke</button>` : '' }], x.keys, { empty: 'No keys.' });
    b += `<h3>Users</h3>` + table([{ h: 'User', v: u => `${esc(u.name)}<div class="faint" style="font-size:.75rem">${esc(u.email)}</div>` }, { h: 'Role', v: u => esc(u.role) }, { h: '2FA', v: u => badge(u.mfa_enabled ? 'enabled' : 'pending', u.mfa_enabled ? 'on' : 'off') }, { h: 'Status', v: u => badge(u.status) }, { h: '', v: u => can('merchants.manage') ? `<button class="btn sm ghost" data-act="mUser" data-user="${u.id}" data-on="${u.status === 'active' ? '' : '1'}">${u.status === 'active' ? 'Disable' : 'Enable'}</button>` : '' }], x.users);
    b += `<h3>Webhook endpoints</h3>` + table([{ h: 'Mode', v: e => badge(e.mode) }, { h: 'URL', v: e => `<span class="mono">${esc(e.url)}</span>` }, { h: 'Status', v: e => badge(e.status) }, { h: '', v: e => can('merchants.controls') ? `<button class="btn sm danger" data-act="adminDelHook" data-ep="${e.id}">Delete</button>` : '' }], x.webhooks, { empty: 'None.' });
  }
  if (t === 'money') {
    b += ['test', 'live'].map(mode => { const z = x.direct[mode]; return `<h3>${mode === 'test' ? 'Base Sepolia' : 'Base mainnet'}</h3>` + kv([['Received in wallet', fmt(z.received, 'USDC')], ['Sales', fmt(z.sales, 'USDC')], ['Refunded', fmt(z.refunded, 'USDC')], ['Owed back to customers', fmt(z.owed_to_customers, 'USDC')], ['Unapplied receipts', fmt(z.unapplied, 'USDC')], ['Fees due to Digital Hub', fmt(z.fees_due, 'USDC')]]); }).join('');
    b += `<h3>Manual adjustment (maker-checker)</h3><form class="form-grid" data-form="adjustment">${field('Mode', select('mode', ['test', 'live'], App.mode))}${field('Currency', select('currency', ['USDC', ...FIAT]))}${field('Amount (+ credits merchant, − debits)', input('amount', { type: 'number', req: true, extra: 'step="0.01"' }))}
      <label class="field full"><span>Reason (audit trail)</span>${input('reason', { req: true, extra: 'minlength="10"' })}</label><div class="err full" id="formErr"></div><button class="btn full" type="submit" ${dis('finance.adjust')}>Draft adjustment for second approval</button></form>`;
  }
  let foot = '';
  if (can('merchants.manage')) {
    App.cache.mx = x;
    if (m.status === 'pending') foot = `<button class="btn danger" data-act="mStatus" data-s="rejected">Reject</button><button class="btn primary" data-act="approveMerchant" ${!x.kyb_ready && x.strict_kyb ? 'disabled title="Strict KYB is on: complete every item first"' : ''}>${x.kyb_ready ? 'Approve merchant' : 'Approve merchant…'}</button>`;
    else if (m.status === 'approved') foot = `<button class="btn danger" data-act="mStatus" data-s="suspended">Suspend</button>`;
    else foot = `<button class="btn" data-act="mStatus" data-s="pending">Reopen review</button>${m.status === 'suspended' ? `<button class="btn primary" data-act="approveMerchant">Reactivate</button>` : ''}`;
  }
  return { title: m.name, body: b, foot };
}
const mid = () => App.cache.mid;
ACT.kybCheck = (d, el) => run(() => api('POST', `/a-api/merchants/${mid()}/kyb`, { check: d.k, value: el.checked }));
ACT.ownerAdd = () => formModal('Add owner', 'ownerAdd', `<div class="form-grid">${field('Full name', input('name', { req: true }))}${field('Ownership %', input('pct', { type: 'number', req: true, extra: 'min="0" max="100"' }))}${field('Nationality (ISO)', input('nationality', { ph: 'US', extra: 'maxlength="2"' }))}${field('Date of birth', input('dob', { type: 'date' }))}</div>`, 'Add owner');
FORM.ownerAdd = async f => { await api('POST', `/a-api/merchants/${mid()}/owners`, f); closeModal(); toast('Owner added — upload or request their ID'); refreshDrawer(); };
ACT.adminDocView = d => run(() => viewDocument('/a-api/documents/' + d.id + '/file', d.name), { noRefresh: true });
ACT.adminDocReview = d => d.s === 'verified' ? run(() => api('POST', `/a-api/documents/${d.id}/review`, { status: 'verified' }), { ok: 'Document verified' })
  : formModal('Reject document', 'docReject', field('Reason (shown to the merchant)', '<textarea name="note" required minlength="3" placeholder="Image is blurry / expired ID / name does not match…"></textarea>'), 'Reject', { data: { id: d.id } });
FORM.docReject = async (f, form) => { await api('POST', `/a-api/documents/${form.dataset.id}/review`, { status: 'rejected', note: f.note }); closeModal(); toast('Document rejected'); refreshDrawer(); };
ACT.adminDocPick = (d, el) => { const file = el.files[0]; if (!file) return; App.cache.pickedDoc = file; run(async () => { const x = await api('GET', '/a-api/merchants/' + mid());
  formModal('Upload document on behalf', 'adminDocUp', `<p>${esc(file.name)} · ${fileSize(file.size)}</p>${field('Document type', select('type', [['owner_id', 'Owner ID card / passport'], ['company_registration', 'Company registration (LLC / incorporation)'], ['proof_of_address', 'Proof of business address'], ['tax_document', 'Tax registration'], ['ownership_structure', 'Ownership structure'], ['other', 'Other']]))}
    ${field('Owner (for ID documents)', select('owner_index', x.merchant.kyb.owners.length ? x.merchant.kyb.owners.map((o, i) => [String(i), o.name]) : [['', 'No owners yet']]))}`, 'Upload'); }, { noRefresh: true }); };
FORM.adminDocUp = async f => { const file = App.cache.pickedDoc, data = await readFileB64(file); await api('POST', `/a-api/merchants/${mid()}/documents`, { type: f.type, owner_index: f.owner_index === '' ? undefined : +f.owner_index, filename: file.name, data }); closeModal(); toast('Uploaded'); refreshDrawer(); };
ACT.ownerKyc = d => run(() => api('POST', `/a-api/merchants/${mid()}/kyb`, { owner: +d.i, idStatus: d.s }), { ok: 'Owner updated' });
ACT.amlRun = () => run(() => api('POST', `/a-api/merchants/${mid()}/kyb`, { aml: true }), { ok: 'Screening complete' });
/** Approve: clean when everything is verified; otherwise list what's open and require a reason (audited). */
ACT.approveMerchant = () => {
  const x = App.cache.mx, open = x.kyb_blockers || [];
  if (!open.length) return confirmBox('Approve merchant?', 'Everything is verified. The merchant can request live activation.', 'Approve', () => api('POST', `/a-api/merchants/${mid()}/status`, { status: 'approved' }), false);
  formModal('Approve with exceptions', 'approveExc', note('warn', `${open.length} item(s) are not verified yet`, '<ul style="margin:4px 0 0 18px;padding:0">' + open.map(o => `<li>${esc(o)}</li>`).join('') + '</ul>')
    + field('Reason for approving now (recorded in the audit trail)', '<textarea name="reason" required minlength="10" placeholder="e.g. Known client, documents to follow within 7 days"></textarea>')
    + '<label class="check"><input type="checkbox" name="confirm" required> I approve this merchant with the open items above. Documents can still be uploaded and verified later.</label>', 'Approve merchant');
};
FORM.approveExc = async f => { await api('POST', `/a-api/merchants/${mid()}/status`, { status: 'approved', override: true, reason: f.reason }); closeModal(); toast('Merchant approved with exceptions'); await render(); refreshDrawer(); };
ACT.mStatus = d => confirmBox(`Set merchant to ${d.s}?`, d.s === 'suspended' ? 'All new payments stop and live mode is switched off.' : d.s === 'approved' ? 'The merchant can request live activation.' : 'The merchant is notified in their dashboard.', 'Confirm', () => api('POST', `/a-api/merchants/${mid()}/status`, { status: d.s }), d.s !== 'approved');
FORM.mControls = async f => { await api('PATCH', `/a-api/merchants/${mid()}/controls`, { perms: Object.fromEntries(PERMS.map(([k]) => [k, f['perm_' + k]])), risk: f.risk,
  limits: { perTxnUSD: toMinor(f.perTxnUSD), dailyUSD: toMinor(f.dailyUSD), monthlyUSD: toMinor(f.monthlyUSD), refundDailyUSD: toMinor(f.refundDailyUSD) }, controls: { velocityPerHour: +f.velocity, blockedCountries: f.blocked.split(/[\s,]+/).filter(Boolean) } }); toast('Controls saved'); refreshDrawer(); render(); };
FORM.mPricing = async f => { const m = App.cache.fees, k = m.fees; await api('PATCH', `/a-api/merchants/${mid()}/pricing`, { acqPct: k.card.acqPct, acqFixedUSD: k.card.acqFixedUSD, cardPlatPct: k.card.platPct, provPct: 0, cryptoPlatPct: +f.cryptoPlatPct, fxSpreadBps: k.fxSpreadBps, disputeFeeUSD: k.disputeFeeUSD, reservePct: m.reserve.pct, reserveDays: m.reserve.days }); toast('Fee saved'); refreshDrawer(); };
ACT.mLive = d => confirmBox(d.on ? 'Activate live mode?' : 'Disable live mode?', d.on ? 'The merchant can create live keys and accept real USDC on Base mainnet into their approved wallet.' : 'Live keys stop working immediately.', 'Confirm', () => api('POST', `/a-api/merchants/${mid()}/live`, { enabled: !!d.on }), !d.on);
ACT.adminRevokeKey = d => confirmBox('Revoke this API key?', 'The merchant\'s integration using it stops working immediately.', 'Revoke', () => api('POST', `/a-api/merchants/${mid()}/keys/${d.key}/revoke`));
ACT.mUser = d => run(() => api('POST', `/a-api/merchants/${mid()}/users/${d.user}/status`, { active: !!d.on }), { ok: 'User updated' });
FORM.adjustment = async (f, form) => { await api('POST', '/a-api/adjustments', { merchant: mid(), mode: f.mode, currency: f.currency, amount: toMinor(f.amount), reason: f.reason }); form.reset(); toast('Drafted — a different staff member must approve it under Approvals'); render(); };

/* ---------------- transactions & invoices ---------------- */
VIEWS['a-payments'] = async () => {
  const f = App.filters.ap ||= { q: '', status: '', merchant: '' };
  const [d, ms] = await Promise.all([api('GET', '/a-api/payments' + qs(f)), api('GET', '/a-api/merchants')]);
  return head('Super admin', 'Transactions', `Every merchant's USDC payments with on-chain status · ${modeLabel()}`, liveIf(d.data.some(p => ['awaiting_payment', 'confirming'].includes(p.status))) + (can('platform.settings') ? '<button class="btn" data-act="runMonitor">Scan chain now</button>' : ''))
    + `<div class="card"><div class="grid g3">${fInput('ap', 'q', 'Search', 'ID, email, wallet, tx hash')}${fSelect('ap', 'merchant', 'Merchant', [['', 'All merchants'], ...ms.map(m => [m.id, m.name])])}${fSelect('ap', 'status', 'Status', [['', 'All'], ...['awaiting_payment', 'confirming', 'confirmed', 'underpaid', 'overpaid', 'expired', 'canceled', 'partially_refunded', 'refunded'].map(s => [s, s.replace(/_/g, ' ')])])}</div></div>`
    + table([{ h: 'Date', v: p => fmtDT(p.created) }, { h: 'Merchant', v: p => esc(p.merchant_name) }, ...payCols.slice(1)], d.data, { rowAttr: p => `class="click" data-act="openAdminPayment" data-id="${p.id}"`, empty: 'No payments match.' })
    + `<span class="faint">${d.total} payments (showing up to 200)</span>`;
};
ACT.openAdminPayment = d => openDrawer(async () => {
  const x = await api('GET', '/a-api/payments/' + d.id);
  return { title: 'Payment', body: paymentBody(x, true) + (x.crypto?.payer_proof ? `<h3>Payer signature (EIP-4361)</h3><pre class="code" style="white-space:pre-wrap">${esc(x.crypto.payer_proof.message)}</pre><div class="hash">${esc(x.crypto.payer_proof.signature)}</div>` : '') };
});
VIEWS['a-invoices'] = async () => {
  const f = App.filters.inv ||= { q: '', status: '', merchant: '' };
  const [d, ms] = await Promise.all([api('GET', '/a-api/invoices' + qs(f)), api('GET', '/a-api/merchants')]);
  return head('Super admin', 'Invoices', `Checkout sessions from WooCommerce, payment links and the API · ${modeLabel()}. An invoice is paid only after the backend verifies the transfer on-chain.`)
    + `<div class="card"><div class="grid g3">${fInput('inv', 'q', 'Search', 'ID, description, email, order ID')}${fSelect('inv', 'merchant', 'Merchant', [['', 'All merchants'], ...ms.map(m => [m.id, m.name])])}${fSelect('inv', 'status', 'Status', [['', 'All'], ['open', 'Open'], ['complete', 'Paid'], ['expired', 'Expired']])}</div></div>`
    + table([{ h: 'Created', v: s => fmtDT(s.created) }, { h: 'Merchant', v: s => esc(s.merchant_name) }, { h: 'Invoice', v: s => `${mono(s.id, 10, 4)}<div class="faint" style="font-size:.72rem">${esc(s.description)}</div>` }, { h: 'Source', v: s => `<span class="tag">${esc(s.source.replace('_', ' '))}</span>${s.metadata?.order_id ? ` <span class="faint">#${esc(s.metadata.order_id)}</span>` : ''}` },
      { h: 'Amount', r: 1, v: s => fmt(s.amount, s.payment_detail?.method === 'card' || !s.payment_methods.includes('usdc') ? s.currency : 'USDC') },
      { h: 'Paid with', v: s => s.payment_detail?.card ? `${cardLabel(s.payment_detail.card)}${s.payment_detail.card.cardholder ? `<div class="faint" style="font-size:.72rem">${esc(s.payment_detail.card.cardholder)} · 3DS ${esc((s.payment_detail.card.three_d_secure || 'n/a').replace(/_/g, ' '))}</div>` : ''}` : s.payment_detail?.payer ? `USDC ${mono(s.payment_detail.payer)}` : '—' }, { h: 'Tx', v: s => s.payment_detail?.tx ? `<a class="mono" href="${esc(EXPLORER[s.payment_detail.network] + '/tx/' + s.payment_detail.tx)}" target="_blank" rel="noopener">${esc(short(s.payment_detail.tx, 8, 4))}</a>` : '—' },
      { h: 'Status', v: s => badge(s.status === 'complete' ? 'paid' : s.status) + (s.payment_detail && s.status !== 'complete' ? `<div class="faint" style="font-size:.72rem">${esc(s.payment_detail.status.replace(/_/g, ' '))}</div>` : '') }],
      d.data, { rowAttr: s => s.payment ? `class="click" data-act="openAdminPayment" data-id="${s.payment}"` : '', empty: 'No invoices match.' }) + `<span class="faint">${d.total} invoices (showing up to 300)</span>`;
};

/* ---------------- subscriptions ---------------- */
VIEWS['a-subscriptions'] = async () => {
  const f = App.filters.subs ||= { status: '' }, subs = await api('GET', '/a-api/subscriptions' + qs(f));
  return head('Super admin', 'Subscriptions', `Recurring invoices across merchants · ${modeLabel()}. Saved sandbox cards are charged automatically; otherwise customers pay from the invoice link.`)
    + `<div class="card"><div class="grid g3">${fSelect('subs', 'status', 'Status', [['', 'All'], ['active', 'Active'], ['past_due', 'Past due'], ['paused', 'Paused'], ['canceled', 'Canceled']])}</div></div>`
    + table([{ h: 'Merchant', v: s => esc(s.merchant_name) }, { h: 'Customer', v: s => esc(s.customer_email) }, { h: 'Plan', v: s => `${esc(s.description)}<div class="faint" style="font-size:.72rem">${fmt(s.amount, s.currency)} every ${s.interval_count > 1 ? s.interval_count + ' ' : ''}${s.interval}${s.interval_count > 1 ? 's' : ''}</div>` },
      { h: 'Auto-charge', v: s => s.auto_charge ? cardLabel(s.auto_charge) : '<span class="faint">link</span>' }, { h: 'Pending', r: 1, v: s => s.current_invoice ? fmt(s.amount, s.currency) : '—' }, { h: 'Next billing', v: s => s.status === 'canceled' ? '—' : fmtDT(s.next_billing_at) }, { h: 'Status', v: s => badge(s.status) }], subs, { empty: 'No subscriptions.' });
};

/* ---------------- digital wallet ---------------- */
VIEWS['a-wallet'] = async () => {
  const f = App.filters.wal ||= { status: '' }, ws = await api('GET', '/a-api/wallets' + qs(f)), pend = ws.filter(w => w.status === 'verified');
  return head('Super admin', 'Digital Wallet', 'Merchant receiving wallets. Ownership is proven by an EIP-4361 signature from the wallet itself; compliance approval is required before Base mainnet payments. Funds always go directly to these wallets — Digital Hub holds no customer money.')
    + mfaWarn() + (pend.length ? note('warn', `${pend.length} awaiting review`, 'Before approving: confirm the business controls the wallet (signature below), screen the address with your blockchain-analytics vendor, and reject exchange deposit addresses.') : '')
    + `<div class="card"><div class="grid g3">${fSelect('wal', 'status', 'Status', [['', 'All'], ['pending_signature', 'Awaiting signature'], ['verified', 'Signed — awaiting review'], ['approved', 'Approved for live'], ['rejected', 'Rejected'], ['disabled', 'Removed']])}</div></div>`
    + table([{ h: 'Merchant', v: w => esc(w.merchant_name) }, { h: 'Wallet', v: w => `<a class="mono" href="${esc(w.explorer.test)}" target="_blank" rel="noopener">${esc(short(w.address, 10, 6))}</a><div class="faint" style="font-size:.72rem">${esc(w.label)}</div>` },
      { h: 'Ownership proof', v: w => w.proof ? `${badge('pass', 'signature')}<div class="faint" style="font-size:.72rem">${fmtDT(w.proof.signed_at)} · ${esc(w.proof.ip || '')}</div>` : '<span class="faint">not signed</span>' },
      { h: 'Use', v: w => [w.receiving_test && '<span class="tag">test</span>', w.receiving_live && '<span class="tag">live</span>'].filter(Boolean).join(' ') || '—' }, { h: 'Received', r: 1, v: w => `${fmt(w.received.test, 'USDC')}<div class="faint" style="font-size:.72rem">live ${fmt(w.received.live, 'USDC')}</div>` }, { h: 'Status', v: w => badge(w.status) },
      { h: '', v: w => `<div class="row" style="flex-wrap:nowrap">${w.proof ? `<button class="btn sm ghost" data-act="walletProof" data-id="${w.id}">Proof</button>` : ''}${w.status === 'verified' && can('destinations.review') ? `<button class="btn sm danger" data-act="walletReview" data-id="${w.id}" data-ok="">Reject</button><button class="btn sm primary" data-act="walletReview" data-id="${w.id}" data-ok="1">Approve</button>` : ''}${w.status === 'approved' && can('destinations.review') ? `<button class="btn sm danger" data-act="walletReview" data-id="${w.id}" data-ok="">Revoke</button>` : ''}</div>` }],
      ws, { empty: 'No wallets.' });
};
ACT.walletProof = d => run(async () => { const ws = await api('GET', '/a-api/wallets'), w = ws.find(x => x.id === d.id);
  openModal({ title: 'Wallet ownership proof', wide: true, body: kv([['Wallet', mono(w.address, 42, 0)], ['Recovered signer', mono(w.proof.signer, 42, 0)], ['Signed', fmtDT(w.proof.signed_at)], ['IP', esc(w.proof.ip || '—')]]) + `<h3>Signed message</h3><pre class="code" style="white-space:pre-wrap">${esc(w.proof.message)}</pre><h3>Signature</h3><div class="hash">${esc(w.proof.signature)}</div>`,
    foot: `<button class="btn" data-act="walletRecheck" data-id="${w.id}">Re-verify signature</button><button class="btn primary" data-act="closeModal">Close</button>` }); }, { noRefresh: true });
ACT.walletRecheck = d => run(async () => { const r = await api('POST', `/a-api/wallets/${d.id}/recheck`); if (!r.valid) throw new Error('Signature does NOT recover to this wallet.'); }, { ok: 'Signature recovers to the wallet address', noRefresh: true });
ACT.walletReview = d => formModal(d.ok ? 'Approve wallet for live payments' : 'Reject wallet', 'walletReview', (d.ok ? note('info', '', 'Approve only after sanctions / blockchain-analytics screening.') : '') + field('Note (shown to the merchant)', '<textarea name="note" required minlength="3"></textarea>'), d.ok ? 'Approve' : 'Reject', { data: { id: d.id, ok: d.ok || '' } });
FORM.walletReview = async (f, form) => { await api('POST', `/a-api/wallets/${form.dataset.id}/review`, { approve: !!form.dataset.ok, note: f.note }); closeModal(); toast('Wallet updated'); render(); refreshDrawer(); };

/* ---------------- settlements ---------------- */
VIEWS['a-settlements'] = async () => {
  const d = await api('GET', '/a-api/settlements');
  liveIf(d.statements.some(s => s.status === 'verifying'));
  return head('Super admin', 'Settlements', `Customer payments settle instantly into merchant wallets, so there are no payouts. This page bills Digital Hub's platform fees (booked as receivables) and verifies each fee payment on-chain · ${modeLabel()}.`)
    + (d.fee_wallet ? note('info', 'Fee treasury wallet', `${mono(d.fee_wallet, 42, 0)} — change it in <a href="#/a-settings">Settings → MetaMask</a>.`) : note('warn', 'No fee treasury wallet', 'Set one in <a href="#/a-settings">Settings → MetaMask</a> before merchants can pay statements.'))
    + `<div class="card"><div class="card-head"><h2>Fees by merchant</h2></div>${table([{ h: 'Merchant', v: x => esc(x.name) }, { h: 'Sales', r: 1, v: x => fmt(x.volume, 'USDC') }, { h: 'Fee %', r: 1, v: x => x.fee_pct + '%' }, { h: 'Fees receivable', r: 1, v: x => fmt(x.fees_due, 'USDC') }, { h: 'On open statements', r: 1, v: x => fmt(x.open, 'USDC') },
      { h: '', v: x => x.fees_due - x.open > 0 && can('payouts.approve') ? `<button class="btn sm primary" data-act="newStatement" data-id="${x.id}">Issue statement</button>` : '' }], d.merchants, { empty: 'No fees accrued yet.' })}</div>
    <div class="card"><div class="card-head"><h2>Statements</h2></div>${table([{ h: 'Issued', v: s => fmtDT(s.created_at) }, { h: 'Merchant', v: s => esc(s.merchant_name) }, { h: 'Period', v: s => `${fmtDate(s.period_from)} – ${fmtDate(s.period_to)}` }, { h: 'Amount', r: 1, v: s => fmt(s.amount, 'USDC') }, { h: 'Tx', v: s => s.explorer ? `<a class="mono" href="${esc(s.explorer)}" target="_blank" rel="noopener">${esc(short(s.tx.hash, 8, 4))}</a>` : '—' }, { h: 'Status', v: s => badge(s.status) + (s.last_error ? `<div class="faint" style="font-size:.72rem">${esc(s.last_error)}</div>` : '') },
      { h: '', v: s => `<div class="row" style="flex-wrap:nowrap">${s.status === 'open' && can('payouts.execute') ? `<button class="btn sm" data-act="stlHash" data-id="${s.id}">Record tx</button>` : ''}${s.status === 'verifying' ? `<button class="btn sm" data-act="stlCheck" data-id="${s.id}">Check</button>` : ''}${s.status === 'open' && can('payouts.approve') ? `<button class="btn sm danger" data-act="stlVoid" data-id="${s.id}">Void</button>` : ''}</div>` }], d.statements, { empty: 'No statements yet.' })}</div>`;
};
ACT.newStatement = d => confirmBox('Issue fee statement?', 'Bills all unbilled platform fees for this merchant. They can pay it with MetaMask from their dashboard.', 'Issue', () => api('POST', '/a-api/settlements', { merchant: d.id }), false);
ACT.stlHash = d => formModal('Record fee payment transaction', 'stlHash', note('info', '', 'The transfer must be USDC from one of the merchant\'s signature-verified wallets to the fee treasury wallet, for at least the statement amount. It is verified on-chain before the statement is marked paid.') + field('Transaction hash', input('hash', { req: true, ph: '0x…' })), 'Verify', { data: { id: d.id } });
FORM.stlHash = async (f, form) => { const r = await api('POST', `/a-api/settlements/${form.dataset.id}/tx`, f); closeModal(); toast(r.status === 'paid' ? 'Verified and marked paid' : r.status === 'verifying' ? 'Waiting for confirmations' : (r.last_error || 'Not accepted'), r.status === 'open' ? 'err' : ''); render(); };
ACT.stlCheck = d => run(() => api('POST', `/a-api/settlements/${d.id}/check`), { ok: 'Checked on-chain' });
ACT.stlVoid = d => formModal('Void statement', 'stlVoid', field('Reason', '<textarea name="note" required></textarea>'), 'Void', { data: { id: d.id } });
FORM.stlVoid = async (f, form) => { await api('POST', `/a-api/settlements/${form.dataset.id}/void`, f); closeModal(); toast('Statement voided'); render(); };

/* ---------------- refunds ---------------- */
VIEWS['a-refunds'] = async () => {
  const f = App.filters.rf ||= { status: '' }, rs = await api('GET', '/a-api/refunds' + qs(f));
  return head('Super admin', 'Refunds', `Merchants send refunds from their own receiving wallet with MetaMask; Digital Hub verifies sender, recipient, amount and finality before marking them succeeded · ${modeLabel()}.`, liveIf(rs.some(r => r.status === 'pending')))
    + `<div class="card"><div class="grid g3">${fSelect('rf', 'status', 'Status', [['', 'All'], ['requires_action', 'Waiting for merchant'], ['pending', 'Verifying on-chain'], ['succeeded', 'Succeeded'], ['canceled', 'Canceled']])}</div></div>`
    + table([{ h: 'Created', v: r => fmtDT(r.created_at) }, { h: 'Merchant', v: r => esc(r.merchant_name) }, { h: 'Payment', v: r => `<a data-act="openAdminPayment" data-id="${r.payment_id}" href="#" class="mono">${esc(short(r.payment_id, 8, 4))}</a>` }, { h: 'Amount', r: 1, v: r => fmt(r.amount, r.currency) }, { h: 'From → to', v: r => r.from ? `${mono(r.from)} → ${mono(r.to)}` : esc(r.address || '—') },
      { h: 'Tx', v: r => r.explorer ? `<a class="mono" href="${esc(r.explorer)}" target="_blank" rel="noopener">${esc(short(r.tx.hash, 8, 4))}</a>${r.tx.confirmations != null ? `<div class="faint" style="font-size:.72rem">${r.tx.confirmations} conf.</div>` : ''}` : '—' }, { h: 'Status', v: r => badge(r.status) + (r.last_error ? `<div class="faint" style="font-size:.72rem">${esc(r.last_error)}</div>` : '') },
      { h: '', v: r => r.status === 'pending' && can('payments.manage') ? `<button class="btn sm" data-act="refundCheck" data-id="${r.id}">Check</button>` : '' }], rs, { empty: 'No refunds.' });
};
ACT.refundCheck = d => run(() => api('POST', `/a-api/refunds/${d.id}/check`), { ok: 'Checked on-chain' });

/* ---------------- ledger ---------------- */
VIEWS['a-ledger'] = async () => {
  const d = await api('GET', '/a-api/ledger');
  return head('Super admin', 'Ledger & reconciliation', `Append-only double-entry journal (${d.journals} journals) · ${modeLabel()}. Database triggers block edits and deletes. USDC is booked only when a transfer is final on-chain.`)
    + `<div class="card"><div class="card-head"><h2>Reconciliation checks</h2>${badge(d.checks.every(c => c.ok) ? 'pass' : 'fail', d.checks.every(c => c.ok) ? 'all passing' : 'issues')}</div><div class="stack">${d.checks.map(c => `<div class="check-row"><div><b>${esc(c.name)}</b><div class="muted" style="font-size:.84rem">${esc(c.detail)}</div></div>${c.warn ? badge('pending', 'attention') : badge(c.ok ? 'pass' : 'fail')}</div>`).join('<div class="divider"></div>')}</div></div>
    <div class="grid g2"><div class="card"><h2>Trial balance</h2><div style="margin-top:10px">${table([{ h: 'Currency', v: r => r.currency }, { h: 'Debits', r: 1, v: r => fmt(r.debits, r.currency) }, { h: 'Credits', r: 1, v: r => fmt(r.credits, r.currency) }, { h: '', v: r => badge(r.debits === r.credits ? 'pass' : 'fail', r.debits === r.credits ? 'balanced' : 'off') }], d.trial_balance)}</div></div>
    <div class="card"><h2>Account positions</h2><div style="margin-top:10px">${table([{ h: 'Account', v: r => `<span class="mono">${esc(r.account)}</span>` }, { h: 'Currency', v: r => r.currency }, { h: 'Balance', r: 1, v: r => fmt(r.total, r.currency) }], d.accounts)}</div></div></div>
    <div class="card"><h2>Latest entries</h2><div style="margin-top:10px">${table([{ h: 'Time', v: e => fmtDT(e.at) }, { h: 'Journal', v: e => `<span class="mono">${esc(short(e.journal_key, 16, 12))}</span>` }, { h: 'Account', v: e => esc(e.account) }, { h: 'Merchant', v: e => e.merchant_id ? `<span class="mono">${esc(short(e.merchant_id))}</span>` : '—' }, { h: 'Amount', r: 1, v: e => fmt(e.amount, e.currency) }, { h: 'Memo', v: e => esc(e.memo) }], d.entries)}</div></div>`;
};

/* ---------------- WooCommerce ---------------- */
VIEWS['a-woo'] = async () => {
  const d = await api('GET', '/a-api/woocommerce');
  return head('Super admin', 'WooCommerce Integrations', `Stores connected through the Digital Hub plugin v${esc(d.plugin.version)} · ${modeLabel()}. Orders move to on-hold when a transfer is seen, processing when it is final, and refunds sync back when verified on-chain.`, `${can('merchants.controls') ? '<button class="btn primary" data-act="wooConnect">Connect a store</button>' : ''}<a class="btn" href="${esc(d.plugin.download)}">Download plugin</a>`)
    + (d.stores.length ? '' : note('info', 'Connect your first store', '1 · Create the merchant (Merchants → New merchant) or let them sign up. 2 · Click <b>Connect a store</b>: it creates the API key and webhook and shows the four values to paste into WooCommerce → Settings → Payments → Digital Hub. 3 · The merchant verifies a receiving wallet with MetaMask (or switch on sandbox cards in Settings) so checkout has a payment method.'))
    + table([{ h: 'Store', v: s => `<b>${esc(s.site)}</b><div class="faint" style="font-size:.72rem">${esc(s.merchant_name)}</div>` }, { h: 'Webhook', v: s => `<span class="mono" style="font-size:.75rem">${esc(short(s.url, 30, 14))}</span><div>${badge(s.status)}</div>` }, { h: 'Orders', r: 1, v: s => `${s.orders}<div class="faint" style="font-size:.72rem">${s.paid_orders} paid · ${s.open_orders} open</div>` },
      { h: 'Deliveries', r: 1, v: s => `${s.delivered} ok${s.failing ? `<div>${badge('fail', s.failing + ' failing')}</div>` : ''}` }, { h: 'Last delivery', v: s => s.last_delivery ? `${fmtDT(s.last_delivery.at)} ${badge(s.last_delivery.status)}<div class="faint mono" style="font-size:.72rem">${esc(s.last_delivery.type)}${s.last_delivery.code ? ' · HTTP ' + s.last_delivery.code : ''}</div>` : '—' }, { h: 'API key used', v: s => fmtDT(s.key_last_used) }],
      d.stores, { empty: `No WooCommerce store has registered a webhook ending in ${esc(d.plugin.webhook_path)} yet.` })
    + `<div class="card"><div class="card-head"><h2>Recent WooCommerce orders</h2></div>${table([{ h: 'Created', v: s => fmtDT(s.created) }, { h: 'Store', v: s => esc(s.metadata.site || s.merchant_name) }, { h: 'Order', v: s => '#' + esc(s.metadata.order_id) }, { h: 'Amount', r: 1, v: s => fmt(s.amount, 'USDC') }, { h: 'Invoice', v: s => mono(s.id, 10, 4) }, { h: 'Status', v: s => badge(s.payment_status === 'paid' ? 'paid' : s.status) }], d.recent, { rowAttr: s => s.payment ? `class="click" data-act="openAdminPayment" data-id="${s.payment}"` : '', empty: 'No WooCommerce orders yet.' })}</div>`;
};

/* ---------------- API logs, webhooks ---------------- */
VIEWS['a-apilogs'] = async () => {
  const f = App.filters.log ||= { q: '', status: '', kind: '' }, d = await api('GET', '/a-api/api-logs' + qs(f));
  return head('Super admin', 'API Logs', 'Every REST API call, customer-checkout write and inbound hook, with status, latency, API key and idempotency key. Kept 30 days.')
    + `<div class="card"><div class="grid g3">${fInput('log', 'q', 'Search', 'path, key, IP, error')}${fSelect('log', 'kind', 'Kind', [['', 'All'], ['api', 'REST API (/v1)'], ['checkout', 'Hosted checkout'], ['webhook_in', 'Inbound hooks']])}${fSelect('log', 'status', 'Result', [['', 'All'], ['ok', 'Success'], ['error', 'Errors']])}</div></div>`
    + table([{ h: 'Time', v: l => fmtDT(l.created_at) }, { h: 'Request', v: l => `<span class="tag">${esc(l.method)}</span> <span class="mono" style="font-size:.78rem">${esc(l.path)}</span>` }, { h: 'Merchant', v: l => esc(l.merchant_name || '—') }, { h: 'Key', v: l => l.key ? `<span class="mono">${esc(l.key)}</span>` : '—' },
      { h: 'Idempotency', v: l => l.idempotency_key ? `<span class="mono" style="font-size:.72rem">${esc(short(l.idempotency_key, 14, 4))}</span>` : '—' }, { h: 'HTTP', r: 1, v: l => badge(l.code < 400 ? 'pass' : 'fail', String(l.code)) + (l.error ? `<div class="faint mono" style="font-size:.7rem">${esc(l.error)}</div>` : '') }, { h: 'ms', r: 1, v: l => l.ms }, { h: 'IP', v: l => `<span class="mono" style="font-size:.75rem">${esc(l.ip)}</span>` }], d.data, { empty: 'No API calls logged.' })
    + `<span class="faint">${d.total} calls (showing up to 300)</span>`
    + `<div class="card"><div class="card-head"><h2>Recent RPC provider errors</h2></div>${table([{ h: 'Time', v: e => fmtDT(e.at) }, { h: 'Network', v: e => esc(e.network) }, { h: 'Endpoint', v: e => `<span class="mono">${esc(e.url)}</span>` }, { h: 'Method', v: e => `<span class="mono">${esc(e.method)}</span>` }, { h: 'Error', v: e => esc(e.error) }], d.rpc_errors, { empty: 'No RPC errors since the server started.' })}</div>`;
};
VIEWS['a-webhooks'] = async () => {
  const f = App.filters.wh ||= { status: '' }; const ds = await api('GET', '/a-api/deliveries' + qs(f));
  return head('Super admin', 'Webhook deliveries', `Signed outbound events to merchant servers and WooCommerce stores · ${modeLabel()}`)
    + `<div class="card"><div class="grid g3">${fSelect('wh', 'status', 'Status', [['', 'All'], ['delivered', 'Delivered'], ['retrying', 'Retrying'], ['failed', 'Failed'], ['pending', 'Pending']])}</div></div>`
    + table([{ h: 'Time', v: d => fmtDT(d.last_attempt || d.created_at) }, { h: 'Merchant', v: d => `<span class="mono">${esc(short(d.merchant_id))}</span>` }, { h: 'Event', v: d => `<span class="mono">${esc(d.type)}</span>` }, { h: 'URL', v: d => `<span class="mono">${esc(short(d.url, 26, 10))}</span>` }, { h: 'HTTP', r: 1, v: d => d.code ?? '—' }, { h: 'Attempts', r: 1, v: d => d.attempts }, { h: 'Status', v: d => badge(d.status) + (d.error ? `<div class="faint" style="font-size:.72rem">${esc(d.error)}</div>` : '') }, { h: '', v: d => d.status !== 'delivered' && can('payments.manage') ? `<button class="btn sm" data-act="aRetry" data-id="${d.id}">Retry</button>` : '' }], ds, { empty: 'No deliveries.' });
};
/* ---------------- onboarding: merchants, keys, webhooks, store connect ---------------- */
ACT.newMerchant = () => formModal('New merchant', 'newMerchant', `<div class="form-grid">${field('Business name', input('business_name', { req: true }))}${field('Country', select('country', Object.entries(COUNTRIES), 'US'))}
  ${field('Owner name', input('owner_name', { req: true }))}${field('Owner email (sign-in)', input('owner_email', { type: 'email', req: true }))}</div>${field('Website', input('website', { ph: 'yourshop.com' }))}
  <p class="faint">Starts in test mode with KYB pending. A temporary password is shown once — the owner changes it at first sign-in.</p>`, 'Create merchant');
FORM.newMerchant = async f => { const r = await api('POST', '/a-api/merchants', f); closeModal(); await render(); secretModal('Merchant created', `Owner <b>${esc(r.owner.email)}</b> signs in at <span class="mono">${esc(location.origin)}/app</span> with this temporary password:`, r.temporary_password); };
ACT.adminNewKey = () => formModal(`Create ${App.mode} API key`, 'adminNewKey', `${field('Name', input('name', { req: true, value: 'Store key' }))}${field('Permissions', select('scope', [['woocommerce', 'Store / WooCommerce (checkout, payments, refunds, events)'], ['full', 'Full access']], 'woocommerce'))}`, 'Create key');
FORM.adminNewKey = async f => { const r = await api('POST', `/a-api/merchants/${mid()}/keys`, f); closeModal(); await refreshDrawer(); secretModal('Secret API key', `Paste into the store's Digital Hub settings (${esc(r.mode)} mode). Stored hashed — shown only now.`, r.secret); };
ACT.adminNewHook = () => formModal(`Add ${App.mode} webhook endpoint`, 'adminNewHook', field('Endpoint URL', input('url', { type: 'url', req: true, ph: 'https://yourshop.com/wc-api/digitalhub/' }), 'WooCommerce: https://YOUR-SHOP/wc-api/digitalhub/ · receives all events, signed with the secret.'), 'Add endpoint');
FORM.adminNewHook = async f => { const r = await api('POST', `/a-api/merchants/${mid()}/webhooks`, f); closeModal(); await refreshDrawer(); secretModal('Webhook signing secret', 'Paste into the store as the webhook secret. Shown only now.', r.secret); };
ACT.adminDelHook = d => confirmBox('Delete webhook endpoint?', 'The store stops receiving payment updates.', 'Delete', () => api('POST', `/a-api/merchants/${mid()}/webhooks/${d.ep}/delete`));
ACT.wooConnect = d => run(async () => {
  const ms = await api('GET', '/a-api/merchants');
  if (!ms.length) throw new Error('Create a merchant first (Merchants → New merchant).');
  formModal(`Connect a WooCommerce store · ${App.mode}`, 'wooConnect', `${field('Merchant', select('merchant', ms.map(m => [m.id, m.name]), d.mid || ms[0].id))}${field('Store address', input('store_url', { type: 'url', req: true, ph: 'https://yourshop.com' }), 'The WordPress site address. The webhook goes to /wc-api/digitalhub/ on it.')}
    <p class="faint">Creates a ${App.mode} API key limited to store permissions and a signed webhook endpoint. ${App.mode === 'test' ? 'Test mode: Base Sepolia / sandbox cards.' : 'Live mode: real money.'}</p>`, 'Connect store');
}, { noRefresh: true });
FORM.wooConnect = async f => {
  const r = await api('POST', '/a-api/woocommerce/connect', f), s = r.plugin_settings; closeModal(); await render();
  const row = (k, v, secret) => `<div class="check-row" style="align-items:center"><div style="min-width:0"><b>${esc(k)}</b><div class="${secret ? 'secret' : 'addr'}" style="margin-top:4px">${esc(v)}</div></div><button class="btn sm" data-act="copy" data-text="${esc(v)}">Copy</button></div>`;
  openModal({ title: `Store connected · ${r.store}`, wide: true, body: note('warn', 'Copy now', 'The secret key and webhook secret are shown only once.')
    + `<p>In WordPress: <b>WooCommerce → Settings → Payments → Digital Hub → Manage</b>, then paste:</p><div class="stack">${row('Digital Hub URL', s.digital_hub_url)}${row(r.mode === 'test' ? 'Test secret key' : 'Live secret key', s.secret_key, 1)}${row('Webhook signing secret', s.webhook_secret, 1)}</div>
    <p class="faint" style="margin-top:8px">${r.mode === 'test' ? 'Tick <b>Test mode</b>.' : 'Untick Test mode.'} Webhook endpoint registered: <span class="mono">${esc(r.webhook_url)}</span>. Store currency must be USD for USDC.</p>`
    + (r.receiving_wallet ? '' : note('info', 'Payment method needed', 'This merchant has no verified receiving wallet yet: the merchant verifies one with MetaMask (Receiving wallet), or switch on sandbox cards in Settings → MetaMask, before checkout can take payments.')),
    foot: '<button class="btn primary" data-act="closeModal">Done</button>' });
};
ACT.aRetry = d => run(() => api('POST', `/a-api/deliveries/${d.id}/retry`), { ok: 'Retry queued' });

/* ---------------- risk & security ---------------- */
VIEWS['a-risk'] = async () => {
  const d = await api('GET', '/a-api/risk'), p = d.posture, o = d.onchain, yes = (v, l) => badge(v ? 'pass' : 'fail', l || (v ? 'yes' : 'no'));
  return head('Super admin', 'Risk & Security', 'Open alerts, on-chain anomalies and the platform security posture.') + mfaWarn()
    + `<div class="grid g4"><div class="card kpi"><div class="label">Open alerts</div><div class="value">${d.alerts.length}</div><div class="sub">across all merchants</div></div>
      <div class="card kpi"><div class="label">Rejected transactions · 24h</div><div class="value">${o.rejected_txs_24h}</div><div class="sub">wrong token / recipient / sender / reverted</div></div>
      <div class="card kpi"><div class="label">Duplicate payments</div><div class="value">${o.duplicate_payments}</div><div class="sub">invoices paid twice — refund needed</div></div>
      <div class="card kpi"><div class="label">Signature mismatches · 7d</div><div class="value">${o.signature_mismatches_7d}</div><div class="sub">wallet ownership attempts</div></div></div>
    <div class="grid g2"><div class="card"><h2>Security posture</h2><div style="margin-top:10px">${kv([['Staff 2FA enforced', yes(p.require_staff_mfa)], ['Active staff without 2FA', p.staff_no_mfa ? badge('fail', String(p.staff_no_mfa)) : badge('pass', '0')], ['Merchant owners without 2FA', String(p.merchant_owners_no_mfa)], ['HTTPS public URL', yes(p.https)], ['NODE_ENV=production', yes(p.production)], ['PostgreSQL', yes(p.postgres)], ['Wallets awaiting review', String(o.wallets_awaiting_review)], ['Login protection', esc(o.failed_logins_note)]])}</div></div>
      <div class="card"><h2>Payment safety controls</h2><div style="margin-top:10px">${kv([['Seed phrases / private keys', 'never requested, never stored'], ['Payer proof', 'EIP-4361 signature per invoice'], ['Paid only when', 'chain ID, USDC contract, recipient, sender, amount, receipt status, confirmations and finality all match'], ['Replay protection', 'one transaction hash → one invoice / refund / statement'], ['Old transfers', 'blocks older than the invoice are rejected'], ['Reorgs', 'receipts re-read every check; confirmations reset on block change'], ['Wrong RPC chain', 'verification pauses']])}</div></div></div>
    <div class="card"><div class="card-head"><h2>Open alerts</h2><a href="#/a-risk" data-act="tab" data-group="alerts" data-tab="all">${''}</a></div>${table([{ h: 'Raised', v: a => fmtDT(a.created_at) }, { h: 'Severity', v: a => badge(a.severity) }, { h: 'Rule', v: a => esc(a.kind.replace(/_/g, ' ')) }, { h: 'Mode', v: a => badge(a.mode) }, { h: 'Detail', v: a => esc(a.detail) },
      { h: '', v: a => can('alerts.manage') ? `<div class="row" style="flex-wrap:nowrap">${a.ref?.startsWith('pay_') ? `<button class="btn sm" data-act="openAdminPayment" data-id="${a.ref}">Open</button>` : ''}${a.status === 'open' ? `<button class="btn sm" data-act="alertSet" data-id="${a.id}" data-s="acknowledged">Acknowledge</button>` : ''}<button class="btn sm primary" data-act="alertSet" data-id="${a.id}" data-s="resolved">Resolve</button></div>` : '' }], d.alerts, { empty: 'No open alerts.' })}</div>
    <div class="card"><div class="card-head"><h2>Security events · 7 days</h2></div>${auditTable(d.security_events)}</div>`;
};
ACT.alertSet = d => run(() => api('POST', `/a-api/alerts/${d.id}`, { status: d.s }));

/* ---------------- approvals ---------------- */
VIEWS['a-approvals'] = async () => {
  const t = tab('ap', 'wallets'); let body = '';
  if (t === 'wallets') { const ws = await api('GET', '/a-api/wallets?status=verified'); body = table([{ h: 'Merchant', v: w => esc(w.merchant_name) }, { h: 'Wallet', v: w => mono(w.address, 10, 6) }, { h: 'Signed', v: w => fmtDT(w.proof?.signed_at) }, { h: '', v: w => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm ghost" data-act="walletProof" data-id="${w.id}">Proof</button><button class="btn sm danger" data-act="walletReview" data-id="${w.id}" data-ok="">Reject</button><button class="btn sm primary" data-act="walletReview" data-id="${w.id}" data-ok="1">Approve</button></div>` }], ws, { empty: 'No wallets waiting.' }); }
  if (t === 'kyb') { const ms = (await api('GET', '/a-api/merchants?status=pending')).filter(m => m.kyb_submitted); body = table([{ h: 'Merchant', v: m => esc(m.name) }, { h: 'Country', v: m => esc(m.country) }, { h: 'Joined', v: m => fmtDate(m.created_at) }], ms, { empty: 'No KYB submissions waiting.', rowAttr: m => `class="click" data-act="openMerchant" data-id="${m.id}"` }); }
  if (t === 'adjust') { const as = (await api('GET', '/a-api/adjustments')).filter(a => a.status === 'pending_approval'); body = table([{ h: 'Drafted', v: a => fmtDT(a.created_at) }, { h: 'Merchant', v: a => `<span class="mono">${esc(short(a.merchant_id))}</span>` }, { h: 'Mode', v: a => badge(a.mode) }, { h: 'Amount', r: 1, v: a => fmt(a.amount, a.currency) }, { h: 'Reason', v: a => esc(a.reason) }, { h: 'Maker', v: a => esc(a.maker) }, { h: '', v: a => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm danger" data-act="adjDecide" data-id="${a.id}" data-d="reject">Reject</button><button class="btn sm primary" data-act="adjDecide" data-id="${a.id}" data-d="approve" ${a.maker === App.me.user.email ? 'disabled title="You drafted this"' : ''}>Approve & post</button></div>` }], as, { empty: 'No adjustments waiting.' }); }
  return head('Super admin', 'Approvals', 'Human decisions for onboarding, wallets and ledger corrections. Every decision is audited.') + mfaWarn()
    + tabs('ap', [['wallets', 'Receiving wallets'], ['kyb', 'KYB'], ['adjust', 'Adjustments']], 'wallets') + body;
};
ACT.adjDecide = d => run(() => api('POST', `/a-api/adjustments/${d.id}/${d.d}`), { ok: d.d === 'approve' ? 'Adjustment posted to ledger' : 'Adjustment rejected' });

/* ---------------- audit, staff ---------------- */
const auditTable = list => table([{ h: 'Time', v: a => fmtDT(a.created_at) }, { h: 'Actor', v: a => esc(a.actor) }, { h: 'Action', v: a => `<span class="mono">${esc(a.action)}</span>` }, { h: 'Target', v: a => `<span class="mono">${esc(short(a.target, 14, 6))}</span>` }, { h: 'Detail', v: a => esc(String(a.detail).slice(0, 120)) }], list, { empty: 'No events.' });
VIEWS['a-audit'] = async () => { const f = App.filters.au ||= { q: '' }; const list = await api('GET', '/a-api/audit' + qs(f)); return head('Super admin', 'Audit Trails', 'Every staff, merchant and system action — wallet proofs, settings changes, refunds, keys, sign-ins — with actor and target.') + `<div class="card">${fInput('au', 'q', 'Search', 'actor, action, ID, wallet')}</div>` + auditTable(list); };
VIEWS['a-staff'] = async () => {
  const d = await api('GET', '/a-api/staff'), me = App.me.user.id, cm = can('staff.manage');
  return head('Super admin', 'Staff & roles', 'Role-based access for the Digital Hub team. Privileged actions require 2FA.', cm ? '<button class="btn primary" data-act="inviteStaff">Invite staff</button>' : '') + mfaWarn()
    + table([{ h: 'Name', v: u => `${esc(u.name)}${u.id === me ? ' <span class="tag">you</span>' : ''}<div class="faint" style="font-size:.75rem">${esc(u.email)}</div>` }, { h: 'Role', v: u => cm && u.id !== me ? `<select data-change="staffRole" data-id="${u.id}" aria-label="Role">${Object.entries(d.roles).map(([k, r]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>` : esc(d.roles[u.role]?.label) },
      { h: '2FA', v: u => badge(u.mfa_enabled ? 'enabled' : 'pending', u.mfa_enabled ? 'on' : 'off') }, { h: 'Status', v: u => badge(u.status) }, { h: 'Last sign-in', v: u => fmtDT(u.last_login) },
      { h: '', v: u => cm && u.id !== me ? `<div class="row" style="flex-wrap:nowrap">${u.mfa_enabled ? `<button class="btn sm" data-act="staffPatch" data-id="${u.id}" data-k="reset_mfa">Reset 2FA</button>` : ''}<button class="btn sm ${u.status === 'active' ? 'danger' : ''}" data-act="staffPatch" data-id="${u.id}" data-k="status" data-v="${u.status === 'active' ? 'disabled' : 'active'}">${u.status === 'active' ? 'Disable' : 'Enable'}</button></div>` : '' }], d.staff)
    + `<div class="card"><h2>Permission matrix</h2><div style="margin-top:10px">${table([{ h: 'Permission', v: k => esc(d.perms[k]) }, ...Object.entries(d.roles).map(([, r]) => ({ h: r.label, v: k => r.perms.includes(k) ? '<span class="yes">✓</span>' : '<span class="no">—</span>' }))], Object.keys(d.perms), { cls: 'matrix' })}</div></div>`;
};
ACT.inviteStaff = () => formModal('Invite staff member', 'staff', `${field('Name', input('name', { req: true }))}${field('Email', input('email', { type: 'email', req: true }))}${field('Role', select('role', [['viewer', 'Read-only auditor'], ['support', 'Support'], ['risk', 'Risk analyst'], ['finance', 'Finance ops'], ['compliance', 'Compliance'], ['super_admin', 'Super admin']]))}`, 'Invite');
FORM.staff = async f => { const r = await api('POST', '/a-api/staff', f); closeModal(); await render(); secretModal('Temporary password', `Share with <b>${esc(r.user.email)}</b> securely. They must change it and enroll 2FA.`, r.temporary_password); };
ACT.staffRole = (d, el) => run(() => api('PATCH', '/a-api/staff/' + d.id, { role: el.value }), { ok: 'Role updated' });
ACT.staffPatch = d => run(() => api('PATCH', '/a-api/staff/' + d.id, d.k === 'reset_mfa' ? { reset_mfa: true } : { [d.k]: d.v }), { ok: 'Staff updated' });

/* ---------------- settings → MetaMask ---------------- */
VIEWS['a-settings'] = async () => {
  const t = tab('set', 'metamask'), ok = can('platform.settings') ? '' : 'disabled';
  let body = '';
  if (t === 'metamask') {
    const d = await api('GET', '/a-api/chain' + (App.cache.probe ? '?probe=1' : '')); App.cache.probe = false;
    body = `<div class="grid g3"><div class="card kpi"><div class="label">Platform mode</div><div class="value">${d.platform_mode === 'live' ? badge('live', 'LIVE · Base mainnet') : badge('sandbox', 'Sandbox · Base Sepolia')}</div><div class="sub">LIVE_PAYMENTS env: ${d.live_payments_env ? 'on' : 'off'}</div></div>
        <div class="card kpi"><div class="label">Payment methods</div><div class="value">${d.providers.card_test !== false ? 'Card (test) + ' : ''}MetaMask · USDC</div><div class="sub"><label class="check"><input type="checkbox" data-change="cardToggle" ${d.providers.card_test !== false ? 'checked' : ''} ${ok}> Card payments in test mode (sandbox test cards, no approval needed)</label>Live cards need a connected acquirer. Binance Pay / Coinbase stay off.</div></div>
        <div class="card kpi"><div class="label">Fee treasury wallet</div><div class="value" style="font-size:1rem">${d.fee_wallet ? mono(d.fee_wallet, 10, 8) : '—'}</div><div class="sub"><a href="#" data-act="editFeeWallet">${d.fee_wallet ? 'Change' : 'Set'}</a></div></div></div>`
      + `<div class="grid g2"><div class="card stack"><div class="card-head" style="margin:0"><h2>MetaMask Connect</h2>${badge(d.sdk.present ? 'active' : 'fail', d.sdk.present ? 'self-hosted' : 'bundle missing')}</div>
          ${kv([['SDK', `<span class="mono">${esc(d.sdk.package)}@${esc(d.sdk.version)}</span>`], ['Served from', `<span class="mono">${esc(d.sdk.path)}</span> · ${Math.round(d.sdk.bytes / 1024)} KB`], ['Handles', 'MetaMask extension, MetaMask Mobile (QR / deeplink), in-app browser'], ['Fallback', 'Extension EIP-6963 provider if the SDK cannot start'], ['Browser read RPC', esc(d.sdk.browser_rpc)]])}
          <div class="row"><button class="btn sm" data-act="testMetaMask">Test MetaMask connection</button></div><div id="mmTestOut" class="faint" style="font-size:.82rem"></div></div>
        <div class="card stack"><div class="card-head" style="margin:0"><h2>Infura</h2>${badge(d.infura.configured ? 'active' : 'pending', d.infura.configured ? 'configured' : 'not configured')}</div>
          ${d.infura.configured ? kv(Object.entries(d.infura.networks).map(([k, x]) => [k === 'base' ? 'Base mainnet' : 'Base Sepolia', `<span class="mono" style="font-size:.75rem">${esc(x.http)}<br>${esc(x.ws)}</span>`]).concat([['Saved in', esc(d.infura.source === 'environment' ? 'Vercel environment (INFURA_API_KEY)' : 'Super Admin settings (encrypted)')], ['API key secret', d.infura.secret ? 'set' : 'not set'], ['Browser key', d.infura.browser_key ? 'set' : 'not set']])) : '<p class="muted">Not connected yet. Paste your Infura API key below — it is tested against Base before it is saved (encrypted).</p>'}
          ${d.infura.source === 'environment' ? '<p class="faint">Managed by the INFURA_API_KEY environment variable.</p>' : `<form class="stack" data-form="infura">${field('Infura API key', input('api_key', { req: true, ph: '32-character key from developer.metamask.io → API keys', extra: 'autocomplete="off" spellcheck="false"' }))}
            ${field('API key secret (only if "Require API key secret" is on)', input('api_secret', { type: 'password', extra: 'autocomplete="off"' }))}
            ${field('Optional browser key (separate key restricted to your domain)', input('browser_key', { extra: 'autocomplete="off" spellcheck="false"' }))}
            <div class="err" id="formErr"></div><div class="row"><button class="btn primary" type="submit" ${ok}>Test & connect Infura</button>${d.infura.configured ? `<button type="button" class="btn danger" data-act="infuraRemove" ${ok}>Disconnect</button>` : ''}</div></form>`}
          <p class="faint">In Infura (developer.metamask.io): open your key → All Endpoints → enable <b>Base Sepolia</b> and <b>Base Mainnet</b>.</p></div></div>`
      + Object.entries(d.networks).map(([k, n]) => networkCard(k, n, ok)).join('')
      + `<div class="card stack"><div class="card-head" style="margin:0"><h2>Base mainnet — production readiness</h2><div class="row"><button class="btn" data-act="prodChecks">Run production checks</button>${d.platform_mode === 'live' ? `<button class="btn danger" data-act="setMode" data-mode="sandbox" ${ok}>Return to sandbox</button>` : `<button class="btn primary" data-act="setMode" data-mode="live" ${ok}>Enable Base mainnet</button>`}</div></div>
        <div id="prodOut"><p class="muted">Runs live probes against the Base mainnet RPC endpoints and the USDC contract, and checks environment, database and security settings. Base mainnet can only be enabled when every required check passes.</p></div></div>
        <div class="card"><div class="card-head"><h2>Recent RPC errors</h2></div>${table([{ h: 'Time', v: e => fmtDT(e.at) }, { h: 'Network', v: e => esc(e.network) }, { h: 'Endpoint', v: e => `<span class="mono">${esc(e.url)}</span>` }, { h: 'Method', v: e => `<span class="mono">${esc(e.method)}</span>` }, { h: 'Error', v: e => esc(e.error) }], d.rpc_errors, { empty: 'None.' })}</div>`;
  }
  if (t === 'platform') {
    const d = await api('GET', '/a-api/platform'), s = d.settings;
    body = `<form class="card stack" data-form="platform"><div class="card-head" style="margin:0"><h2>Rules & defaults</h2><button class="btn primary" type="submit" ${ok}>Save</button></div><div class="form-grid">
      ${field('Default Digital Hub fee on USDC %', input('cryptoPlatPct', { type: 'number', value: s.defaults.cryptoPlatPct, extra: 'step="0.01"' }), 'Applies to merchants created after the change.')}${field('High-value alert above (USD)', input('highValue', { type: 'number', value: s.risk.highValueUSD / 100 }))}</div>
      <label class="check"><input type="checkbox" name="staffMfa" ${d.config.requireStaffMfa ? 'checked' : ''} ${d.config.staffMfaSource.startsWith('environment') ? 'disabled' : ''}> Require two-factor authentication for staff approvals and changes ${d.config.staffMfaSource.startsWith('environment') ? '<span class="faint">(set by REQUIRE_STAFF_MFA in the environment)</span>' : ''}</label>
      <p class="faint" style="margin:-4px 0 0 26px">Off: staff can approve without 2FA. Base mainnet (real money) still requires it in the production checks.</p>
      <label class="check"><input type="checkbox" name="strictKyb" ${s.strictKyb ? 'checked' : ''}> Strict KYB: only approve merchants when every check, owner ID, AML and required document is verified (no exceptions)</label>
      <div class="err" id="formErr"></div></form>
      <div class="card">${kv([['Public URL (MetaMask signatures are bound to this domain)', `<span class="mono">${esc(d.config.publicUrl)}</span>`], ['Live payments env', d.config.livePayments ? badge('active', 'on') : badge('pending', 'off')], ['Staff 2FA enforced', d.config.requireStaffMfa ? 'yes' : 'no (development)']])}</div>`;
  }
  if (t === 'diagnostics') {
    const g = await api('GET', '/a-api/diagnostics'), a = g.api_24h, w = g.webhooks_24h;
    const kpi = (l, v, s, bad) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${bad ? badge('fail', v) : v}</div><div class="sub">${s}</div></div>`;
    body = `<div class="row" style="justify-content:flex-end"><button class="btn" data-act="refreshDiag">Run diagnostics again</button></div>
      <div class="grid g4">${kpi('Database', g.server.db_latency_ms + ' ms', `${g.server.db} · one query`, g.server.db_latency_ms > 300)}${kpi('API · 24 h', a.calls + ' calls', `${a.errors} errors (${a.error_rate}%) · p50 ${a.p50_ms} ms · p95 ${a.p95_ms} ms`, a.error_rate > 20)}
        ${kpi('Webhooks · 24 h', w.delivered + ' delivered', `${w.pending} pending · ${w.retrying} retrying · ${w.failed} failed`, w.failed > 0)}${kpi('Server', esc(g.server.node), `${g.server.serverless ? 'Vercel' + (g.server.region ? ' · ' + esc(g.server.region) : '') : 'long-running'} · up ${g.server.uptime_s}s`)}</div>
      <div class="grid g2"><div class="card"><h2>Blockchain RPC & monitor</h2><div style="margin-top:10px">${Object.entries(g.rpc).map(([k, r]) => `<h3>${k === 'base' ? 'Base mainnet' : 'Base Sepolia'}</h3>${kv([['Source', esc(r.source)], ['Endpoints', r.endpoints.map(e => `<span class="mono" style="font-size:.75rem">${esc(e.url)}</span> ${e.ok == null ? '<span class="faint">untested</span>' : badge(e.ok ? 'pass' : 'fail', e.ok ? (e.ms != null ? e.ms + ' ms' : 'ok') : 'down')}`).join('<br>')], ['WebSocket', esc(r.ws.status)], ['Monitor', r.monitor ? (r.monitor.ok === false ? badge('fail', r.monitor.error) : r.monitor.head ? `head #${r.monitor.head} · ${fmtDT(r.monitor.at)}` : 'idle · ' + fmtDT(r.monitor.at)) : 'not run yet']])}`).join('')}</div></div>
        <div class="card"><h2>Payments, wallets & errors</h2><div style="margin-top:10px">${kv([['Payments 24 h (' + App.mode + ')', Object.entries(g.payments_24h).map(([s, n]) => `${badge(s)} ${n}`).join(' ') || 'none'], ['Merchant wallets', `${g.wallets.approved} approved · ${g.wallets.signature_verified} signed (awaiting review) · ${g.wallets.awaiting_signature} awaiting signature`],
          ['Infura', g.infura.configured ? badge('active', 'INFURA_API_KEY set') + (g.infura.secret ? ' + secret' : '') : '<span class="faint">not configured</span>'], ['Top API errors', a.top_errors.map(([c, n]) => `<span class="mono">${esc(c)}</span> × ${n}`).join('<br>') || 'none'],
          ['Recent RPC errors', g.rpc_errors.map(e => `${esc(e.network)} · <span class="mono">${esc(e.method)}</span>: ${esc(e.error)}`).join('<br>') || 'none']])}</div></div></div>`;
  }
  return head('Super admin', 'MetaMask & Blockchain', 'MetaMask Connect, Infura and Base RPC providers, Base Sepolia (test) and Base mainnet (live), the verified USDC contracts, confirmations and finality, connection tests and API diagnostics.') + mfaWarn()
    + tabs('set', [['metamask', 'MetaMask & Blockchain'], ['diagnostics', 'API diagnostics'], ['platform', 'Platform rules']], 'metamask') + body;
};
function networkCard(k, n, ok) {
  const mon = n.monitor, tok = n.token;
  return `<form class="card stack" data-form="network" data-key="${k}"><div class="card-head" style="margin:0"><h2>${esc(n.chainName)} <span class="faint" style="font-weight:600">· chain ${n.chainId} · ${n.mode === 'test' ? 'test mode' : 'live mode'}</span></h2><div class="row">${badge(n.enabled ? 'active' : 'disabled', n.enabled ? 'enabled' : 'disabled')}<button type="button" class="btn sm" data-act="probeNet" data-key="${k}">Test RPC & token</button><button class="btn sm primary" type="submit" ${ok}>Save</button></div></div>
    <div class="grid g2"><div class="stack">
      ${field('Verified USDC contract', n.usdc_pinned ? `<input type="text" value="${esc(n.usdc)}" disabled>` : input('usdc', { value: n.usdc }), n.usdc_pinned ? "Pinned to Circle's canonical USDC — cannot be changed." : `Canonical: <span class="mono">${esc(n.usdc_canonical)}</span>. Changes are checked on-chain (symbol USDC, 6 decimals).`)}
      <div class="form-grid">${field('Confirmations', input('confirmations', { type: 'number', value: n.confirmations, extra: `min="${n.min_confirmations}" max="500"` }), `Minimum ${n.min_confirmations}.`)}${field('Finality', select('finality', [['confirmations', 'Confirmations only'], ['safe', 'Confirmations + safe head'], ['finalized', 'Confirmations + finalized (L1)']], n.finality))}
      ${field('Payment window (minutes)', input('quote_minutes', { type: 'number', value: n.quote_minutes, extra: 'min="5" max="180"' }))}<div class="field"><span>Explorer</span><a href="${esc(n.blockExplorerUrls[0])}" target="_blank" rel="noopener" style="padding:8px 0">${esc(n.blockExplorerUrls[0].replace('https://', ''))}</a></div></div>
      ${n.rpc_env_locked ? note('info', 'RPC from environment', `${esc(n.rpc_source)} — edit the server environment to change.`) : field('RPC endpoints (one per line, tried in order)', `<textarea name="rpc_urls" placeholder="https://base-sepolia.g.alchemy.com/v2/KEY" spellcheck="false">${''}</textarea>`, `Currently ${n.rpc_count} from ${esc(n.rpc_source)}. Leave empty to keep. Each endpoint must answer chain ${n.chainId}. Stored encrypted; never sent to browsers.`)}
      ${n.ws_env_locked ? note('info', 'WebSocket from environment', '') : field('WebSocket endpoint (optional)', input('ws_url', { ph: 'wss://…' }), 'Live block subscriptions on the long-running server. Leave empty to keep.')}
    </div><div class="stack">
      <h3>RPC providers</h3>${table([{ h: 'Endpoint', v: r => `<span class="mono" style="font-size:.75rem">${esc(r.url)}</span>` }, { h: 'Health', v: r => r.ok == null ? '<span class="faint">untested</span>' : badge(r.ok ? 'pass' : 'fail', r.ok ? 'ok' : 'down') + (r.error ? `<div class="faint" style="font-size:.72rem">${esc(r.error)}</div>` : '') }, { h: 'Block', r: 1, v: r => r.block ?? '—' }, { h: 'ms', r: 1, v: r => r.ms ?? '—' }], n.rpcs, { empty: 'None.' })}
      ${kv([['USDC token check', tok ? (tok.ok ? badge('pass', `${tok.symbol} · ${tok.decimals} dec`) : badge('fail', tok.error || 'failed')) : '<span class="faint">not run</span>'], ['WebSocket', esc(n.ws.status) + (n.ws.last_head ? ` · head #${n.ws.last_head}` : '')], ['Monitor', mon ? (mon.ok === false ? badge('fail', mon.error) : mon.head ? `head #${mon.head}${mon.final != null ? ` · final #${mon.final}` : ''} · ${mon.watched || 0} watched · ${fmtDT(mon.at)}` : 'idle') : 'not run yet'], ['Scan cursor', n.scan_cursor ?? '—'],
        ['Network params for MetaMask', `<span class="mono" style="font-size:.72rem">${esc(n.chainIdHex)} · ${esc(n.rpcUrls[0])}</span>`]])}
    </div></div><div class="err" id="formErr"></div></form>`;
}
FORM.network = async (f, form) => {
  const body = { confirmations: +f.confirmations, finality: f.finality, quote_minutes: +f.quote_minutes };
  if (f.usdc !== undefined) body.usdc = f.usdc.trim();
  if (f.rpc_urls && f.rpc_urls.trim()) body.rpc_urls = f.rpc_urls.split(/\s+/).filter(Boolean);
  if (f.ws_url && f.ws_url.trim()) body.ws_url = f.ws_url.trim();
  await api('POST', `/a-api/chain/networks/${form.dataset.key}`, body); toast('Network settings saved'); render();
};
ACT.probeNet = d => run(async () => { const r = await api('POST', `/a-api/chain/probe/${d.key}`); if (!r.token.ok) throw new Error('Token check failed: ' + r.token.error); if (r.rpcs.some(x => !x.ok)) throw new Error('An RPC endpoint failed: ' + r.rpcs.filter(x => !x.ok).map(x => `${x.url}: ${x.error}`).join('; ')); }, { ok: 'RPC endpoints and USDC contract verified' });
ACT.prodChecks = () => run(async () => {
  $('#prodOut').innerHTML = '<div class="loading">Probing Base mainnet…</div>';
  const r = await api('GET', '/a-api/chain/production-checks');
  $('#prodOut').innerHTML = `${r.ready ? note('info', 'Ready', 'All required checks pass.') : note('warn', 'Not ready', 'Fix the failing required checks before enabling Base mainnet.')}<div class="stack" style="margin-top:10px">${r.checks.map(c => `<div class="check-row"><div><b>${esc(c.label)}</b>${c.required ? '' : ' <span class="tag">recommended</span>'}<div class="muted" style="font-size:.82rem;overflow-wrap:anywhere">${esc(c.detail || '')}</div></div>${badge(c.ok ? 'pass' : c.required ? 'fail' : 'attention', c.ok ? 'pass' : c.required ? 'fail' : 'warn')}</div>`).join('<div class="divider"></div>')}</div>`;
}, { noRefresh: true });
ACT.setMode = d => confirmBox(d.mode === 'live' ? 'Enable Base mainnet?' : 'Return to sandbox?', d.mode === 'live' ? 'Live-enabled merchants will receive real USDC on Base mainnet into their approved wallets. Production checks run again before the switch.' : 'Base mainnet checkout stops immediately for every merchant. In-flight payments keep being verified.', 'Confirm', () => api('POST', '/a-api/chain/mode', { mode: d.mode }), d.mode !== 'live');
ACT.refreshDiag = () => render();
FORM.infura = async f => {
  const r = await api('POST', '/a-api/chain/infura', f);
  toast(`Infura connected · Base Sepolia ${r.test.base_sepolia.ok ? 'OK' : 'failed'} · Base Mainnet ${r.test.base.ok ? 'OK' : 'not enabled on this key'}`); render();
};
ACT.infuraRemove = () => confirmBox('Disconnect Infura?', 'Monitoring falls back to admin-configured or public Base endpoints.', 'Disconnect', () => api('POST', '/a-api/chain/infura', { remove: true }));
/** Real wallet test from the admin's browser: connect through MetaMask Connect, read chain and a balance. Nothing is signed or sent. */
ACT.testMetaMask = () => run(async () => {
  const out = $('#mmTestOut'), chain = (await api('GET', '/m-api/wallets').catch(() => null))?.chain || { chainIdHex: App.mode === 'test' ? '0x14a34' : '0x2105', chainName: App.mode === 'test' ? 'Base Sepolia' : 'Base', rpcUrls: [App.mode === 'test' ? 'https://sepolia.base.org' : 'https://mainnet.base.org'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: [] };
  out.textContent = 'Opening MetaMask…';
  try {
    const w = await DHMetaMask.connect(chain), cid = await DHMetaMask.chainId(w.provider), bal = await DHMetaMask.nativeBalance(w.provider, w.account).catch(() => null);
    out.innerHTML = `Connected via <b>${esc(w.via)}</b> · account <span class="mono">${esc(short(w.account, 8, 6))}</span> · chain ${esc(cid)}${cid === chain.chainIdHex ? '' : ' (not ' + esc(chain.chainName) + ' — checkout will ask to switch)'}${bal != null ? ` · ${(Number(bal) / 1e18).toFixed(5)} ETH` : ''}${DHMetaMask.sdkError ? ` · SDK fallback: ${esc(DHMetaMask.sdkError.message)}` : ''}`;
  } catch (e) { out.textContent = 'MetaMask: ' + mmErr(e); throw new Error(mmErr(e)); }
}, { noRefresh: true });
ACT.cardToggle = (d, el) => run(() => api('PATCH', '/a-api/chain', { card_sandbox: el.checked }), { ok: el.checked ? 'Card payments enabled (sandbox test cards)' : 'Card payments disabled' });
ACT.editFeeWallet = () => formModal('Fee treasury wallet', 'feeWallet', note('info', '', 'Merchants pay Digital Hub fee statements in USDC to this address. Use a wallet Digital Hub controls (hardware wallet / multisig recommended).') + field('Address', input('fee_wallet', { ph: '0x…', extra: 'spellcheck="false"' })), 'Save');
FORM.feeWallet = async f => { await api('PATCH', '/a-api/chain', f); closeModal(); toast('Fee wallet saved'); render(); };
FORM.platform = async f => { const p = await api('GET', '/a-api/platform'), s = p.settings; await api('PATCH', '/a-api/platform', { risk: { declineCount: s.risk.declineCount, highValueUSD: toMinor(f.highValue) }, defaults: { ...s.defaults, cryptoPlatPct: +f.cryptoPlatPct }, strictKyb: !!f.strictKyb, ...(f.staffMfa === undefined ? {} : { staffMfa: !!f.staffMfa }) }); toast('Platform settings saved'); await loadMe(); };

App.boot();
