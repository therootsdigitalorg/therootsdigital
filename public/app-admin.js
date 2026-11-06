'use strict';
/* Super Admin console: merchants, Digital Hub Wallet records, Cash App Pay integration and controls. */
NAV.admin = [
  ['Platform', [['a-overview', 'Overview'], ['a-merchants', 'Merchants'], ['a-approvals', 'Approvals'], ['a-payments', 'Transactions']]],
  ['Money', [['a-disputes', 'Refunds & disputes'], ['a-settlements', 'Settlements'], ['a-ledger', 'Ledger & reconciliation']]],
  ['Cash App Pay', [['a-cashapp', 'Integration'], ['a-webhooks', 'Webhook deliveries']]],
  ['Governance', [['a-alerts', 'Risk alerts'], ['a-audit', 'Audit log'], ['a-staff', 'Staff & roles'], ['a-platform', 'Platform settings']]],
];
const mfaWarn = () => App.me.config.requireStaffMfa && !App.me.user.mfa_enabled ? note('danger', '2FA required', 'Enroll two-factor authentication before privileged actions. <a href="#/account">Set up 2FA →</a>') : (!App.me.user.mfa_enabled ? note('warn', '2FA recommended', 'Your account has no 2FA. Production enforces it for all staff. <a href="#/account">Set up 2FA →</a>') : '');
const modeLabel = () => App.mode === 'test' ? 'test data' : 'live data';
const caBadge = s => badge(String(s || 'NOT_REGISTERED').toLowerCase(), String(s || 'not registered').replace(/_/g, ' ').toLowerCase());

VIEWS['a-overview'] = async () => {
  const d = await api('GET', '/a-api/overview'), q = d.queues;
  return head('Super admin', 'Platform overview', `All merchants · ${modeLabel()} · last 30 days · Cash App: ${esc(App.mode === 'test' ? d.cashapp.test : d.cashapp.live)}`, can('platform.settings') ? '<button class="btn" data-act="runJobs">Sync Cash App & run jobs</button>' : '')
    + mfaWarn() + (d.live_payments ? '' : note('info', 'Sandbox platform', 'LIVE_PAYMENTS is off: merchants can only use test mode. Turn it on after Cash App approves Digital Hub as a partner and production credentials are set.'))
    + `<div class="grid g4"><div class="card kpi"><div class="label">Processed volume</div><div class="value">${usd(d.volume_usd)}</div><div class="sub">${d.payments} confirmed payments</div></div>
      <div class="card kpi"><div class="label">Platform revenue</div><div class="value">${usd(d.revenue_usd)}</div><div class="sub">commission, from ledger</div></div>
      <div class="card kpi"><div class="label">Refunds · disputes</div><div class="value">${usd(d.refunded_usd)}</div><div class="sub">${d.disputes_open} open disputes · ${d.failed} failed payments</div></div>
      <div class="card kpi"><div class="label">Merchants</div><div class="value">${d.merchants.approved} approved</div><div class="sub">${d.merchants.total} total · ${d.merchants.pending} pending · ${d.merchants.suspended} suspended</div></div></div>
    <div class="split"><div class="card"><div class="card-head"><h2>Platform volume</h2><span class="faint">14 days</span></div>${barChart(d.series)}</div>
      <div class="card"><div class="card-head"><h2>Work queues</h2><a href="#/a-approvals">Approvals →</a></div>${kv([['KYB reviews', q.kyb], ['Cash App production registrations', q.cashapp_registrations], ['Payouts', q.payouts], ['Bank accounts', q.destinations], ['Pending refunds', q.refunds], ['Ledger adjustments', q.adjustments], ['Open risk alerts', q.alerts], ['Reconciliation', d.recon_ok ? badge('pass', 'all passing') : badge('fail', 'issues')]])}</div></div>
    <div class="card"><div class="card-head"><h2>Latest audit events</h2><a href="#/a-audit">Audit log →</a></div>${auditTable(d.audit)}</div>`;
};
ACT.runJobs = () => run(() => api('POST', '/a-api/jobs/run'), { ok: 'Cash App sync, settlement, expiries and webhooks ran' });

/* ---------------- merchants ---------------- */
VIEWS['a-merchants'] = async () => {
  const f = App.filters.am ||= { q: '', status: '' };
  const rows = await api('GET', '/a-api/merchants' + qs(f));
  return head('Super admin', 'Merchants', 'Onboarding, verification, Cash App registration, permissions, limits, fees, wallets and live activation.')
    + mfaWarn() + `<div class="card"><div class="grid g3">${fInput('am', 'q', 'Search', 'Name, website, ID, email')}${fSelect('am', 'status', 'Status', [['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['suspended', 'Suspended'], ['rejected', 'Rejected']])}<div class="field"><span>Total</span><div class="num" style="padding:8px 0">${rows.length} merchants</div></div></div></div>`
    + table([{ h: 'Merchant', v: m => `<b>${esc(m.name)}</b><div class="faint" style="font-size:.75rem">${esc(m.legal_name)} · ${esc(m.id)}</div>` }, { h: 'Country', v: m => esc(m.country) }, { h: 'Status', v: m => badge(m.status) + (m.kyb_submitted && m.status === 'pending' ? ' <span class="tag">KYB submitted</span>' : '') },
      { h: 'Cash App sandbox', v: m => caBadge(m.cashapp.test) }, { h: 'Cash App production', v: m => caBadge(m.cashapp.live) }, { h: 'Live', v: m => m.live_enabled ? badge('active', 'live') : '<span class="faint">test only</span>' },
      { h: 'Volume 30d', r: 1, v: m => usd(m.volume_30d_usd) }, { h: 'Flags', v: m => (m.hold ? badge('held', 'payout hold') : '') + ' ' + badge(m.risk === 'low' ? 'approved' : m.risk, 'risk ' + m.risk) }], rows, { rowAttr: m => `class="click" tabindex="0" data-act="openMerchant" data-id="${m.id}"`, empty: 'No merchants match.' });
};
const CHECKS = [['registration', 'Registration certificate / EIN verified'], ['owners', 'Beneficial owners identified and ID-verified'], ['website', 'Website, products and refund policy reviewed'], ['sanctions', 'Sanctions / PEP screening clear'], ['bank', 'Settlement bank account ownership confirmed']];
const PERMS = [['cashapp', 'Cash App Pay checkout'], ['payouts', 'Payouts'], ['refunds', 'Refunds'], ['links', 'Payment links'], ['api', 'API access']];
ACT.openMerchant = d => { App.tabs.md = App.tabs.md || 'verify'; App.cache.mid = d.id; openDrawer(merchantDrawer); };
async function merchantDrawer() {
  const x = await api('GET', '/a-api/merchants/' + App.cache.mid), m = x.merchant, t = tab('md', 'verify'), dis = p => can(p) ? '' : 'disabled';
  let b = `<div class="row" style="justify-content:space-between"><div><b>${esc(m.legal_name)}</b><div class="faint mono">${esc(m.id)}</div></div><div class="row" style="gap:6px">${badge(m.status)}${m.live_enabled ? badge('active', 'live') : ''}${m.settlementHold ? badge('held', 'hold') : ''}</div></div>`
    + tabs('md', [['verify', 'Verification'], ['cashapp', 'Cash App Pay'], ['controls', 'Controls'], ['pricing', 'Fees'], ['access', 'Keys & users'], ['money', 'Wallet']], 'verify');
  if (t === 'verify') {
    const biz = m.kyb.business || {};
    b += kv([['Website', esc(m.website)], ['Support', esc(m.support_email)], ['Country', esc(m.country)], ['Joined', fmtDate(m.created_at)], ['KYB submitted', m.kyb.submitted ? fmtDT(m.kyb.submitted_at) : 'No'], ['Registration no.', esc(biz.registration_number)], ['Address', esc(biz.address)], ['Business', esc(biz.description)], ['Expected volume', biz.monthly_volume_usd ? usd(biz.monthly_volume_usd * 100) + '/month' : '—']]);
    b += `<h3>KYB checklist</h3><div class="stack">${CHECKS.map(([k, l]) => `<label class="check"><input type="checkbox" data-change="kybCheck" data-k="${k}" ${m.kyb.checks[k] ? 'checked' : ''} ${dis('merchants.manage')}> ${esc(l)}</label>`).join('')}</div>`;
    b += `<h3>Owners (KYC)</h3>` + table([{ h: 'Name', v: o => esc(o.name) }, { h: 'Owns', r: 1, v: o => (o.pct ?? '—') + '%' }, { h: 'Nationality', v: o => esc(o.nationality || '—') }, { h: 'ID', v: o => badge(o.idStatus) }, { h: '', v: o => o.idStatus !== 'verified' && can('merchants.manage') ? `<div class="row" style="flex-wrap:nowrap"><button class="btn sm danger" data-act="ownerKyc" data-i="${m.kyb.owners.indexOf(o)}" data-s="rejected">Reject</button><button class="btn sm primary" data-act="ownerKyc" data-i="${m.kyb.owners.indexOf(o)}" data-s="verified">Verify ID</button></div>` : '' }], m.kyb.owners, { empty: 'Owners not submitted yet.' });
    b += `<div class="card-head" style="margin:8px 0 0"><h3>AML screening</h3>${can('merchants.manage') ? '<button class="btn sm" data-act="amlRun">Run screening</button>' : ''}</div>` + kv([['Result', badge(m.kyb.aml.status)], ['Last run', fmtDT(m.kyb.aml.at)], ['Note', esc(m.kyb.aml.note || 'Connect a screening vendor (sanctions, PEP, adverse media) for production.')]]);
    if (!x.kyb_ready) b += note('warn', '', 'Approval unlocks when every check is ticked, every owner is verified and AML is clear.');
  }
  if (t === 'cashapp') {
    const a = m.cashapp.details?.address || {};
    const env = (mode, s) => `<div class="card stack"><div class="card-head" style="margin:0"><h3>${mode === 'test' ? 'Sandbox' : 'Production'}</h3>${caBadge(s.status)}</div>${kv([['Environment', esc(s.environment)], ['Brand', `<span class="mono">${esc(s.brand_id || '—')}</span>`], ['Merchant', `<span class="mono">${esc(s.merchant_id || '—')}</span>`], ['Registered', fmtDT(s.registered_at)], s.error && ['Last error', `<span class="err">${esc(s.error)}</span>`]])}
      <button class="btn ${s.ready ? '' : 'primary'}" data-act="caRegister" data-mode="${mode}" ${dis('merchants.manage')} ${mode === 'live' && m.status !== 'approved' ? 'disabled title="Approve KYB first"' : ''}>${s.merchant_id ? 'Refresh from Cash App' : `Register with Cash App ${mode === 'test' ? 'sandbox' : 'production'}`}</button></div>`;
    b += `<div class="grid g2">${env('test', x.cashapp.test)}${env('live', x.cashapp.live)}</div>
      <h3>Business details sent to Cash App</h3>${m.cashapp.details ? kv([['Address', esc([a.address_line_1, a.address_line_2, a.locality, a.administrative_district_level_1, a.postal_code].filter(Boolean).join(', '))], ['MCC', esc(m.cashapp.details.category)], ['Website', esc(m.cashapp.details.site_url || '—')]]) : '<p class="muted">The merchant has not submitted Cash App details yet (Settings → Cash App Pay).</p>'}
      <h3>Live mode</h3>${kv([['Status', m.live_enabled ? badge('active', 'enabled') : badge('pending', 'disabled')], ['Blocker', esc(x.live_ready || 'None')]])}<button class="btn ${m.live_enabled ? 'danger' : 'primary'}" data-act="mLive" data-on="${m.live_enabled ? '' : '1'}" ${dis('merchants.live')}>${m.live_enabled ? 'Disable live mode' : 'Activate live mode'}</button>`;
  }
  if (t === 'controls') b += `<form class="stack" data-form="mControls"><h3>Permissions</h3><div class="form-grid">${PERMS.map(([k, l]) => `<label class="check"><input type="checkbox" name="perm_${k}" ${m.perms[k] ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
    <h3>Payment limits (USD)</h3><div class="form-grid">${field('Per transaction', input('perTxnUSD', { type: 'number', value: m.limits.perTxnUSD / 100 }))}${field('Daily volume', input('dailyUSD', { type: 'number', value: m.limits.dailyUSD / 100 }))}${field('30-day volume', input('monthlyUSD', { type: 'number', value: m.limits.monthlyUSD / 100 }))}${field('Daily refunds', input('refundDailyUSD', { type: 'number', value: m.limits.refundDailyUSD / 100 }))}</div>
    <h3>Risk</h3><div class="form-grid">${field('Risk tier', select('risk', ['low', 'medium', 'high'], m.risk))}${field('Max attempts per customer / hour', input('velocity', { type: 'number', value: m.controls.velocityPerHour }))}</div>
    <div class="err" id="formErr"></div><div><button class="btn primary" type="submit" ${dis('merchants.controls')}>Save controls</button></div></form>
    <div class="divider"></div><h3>Settlement hold</h3>${m.settlementHold ? kv([['Reason', esc(m.settlementHold.reason)], ['Since', fmtDT(m.settlementHold.at)], ['By', esc(m.settlementHold.by)]]) + `<button class="btn" data-act="holdRelease" ${dis('payouts.approve')}>Release hold</button>` : `<p class="muted">Payments keep settling into the wallet, but no payout leaves while a hold is active.</p><button class="btn danger" data-act="holdPlace" ${dis('payouts.approve')}>Place hold</button>`}`;
  if (t === 'pricing') { const f = m.fees; b += `<p class="muted">Cash App's own processing fee comes from each payment (fee_amount). These are Digital Hub's fees on top.</p><form class="form-grid" data-form="mPricing">
    ${field('Platform fee %', input('platPct', { type: 'number', value: f.platPct, extra: 'step="0.01"' }))}${field('Platform fixed fee (USD)', input('platFixed', { type: 'number', value: f.platFixedUSD / 100, extra: 'step="0.01"' }))}
    ${field('Dispute fee (USD)', input('disputeFee', { type: 'number', value: f.disputeFeeUSD / 100, extra: 'step="0.01"' }))}${field('Capture', select('captureMode', [['auto', 'Automatic'], ['manual', 'Manual']], m.captureMode))}
    ${field('Rolling reserve %', input('reservePct', { type: 'number', value: m.reserve.pct, extra: 'step="0.5"' }))}${field('Reserve days', input('reserveDays', { type: 'number', value: m.reserve.days }))}
    <div class="err full" id="formErr"></div><button class="btn primary full" type="submit" ${dis('merchants.pricing')}>Save fees (applies to new payments)</button></form>`; }
  if (t === 'access') {
    b += `<h3>API keys</h3>` + table([{ h: 'Mode', v: k => badge(k.mode) }, { h: 'Key', v: k => `<span class="mono">${esc(k.prefix)}…${esc(k.last4)}</span> <span class="faint">${esc(k.name)}</span>` }, { h: 'Last used', v: k => fmtDT(k.last_used) }, { h: 'Status', v: k => badge(k.status) }, { h: '', v: k => k.status === 'active' && can('merchants.controls') ? `<button class="btn sm danger" data-act="adminRevokeKey" data-key="${k.id}">Revoke</button>` : '' }], x.keys, { empty: 'No keys.' });
    b += `<h3>Users</h3>` + table([{ h: 'User', v: u => `${esc(u.name)}<div class="faint" style="font-size:.75rem">${esc(u.email)}</div>` }, { h: 'Role', v: u => esc(u.role) }, { h: '2FA', v: u => badge(u.mfa_enabled ? 'enabled' : 'pending', u.mfa_enabled ? 'on' : 'off') }, { h: 'Status', v: u => badge(u.status) }, { h: '', v: u => can('merchants.manage') ? `<button class="btn sm ghost" data-act="mUser" data-user="${u.id}" data-on="${u.status === 'active' ? '' : '1'}">${u.status === 'active' ? 'Disable' : 'Enable'}</button>` : '' }], x.users);
    b += `<h3>Webhook endpoints</h3>` + table([{ h: 'Mode', v: e => badge(e.mode) }, { h: 'URL', v: e => `<span class="mono">${esc(e.url)}</span>` }, { h: 'Status', v: e => badge(e.status) }], x.webhooks, { empty: 'None.' });
  }
  if (t === 'money') {
    b += ['test', 'live'].map(mode => `<h3>${mode === 'test' ? 'Test' : 'Live'} wallet</h3>` + table([{ h: 'Currency', v: ([c]) => c }, { h: 'Pending', r: 1, v: ([c, v]) => fmt(v.pending, c) }, { h: 'Available', r: 1, v: ([c, v]) => fmt(v.available, c) }, { h: 'Reserve', r: 1, v: ([c, v]) => fmt(v.reserve, c) }, { h: 'Hold', r: 1, v: ([c, v]) => fmt(v.hold, c) }], Object.entries(x.balances[mode]), { empty: 'No balance.' })).join('');
    b += `<h3>Manual adjustment (maker-checker)</h3><form class="form-grid" data-form="adjustment">${field('Mode', select('mode', ['test', 'live'], App.mode))}${field('Currency', select('currency', FIAT, 'USD'))}${field('Amount (+ credits merchant, − debits)', input('amount', { type: 'number', req: true, extra: 'step="0.01"' }))}
      <label class="field full"><span>Reason (audit trail)</span>${input('reason', { req: true, extra: 'minlength="10"' })}</label><div class="err full" id="formErr"></div><button class="btn full" type="submit" ${dis('finance.adjust')}>Draft adjustment for second approval</button></form>`;
  }
  let foot = '';
  if (can('merchants.manage')) {
    if (m.status === 'pending') foot = `<button class="btn danger" data-act="mStatus" data-s="rejected">Reject</button><button class="btn primary" data-act="mStatus" data-s="approved" ${x.kyb_ready ? '' : 'disabled title="Complete KYB, KYC and AML first"'}>Approve merchant</button>`;
    else if (m.status === 'approved') foot = `<button class="btn danger" data-act="mStatus" data-s="suspended">Suspend</button>`;
    else foot = `<button class="btn" data-act="mStatus" data-s="pending">Reopen review</button>${m.status === 'suspended' ? `<button class="btn primary" data-act="mStatus" data-s="approved" ${x.kyb_ready ? '' : 'disabled'}>Reactivate</button>` : ''}`;
  }
  return { title: m.name, body: b, foot };
}
const mid = () => App.cache.mid;
ACT.kybCheck = (d, el) => run(() => api('POST', `/a-api/merchants/${mid()}/kyb`, { check: d.k, value: el.checked }));
ACT.ownerKyc = d => run(() => api('POST', `/a-api/merchants/${mid()}/kyb`, { owner: +d.i, idStatus: d.s }), { ok: 'Owner updated' });
ACT.amlRun = () => run(() => api('POST', `/a-api/merchants/${mid()}/kyb`, { aml: true }), { ok: 'Screening complete' });
ACT.caRegister = d => run(() => api('POST', `/a-api/merchants/${mid()}/cashapp/register`, { mode: d.mode }), { ok: 'Cash App registration updated' });
ACT.mStatus = d => confirmBox(`Set merchant to ${d.s}?`, d.s === 'suspended' ? 'All payments and payouts stop and live mode is switched off.' : d.s === 'approved' ? 'The merchant can be registered with Cash App production and request payouts.' : 'The merchant sees this in their dashboard.', 'Confirm', () => api('POST', `/a-api/merchants/${mid()}/status`, { status: d.s }), d.s !== 'approved');
FORM.mControls = async f => { await api('PATCH', `/a-api/merchants/${mid()}/controls`, { perms: Object.fromEntries(PERMS.map(([k]) => [k, f['perm_' + k]])), risk: f.risk,
  limits: { perTxnUSD: toMinor(f.perTxnUSD), dailyUSD: toMinor(f.dailyUSD), monthlyUSD: toMinor(f.monthlyUSD), refundDailyUSD: toMinor(f.refundDailyUSD) }, controls: { velocityPerHour: +f.velocity, blockedCountries: [] } }); toast('Controls saved'); refreshDrawer(); render(); };
FORM.mPricing = async f => { await api('PATCH', `/a-api/merchants/${mid()}/pricing`, { platPct: +f.platPct, platFixedUSD: toMinor(f.platFixed), disputeFeeUSD: toMinor(f.disputeFee), reservePct: +f.reservePct, reserveDays: +f.reserveDays, captureMode: f.captureMode }); toast('Fees saved'); refreshDrawer(); };
ACT.holdPlace = () => formModal('Place settlement hold', 'hold', field('Reason (shown to the merchant)', '<textarea name="reason" required minlength="5"></textarea>'), 'Place hold');
FORM.hold = async f => { await api('POST', `/a-api/merchants/${mid()}/hold`, f); closeModal(); toast('Hold placed'); refreshDrawer(); render(); };
ACT.holdRelease = () => run(() => api('POST', `/a-api/merchants/${mid()}/hold`, { release: true }), { ok: 'Hold released' });
ACT.mLive = d => confirmBox(d.on ? 'Activate live mode?' : 'Disable live mode?', d.on ? 'The merchant can create live keys and accept real Cash App payments.' : 'Live keys stop working immediately.', 'Confirm', () => api('POST', `/a-api/merchants/${mid()}/live`, { enabled: !!d.on }), !d.on);
ACT.adminRevokeKey = d => confirmBox('Revoke this API key?', 'The merchant\'s integration using it stops working immediately.', 'Revoke', () => api('POST', `/a-api/merchants/${mid()}/keys/${d.key}/revoke`));
ACT.mUser = d => run(() => api('POST', `/a-api/merchants/${mid()}/users/${d.user}/status`, { active: !!d.on }), { ok: 'User updated' });
FORM.adjustment = async (f, form) => { await api('POST', '/a-api/adjustments', { merchant: mid(), mode: f.mode, currency: f.currency, amount: toMinor(f.amount), reason: f.reason }); form.reset(); toast('Drafted — a different staff member must approve it under Approvals'); render(); };

/* ---------------- approvals ---------------- */
VIEWS['a-approvals'] = async () => {
  const t = tab('ap', 'kyb'); let body = '';
  if (t === 'kyb') { const ms = (await api('GET', '/a-api/merchants?status=pending')).filter(m => m.kyb_submitted); body = table([{ h: 'Merchant', v: m => esc(m.name) }, { h: 'Country', v: m => esc(m.country) }, { h: 'Joined', v: m => fmtDate(m.created_at) }], ms, { empty: 'No KYB submissions waiting.', rowAttr: m => `class="click" data-act="openMerchant" data-id="${m.id}"` }); }
  if (t === 'cashapp') { const ms = (await api('GET', '/a-api/merchants?status=approved')).filter(m => m.cashapp.live === 'NOT_REGISTERED' || m.cashapp.live === 'PENDING'); body = `<p class="muted">Approved merchants not yet active with Cash App production. Open one and use Cash App Pay → Register.</p>` + table([{ h: 'Merchant', v: m => esc(m.name) }, { h: 'Sandbox', v: m => caBadge(m.cashapp.test) }, { h: 'Production', v: m => caBadge(m.cashapp.live) }], ms, { empty: 'Nothing waiting.', rowAttr: m => `class="click" data-act="openMerchant" data-id="${m.id}"` }); }
  if (t === 'payouts') { const ps = await api('GET', '/a-api/payouts?status=pending_approval,processing'); body = `<p class="muted">${App.mode === 'live' ? 'Live payouts: approve, send the bank transfer from treasury, then record its reference.' : 'Test payouts complete automatically on approval.'}</p>` + table([{ h: 'Requested', v: p => fmtDT(p.created) }, { h: 'Merchant', v: p => esc(p.merchant_name) }, { h: 'Debit', r: 1, v: p => fmt(p.amount, p.currency) }, { h: 'Receives', r: 1, v: p => fmt(p.amount_received, p.destination_currency) }, { h: 'To', v: p => esc(p.destination) }, { h: 'Why review', v: p => esc((p.reasons || []).join('; ') || '—') }, { h: 'Status', v: p => badge(p.status) },
      { h: '', v: p => `<div class="row" style="flex-wrap:nowrap">${p.status === 'pending_approval' ? `<button class="btn sm danger" data-act="poReject" data-id="${p.id}">Reject</button><button class="btn sm primary" data-act="poApprove" data-id="${p.id}">Approve</button>` : `<button class="btn sm danger" data-act="poReject" data-id="${p.id}">Reject</button><button class="btn sm primary" data-act="poComplete" data-id="${p.id}">Record sent</button>`}</div>` }], ps, { empty: 'No payouts waiting.' }); }
  if (t === 'dest') { const ds = await api('GET', '/a-api/destinations'); body = table([{ h: 'Merchant', v: x => esc(x.merchant_name) }, { h: 'Bank', v: x => `${esc(x.bank_name)} ••${esc(x.last4)}` }, { h: 'Currency', v: x => x.currency }, { h: 'Holder', v: x => esc(x.holder) }, { h: '', v: x => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm danger" data-act="destDecide" data-id="${x.id}" data-ok="">Reject</button><button class="btn sm primary" data-act="destDecide" data-id="${x.id}" data-ok="1">Approve</button></div>` }], ds, { empty: 'No bank accounts waiting.' }); }
  if (t === 'adjust') { const as = (await api('GET', '/a-api/adjustments')).filter(a => a.status === 'pending_approval'); body = table([{ h: 'Drafted', v: a => fmtDT(a.created_at) }, { h: 'Merchant', v: a => `<span class="mono">${esc(short(a.merchant_id))}</span>` }, { h: 'Mode', v: a => badge(a.mode) }, { h: 'Amount', r: 1, v: a => fmt(a.amount, a.currency) }, { h: 'Reason', v: a => esc(a.reason) }, { h: 'Maker', v: a => esc(a.maker) }, { h: '', v: a => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm danger" data-act="adjDecide" data-id="${a.id}" data-d="reject">Reject</button><button class="btn sm primary" data-act="adjDecide" data-id="${a.id}" data-d="approve" ${a.maker === App.me.user.email ? 'disabled title="You drafted this"' : ''}>Approve & post</button></div>` }], as, { empty: 'No adjustments waiting.' }); }
  return head('Super admin', 'Approvals', 'Human decisions for onboarding, Cash App registration and money movement. Every decision is audited.') + mfaWarn()
    + tabs('ap', [['kyb', 'KYB'], ['cashapp', 'Cash App registration'], ['payouts', `Payouts (${App.mode})`], ['dest', 'Bank accounts'], ['adjust', 'Adjustments']], 'kyb') + body;
};
ACT.poApprove = d => confirmBox('Approve payout?', 'Confirm the bank account was reviewed.', 'Approve', () => api('POST', `/a-api/payouts/${d.id}/approve`), false);
ACT.poReject = d => formModal('Reject payout', 'poReject', field('Note for the merchant', '<textarea name="note" required></textarea>'), 'Reject payout', { data: { id: d.id } });
FORM.poReject = async (f, form) => { await api('POST', `/a-api/payouts/${form.dataset.id}/reject`, f); closeModal(); toast('Payout rejected; funds returned to available'); render(); };
ACT.poComplete = d => formModal('Record executed payout', 'poComplete', field('Bank transfer reference', input('reference', { req: true })), 'Mark completed', { data: { id: d.id } });
FORM.poComplete = async (f, form) => { await api('POST', `/a-api/payouts/${form.dataset.id}/complete`, f); closeModal(); toast('Payout completed'); render(); };
ACT.destDecide = d => run(() => api('POST', `/a-api/destinations/${d.id}/decision`, { approve: !!d.ok }), { ok: d.ok ? 'Bank account approved' : 'Bank account rejected' });
ACT.adjDecide = d => run(() => api('POST', `/a-api/adjustments/${d.id}/${d.d}`), { ok: d.d === 'approve' ? 'Adjustment posted to ledger' : 'Adjustment rejected' });

/* ---------------- transactions ---------------- */
VIEWS['a-payments'] = async () => {
  const f = App.filters.ap ||= { q: '', status: '', merchant: '' };
  const [d, ms] = await Promise.all([api('GET', '/a-api/payments' + qs(f)), api('GET', '/a-api/merchants')]);
  return head('Super admin', 'Transactions', `Every merchant's Cash App Pay payments · ${modeLabel()}`)
    + `<div class="card"><div class="grid g3">${fInput('ap', 'q', 'Search', 'ID, email, Cash App payment or request ID')}${fSelect('ap', 'merchant', 'Merchant', [['', 'All merchants'], ...ms.map(m => [m.id, m.name])])}${fSelect('ap', 'status', 'Status', [['', 'All'], ...['awaiting_customer', 'processing', 'authorized', 'captured', 'settled', 'declined', 'expired', 'canceled', 'refunded', 'partially_refunded', 'disputed'].map(s => [s, s.replace(/_/g, ' ')])])}</div></div>`
    + table([{ h: 'Date', v: p => fmtDT(p.created) }, { h: 'Merchant', v: p => esc(p.merchant_name) }, ...payCols.slice(1)], d.data, { rowAttr: p => `class="click" data-act="openAdminPayment" data-id="${p.id}"`, empty: 'No payments match.' })
    + `<span class="faint">${d.total} payments (showing up to 200)</span>`;
};
ACT.openAdminPayment = d => openDrawer(async () => {
  const x = await api('GET', '/a-api/payments/' + d.id), p = x.payment; let foot = '';
  if (['awaiting_customer', 'processing', 'authorized'].includes(p.status) && can('payments.manage')) foot += `<button class="btn" data-act="aSync" data-id="${p.id}">Sync with Cash App</button>`;
  if (['captured', 'settled', 'partially_refunded'].includes(p.status) && can('payments.manage')) foot += `<button class="btn" data-act="aRefund" data-id="${p.id}" data-max="${p.amount - p.amount_refunded}">Refund</button>`;
  return { title: 'Payment', body: paymentBody(x, true), foot };
});
ACT.aSync = d => run(() => api('POST', `/a-api/payments/${d.id}/sync`), { ok: 'Synced with Cash App' });
ACT.aRefund = d => formModal('Refund through Cash App', 'aRefund', field('Amount (USD)', input('amount', { type: 'number', value: (d.max / 100).toFixed(2), req: true, extra: 'step="0.01" min="0.01"' })) + field('Reason', input('reason', { value: 'admin refund' })), 'Refund', { data: { id: d.id } });
FORM.aRefund = async (f, form) => { await api('POST', `/a-api/payments/${form.dataset.id}/refund`, { amount: toMinor(f.amount), reason: f.reason }); closeModal(); toast('Refund submitted to Cash App'); render(); refreshDrawer(); };

/* ---------------- refunds & disputes ---------------- */
VIEWS['a-disputes'] = async () => {
  const ds = await api('GET', '/a-api/disputes');
  return head('Super admin', 'Refunds & disputes', `Cash App disputes for every merchant · ${modeLabel()}. Disputes arrive from Cash App webhooks; disputed amounts are held from the merchant's available balance.`)
    + table([{ h: 'Opened', v: d => fmtDT(d.created) }, { h: 'Merchant', v: d => esc(d.merchant_name) }, { h: 'Payment', v: d => `<span class="mono">${esc(short(d.payment))}</span>` }, { h: 'Reason', v: d => esc(d.reason) }, { h: 'Amount', r: 1, v: d => fmt(d.amount, d.currency) }, { h: 'Respond by', v: d => fmtDate(d.response_due_at) }, { h: 'State', v: d => badge(d.status, d.state) },
      { h: '', v: d => d.status === 'needs_response' && can('payments.manage') ? `<button class="btn sm" data-act="adminDispute" data-id="${d.id}">Respond</button>` : '' }], ds, { empty: 'No disputes.', rowAttr: d => `` });
};
ACT.adminDispute = d => openModal({ title: 'Respond to dispute', body: `<form class="stack" data-form="aEvidence" id="mf" data-id="${d.id}">${field('Evidence type', select('category', EVIDENCE.map(e => [e, e.replace(/_/g, ' ').toLowerCase()])))}${field('Evidence', '<textarea name="text" required minlength="10" maxlength="500"></textarea>')}<div class="err" id="formErr"></div></form>`,
  foot: `<button class="btn danger" data-act="aDisputeDo" data-id="${d.id}" data-a="accept">Accept</button><button class="btn" type="submit" form="mf">Add evidence</button><button class="btn primary" data-act="aDisputeDo" data-id="${d.id}" data-a="challenge">Challenge</button>` });
FORM.aEvidence = async (f, form) => { await api('POST', `/a-api/disputes/${form.dataset.id}/evidence`, f); form.reset(); toast('Evidence sent to Cash App'); };
ACT.aDisputeDo = d => confirmBox(d.a === 'accept' ? 'Accept dispute?' : 'Challenge dispute?', d.a === 'accept' ? 'The customer keeps the money.' : 'Cash App reviews the evidence.', 'Confirm', () => api('POST', `/a-api/disputes/${d.id}/${d.a}`), d.a === 'accept');

/* ---------------- settlements ---------------- */
VIEWS['a-settlements'] = async () => {
  const [d, ms] = await Promise.all([api('GET', '/a-api/settlements'), api('GET', '/a-api/merchants')]);
  const total = d.unsettled.reduce((s, p) => s + p.net, 0);
  return head('Super admin', 'Settlements', `When Cash App settles funds to Digital Hub, record the settlement here so merchants' captured payments move from pending to available · ${modeLabel()}.`)
    + `<div class="grid g2"><form class="card stack" data-form="settlement"><h2>Record a Cash App settlement</h2>${field('Merchant', select('merchant', [['', 'All merchants'], ...ms.map(m => [m.id, m.name])]))}${field('Captured on or before', input('before', { type: 'date' }), 'Empty = everything captured so far.')}
      ${field('Cash App settlement reference', input('reference', { req: true }))}<div class="err" id="formErr"></div><button class="btn primary" type="submit" ${can('payouts.execute') ? '' : 'disabled'}>Record settlement</button>${App.mode === 'test' ? '<p class="faint">Test mode also settles automatically after two sandbox days.</p>' : ''}</form>
      <div class="card kpi"><div class="label">Awaiting settlement</div><div class="value">${usd(total)}</div><div class="sub">${d.unsettled.length} captured payments, net of fees</div></div></div>
    <div class="card"><h2>Awaiting settlement</h2><div style="margin-top:10px">${table([{ h: 'Captured', v: p => fmtDT(p.captured_at) }, { h: 'Merchant', v: p => esc(p.merchant_name) }, { h: 'Payment', v: p => `<span class="mono">${esc(short(p.id))}</span>` }, { h: 'Amount', r: 1, v: p => usd(p.amount) }, { h: 'Net', r: 1, v: p => usd(p.net) }], d.unsettled, { empty: 'Nothing awaiting settlement.' })}</div></div>
    <div class="card"><h2>Recently settled</h2><div style="margin-top:10px">${table([{ h: 'Settled', v: p => fmtDT(p.settled_at) }, { h: 'Merchant', v: p => esc(p.merchant_name) }, { h: 'Payment', v: p => `<span class="mono">${esc(short(p.id))}</span>` }, { h: 'Net', r: 1, v: p => usd(p.net) }, { h: 'Reserve', r: 1, v: p => usd(p.reserve || 0) }, { h: 'Reference', v: p => esc(p.reference || 'sandbox') }], d.settled, { empty: 'None yet.' })}</div></div>`;
};
FORM.settlement = async (f, form) => { const r = await api('POST', '/a-api/settlements', { merchant: f.merchant, before: f.before ? f.before + 'T23:59:59' : '', reference: f.reference }); form.reset(); toast(`${r.settled} payments settled (${usd(r.net_total)} net)`); render(); };

/* ---------------- ledger ---------------- */
VIEWS['a-ledger'] = async () => {
  const d = await api('GET', '/a-api/ledger');
  return head('Super admin', 'Ledger & reconciliation', `Append-only double-entry journal (${d.journals} journals) · ${modeLabel()}. Database triggers block edits and deletes.`)
    + `<div class="card"><div class="card-head"><h2>Reconciliation checks</h2>${badge(d.checks.every(c => c.ok) ? 'pass' : 'fail', d.checks.every(c => c.ok) ? 'all passing' : 'issues')}</div><div class="stack">${d.checks.map(c => `<div class="row" style="justify-content:space-between;flex-wrap:nowrap;align-items:flex-start"><div><b>${esc(c.name)}</b><div class="muted" style="font-size:.84rem">${esc(c.detail)}</div></div>${c.warn ? badge('pending', 'attention') : badge(c.ok ? 'pass' : 'fail')}</div>`).join('<div class="divider"></div>')}</div></div>
    <div class="grid g2"><div class="card"><h2>Trial balance</h2><div style="margin-top:10px">${table([{ h: 'Currency', v: r => r.currency }, { h: 'Debits', r: 1, v: r => fmt(r.debits, r.currency) }, { h: 'Credits', r: 1, v: r => fmt(r.credits, r.currency) }, { h: '', v: r => badge(r.debits === r.credits ? 'pass' : 'fail', r.debits === r.credits ? 'balanced' : 'off') }], d.trial_balance)}</div></div>
    <div class="card"><h2>Account positions</h2><p class="faint">acquirer_receivable = owed by Cash App · partner_cash = settled at Digital Hub</p><div style="margin-top:10px">${table([{ h: 'Account', v: r => `<span class="mono">${esc(r.account)}</span>` }, { h: 'Currency', v: r => r.currency }, { h: 'Balance', r: 1, v: r => fmt(r.total, r.currency) }], d.accounts)}</div></div></div>
    <div class="card"><h2>Latest entries</h2><div style="margin-top:10px">${table([{ h: 'Time', v: e => fmtDT(e.at) }, { h: 'Journal', v: e => `<span class="mono">${esc(short(e.journal_key, 16, 12))}</span>` }, { h: 'Account', v: e => esc(e.account) }, { h: 'Merchant', v: e => e.merchant_id ? `<span class="mono">${esc(short(e.merchant_id))}</span>` : '—' }, { h: 'Amount', r: 1, v: e => fmt(e.amount, e.currency) }, { h: 'Memo', v: e => esc(e.memo) }], d.entries)}</div></div>`;
};

/* ---------------- Cash App Pay integration ---------------- */
VIEWS['a-cashapp'] = async () => {
  const d = await api('GET', '/a-api/cashapp'), ok = can('platform.settings');
  const env = e => `<div class="card stack"><div class="card-head" style="margin:0"><h2>${e.mode === 'test' ? 'Sandbox' : 'Production'}</h2>${e.simulated ? badge('pending', 'local simulator') : e.configured ? badge('active', 'credentials set') : badge('fail', 'not configured')}</div>
    ${kv([['Environment', esc(e.label)], ['API base', `<span class="mono">${esc(e.base)}</span>`], ['Client ID', e.client_id ? `<span class="mono">${esc(e.client_id)}</span>` : '—'], ['API key ID', e.api_key_id ? `<span class="mono">${esc(e.api_key_id)}</span>` : '—'],
      ['Request signing secret', e.signing_secret ? badge('active', 'set') : (e.mode === 'test' ? badge('pending', 'not set (sandbox skip-signature)') : badge('fail', 'missing'))], ['Webhook signing secret', e.webhook_secret ? badge('active', 'set') : badge('pending', 'missing')],
      ['Webhook URL', `<span class="mono">${esc(e.webhook_url)}</span> <button class="btn sm ghost" data-act="copy" data-text="${esc(e.webhook_url)}">Copy</button>`], ['Active merchants', e.merchants_active],
      ['Server variables', e.env_names.map(n => `<span class="tag">${n}</span>`).join(' ')]])}
    <div class="row"><button class="btn" data-act="caTest" data-mode="${e.mode}" ${ok ? '' : 'disabled'}>Test connection</button><button class="btn" data-act="caWebhook" data-mode="${e.mode}" ${ok && e.configured ? '' : 'disabled'}>Register webhook with Cash App</button></div></div>`;
  return head('Cash App Pay', 'Integration', 'Digital Hub connects to the Cash App Pay Partner API (Network, Customer Request and Management APIs). Credentials are set only as server environment variables — never in the browser or database.')
    + (d.live_payments ? '' : note('info', 'Live payments off', 'Set LIVE_PAYMENTS=1 only after Cash App approves Digital Hub as a partner and production credentials are configured.'))
    + `<div class="grid g2">${d.environments.map(env).join('')}</div>`
    + note('warn', 'Partner approval', 'Real Cash App payments require Digital Hub to be an approved Cash App Pay partner, with production credentials and a settlement arrangement from Cash App. Until then, use the sandbox.')
    + `<div class="card"><h2>Cash App API log · ${App.mode}</h2><div style="margin-top:10px">${table([{ h: 'Time', v: l => fmtDT(l.created_at) }, { h: 'Merchant', v: l => l.merchant_id ? `<span class="mono">${esc(short(l.merchant_id))}</span>` : 'platform' }, { h: 'Operation', v: l => esc((l.op || '').replace(/_/g, ' ')) }, { h: 'Call', v: l => `<span class="mono">${esc(l.method)} ${esc(l.path)}</span>` }, { h: 'HTTP', r: 1, v: l => l.http ?? '—' }, { h: 'ms', r: 1, v: l => l.ms }, { h: 'Result', v: l => badge(l.status) + (l.error ? ` <span class="faint">${esc(l.error)}</span>` : '') }], d.logs, { empty: 'No Cash App API calls yet.' })}</div></div>
    <div class="card"><h2>Cash App events received</h2><div style="margin-top:10px">${table([{ h: 'Time', v: e => fmtDT(e.created_at) }, { h: 'Mode', v: e => badge(e.mode || 'test') }, { h: 'Event', v: e => `<span class="mono">${esc(e.type)}</span>` }, { h: 'Signature', v: e => badge(e.sig === 'verified' || e.sig === 'simulator' ? 'pass' : 'fail', e.sig) }, { h: 'Result', v: e => badge(e.status) }], d.events, { empty: 'No Cash App events yet.' })}</div></div>`;
};
ACT.caTest = d => run(async () => { const r = await api('POST', '/a-api/cashapp/test-connection', { mode: d.mode }); toast(`Connected to ${r.environment} in ${r.ms} ms`); });
ACT.caWebhook = d => confirmBox('Register webhook with Cash App?', 'Cash App will send payment, refund, dispute and customer-request events to this platform. Copy the API secret Cash App returns into the webhook secret variable, then redeploy.', 'Register', async () => { const r = await api('POST', '/a-api/cashapp/webhook-endpoint', { mode: d.mode }); setTimeout(() => openModal({ title: 'Webhook endpoint registered', wide: true, body: `<p>${esc(r.note)}</p><pre class="code">${esc(JSON.stringify(r.endpoint, null, 2))}</pre>` }), 60); }, false);

/* ---------------- webhooks, risk, audit, staff, platform ---------------- */
VIEWS['a-webhooks'] = async () => {
  const f = App.filters.wh ||= { status: '' }; const ds = await api('GET', '/a-api/deliveries' + qs(f));
  return head('Cash App Pay', 'Webhook deliveries', `Outbound events to merchant servers and WooCommerce stores · ${modeLabel()}`)
    + `<div class="card"><div class="grid g3">${fSelect('wh', 'status', 'Status', [['', 'All'], ['delivered', 'Delivered'], ['retrying', 'Retrying'], ['failed', 'Failed'], ['pending', 'Pending']])}</div></div>`
    + table([{ h: 'Time', v: d => fmtDT(d.last_attempt || d.created_at) }, { h: 'Merchant', v: d => `<span class="mono">${esc(short(d.merchant_id))}</span>` }, { h: 'Event', v: d => `<span class="mono">${esc(d.type)}</span>` }, { h: 'URL', v: d => `<span class="mono">${esc(short(d.url, 26, 10))}</span>` }, { h: 'HTTP', r: 1, v: d => d.code ?? '—' }, { h: 'Attempts', r: 1, v: d => d.attempts }, { h: 'Status', v: d => badge(d.status) + (d.error ? `<div class="faint" style="font-size:.72rem">${esc(d.error)}</div>` : '') }, { h: '', v: d => d.status !== 'delivered' && can('payments.manage') ? `<button class="btn sm" data-act="aRetry" data-id="${d.id}">Retry</button>` : '' }], ds, { empty: 'No deliveries.' });
};
ACT.aRetry = d => run(() => api('POST', `/a-api/deliveries/${d.id}/retry`), { ok: 'Retry queued' });
VIEWS['a-alerts'] = async () => {
  const f = App.filters.al ||= { status: 'open' }; const al = await api('GET', '/a-api/alerts' + qs(f));
  return head('Super admin', 'Risk alerts', 'Repeated declines, high value, limit blocks, disputes and AML hits.')
    + `<div class="card"><div class="grid g3">${fSelect('al', 'status', 'Status', [['', 'All'], ['open', 'Open'], ['acknowledged', 'Acknowledged'], ['resolved', 'Resolved']])}</div></div>`
    + table([{ h: 'Raised', v: a => fmtDT(a.created_at) }, { h: 'Severity', v: a => badge(a.severity) }, { h: 'Rule', v: a => esc(a.kind.replace(/_/g, ' ')) }, { h: 'Mode', v: a => badge(a.mode) }, { h: 'Merchant', v: a => `<span class="mono">${esc(short(a.merchant_id || ''))}</span>` }, { h: 'Detail', v: a => esc(a.detail) }, { h: 'Status', v: a => badge(a.status) },
      { h: '', v: a => a.status !== 'resolved' && can('alerts.manage') ? `<div class="row" style="flex-wrap:nowrap">${a.ref?.startsWith('pay_') ? `<button class="btn sm" data-act="openAdminPayment" data-id="${a.ref}">Open</button>` : ''}${a.status === 'open' ? `<button class="btn sm" data-act="alertSet" data-id="${a.id}" data-s="acknowledged">Acknowledge</button>` : ''}<button class="btn sm primary" data-act="alertSet" data-id="${a.id}" data-s="resolved">Resolve</button></div>` : '' }], al, { empty: 'No alerts.' });
};
ACT.alertSet = d => run(() => api('POST', `/a-api/alerts/${d.id}`, { status: d.s }));
const auditTable = list => table([{ h: 'Time', v: a => fmtDT(a.created_at) }, { h: 'Actor', v: a => esc(a.actor) }, { h: 'Action', v: a => `<span class="mono">${esc(a.action)}</span>` }, { h: 'Target', v: a => `<span class="mono">${esc(short(a.target, 14, 6))}</span>` }, { h: 'Detail', v: a => esc(String(a.detail).slice(0, 120)) }], list, { empty: 'No events.' });
VIEWS['a-audit'] = async () => { const f = App.filters.au ||= { q: '' }; const list = await api('GET', '/a-api/audit' + qs(f)); return head('Super admin', 'Audit log', 'Every staff and merchant action, with actor and target.') + `<div class="card">${fInput('au', 'q', 'Search', 'actor, action, ID')}</div>` + auditTable(list); };
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
VIEWS['a-platform'] = async () => {
  const d = await api('GET', '/a-api/platform'), s = d.settings, ok = can('platform.settings') ? '' : 'disabled';
  return head('Super admin', 'Platform settings', 'Global rules and defaults for new merchants.')
    + `<form class="card stack" data-form="platform"><div class="card-head" style="margin:0"><h2>Rules & defaults</h2><button class="btn primary" type="submit" ${ok}>Save</button></div><div class="form-grid">
      ${field('Payout review threshold (USD)', input('threshold', { type: 'number', value: s.approvalThresholdUSD / 100 }))}${field('Repeated-decline alert: declines / customer / 24h', input('declineCount', { type: 'number', value: s.risk.declineCount }))}
      ${field('High-value alert above (USD)', input('highValue', { type: 'number', value: s.risk.highValueUSD / 100 }))}${field('Default platform fee %', input('platPct', { type: 'number', value: s.defaults.platPct, extra: 'step="0.01"' }))}
      ${field('Default fixed platform fee (USD)', input('platFixed', { type: 'number', value: s.defaults.platFixedUSD / 100, extra: 'step="0.01"' }))}${field('Default reserve %', input('reservePct', { type: 'number', value: s.defaults.reservePct, extra: 'step="0.5"' }))}
      ${field('Default reserve days', input('reserveDays', { type: 'number', value: s.defaults.reserveDays }))}</div><div class="err" id="formErr"></div></form>
    <div class="card">${kv([['Public URL', `<span class="mono">${esc(d.config.publicUrl)}</span>`], ['Live payments', d.config.livePayments ? badge('active', 'on') : badge('pending', 'off')], ['Staff 2FA enforced', d.config.requireStaffMfa ? 'yes' : 'no (development)'], ['Sandbox day length', `${d.config.sandboxDayMs / 1000}s (sandbox settlement, reserves)`]])}</div>`;
};
FORM.platform = async f => { await api('PATCH', '/a-api/platform', { approvalThresholdUSD: toMinor(f.threshold), risk: { declineCount: +f.declineCount, highValueUSD: toMinor(f.highValue) }, defaults: { platPct: +f.platPct, platFixedUSD: toMinor(f.platFixed), reservePct: +f.reservePct, reserveDays: +f.reserveDays } }); toast('Platform settings saved'); };

App.boot();
