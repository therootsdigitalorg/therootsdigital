'use strict';
/* Digital Hub Wallet portal — core: helpers, API client, sign-in, shell and router.
   Portal pages live in app-merchant.js. One store account, US dollars only. */

/* ---------------- helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmt(minor) { const n = Number(minor) || 0; return (n < 0 ? '−' : '') + '$' + (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const usd = fmt;
const fmtDT = t => t ? new Date(t > 1e12 ? t : t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDate = t => t ? new Date(t > 1e12 ? t : t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const short = (s, a = 8, b = 4) => s && s.length > a + b + 3 ? `${s.slice(0, a)}…${s.slice(-b)}` : (s || '');
const toMinor = v => { const n = Number(String(v).replace(/[, ]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const uid = () => (window.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const TONE = {
  ok: ['partially_won', 'settled', 'confirmed', 'completed', 'succeeded', 'approved', 'verified', 'delivered', 'won', 'active', 'paid', 'enabled', 'clear', 'resolved', 'pass', 'posted', 'processed', 'complete', 'done', 'yes'],
  accent: ['captured'],
  info: ['awaiting_customer', 'approved_by_customer', 'authorized', 'confirming', 'processing', 'awaiting_payment', 'requires_action', 'under_review', 'created', 'pending_review', 'acknowledged', 'requested', 'submitted', 'open', 'test'],
  warn: ['not_registered', 'expired', 'pending_approval', 'partially_refunded', 'underpaid', 'overpaid', 'needs_response', 'retrying', 'pending', 'medium', 'expiring', 'pending_execution', 'not_requested', 'unpaid'],
  danger: ['risk_disabled', 'compliance_disabled', 'client_disabled', 'declined', 'failed', 'wrong_network', 'disputed', 'rejected', 'chargeback_lost', 'lost', 'suspended', 'high', 'fail', 'revoked', 'disabled', 'hit', 'live', 'no'],
};
function badge(status, label) {
  const tone = Object.entries(TONE).find(([, v]) => v.includes(status))?.[0];
  return `<span class="badge ${tone ? { ok: 'b-ok', accent: 'b-accent', info: 'b-info', warn: 'b-warn', danger: 'b-danger' }[tone] : ''}">${esc(label || String(status ?? '—').replace(/_/g, ' '))}</span>`;
}
function kv(pairs) { return `<dl class="kv">${pairs.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v ?? '—'}</dd>`).join('')}</dl>`; }
function table(cols, rows, { empty = 'Nothing here yet.', rowAttr, cls = '' } = {}) {
  cols = cols.filter(Boolean);
  if (!rows?.length) return `<div class="table-wrap"><div class="empty">${empty}</div></div>`;
  return `<div class="table-wrap"><table class="${cls}"><thead><tr>${cols.map(c => `<th class="${c.r ? 'r' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr ${rowAttr ? rowAttr(r) : ''}>${cols.map(c => `<td class="${c.r ? 'r num' : ''}">${c.v(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function head(eyebrow, title, sub = '', actions = '') { return `<div class="page-head"><div class="stack" style="gap:4px"><span class="eyebrow">${esc(eyebrow)}</span><h1>${esc(title)}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`; }
function tabs(group, items, def) { const cur = App.tabs[group] || def; return `<div class="tabs" role="tablist">${items.map(([k, l]) => `<button role="tab" aria-selected="${cur === k}" data-act="tab" data-group="${group}" data-tab="${k}">${l}</button>`).join('')}</div>`; }
const tab = (group, def) => App.tabs[group] || def;
function note(kind, title, text) { return `<div class="note ${kind}">${title ? `<b>${esc(title)}</b>` : ''}<span>${text}</span></div>`; }
function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), kind === 'err' ? 7000 : 4000); }
function copyText(text) { (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast('Copied to clipboard'), () => { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Copied to clipboard'); } catch { toast('Select and copy manually', 'warn'); } ta.remove(); }); }
function qrInto(el, text) { if (!el) return; el.innerHTML = ''; if (window.QRCode) { try { new QRCode(el, { text, width: 156, height: 156, colorDark: '#0C172A', colorLight: '#FFFFFF', correctLevel: QRCode.CorrectLevel.M }); return; } catch {} } el.innerHTML = '<span style="color:#0C172A;font-size:12px">QR unavailable</span>'; }
function barChart(series) {
  const W = 720, H = 210, padL = 52, padB = 26, padT = 12, padR = 8, max = Math.max(1, ...series.map(s => s.amount));
  const raw = max / 100 / 4, p10 = Math.pow(10, Math.floor(Math.log10(raw || 1))), f = raw / p10, step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p10 || 1;
  const top = Math.ceil(max / 100 / step) * step, bw = (W - padL - padR) / series.length, y = v => H - padB - (v / 100) / top * (H - padB - padT);
  let g = '';
  for (let t = 0; t <= top; t += step) { const yy = y(t * 100); g += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="${padL - 6}" y="${yy + 3}" text-anchor="end">$${t >= 1000 ? (t / 1000) + 'k' : t}</text>`; }
  series.forEach((s, i) => { const x = padL + i * bw + bw * .18, w = bw * .64, ya = y(s.amount);
    g += `<rect x="${x}" y="${ya}" width="${w}" height="${H - padB - ya}" fill="var(--accent)" rx="2"><title>${s.label}: ${fmt(s.amount)}</title></rect>`;
    if (i % 2 === 0) g += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${s.label}</text>`; });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily Cash App Pay volume in dollars">${g}</svg></div><div class="legend"><span><i style="background:var(--accent)"></i>Cash App Pay</span></div>`;
}

/* ---------------- API client ---------------- */
async function api(method, path, body) {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Requested-With': 'DigitalHub', 'X-DH-Mode': App.mode }, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(data.error?.message || `Request failed (${r.status})`); e.code = data.error?.code; e.status = r.status;
    if (r.status === 401 && path !== '/auth/login' && path !== '/auth/mfa') { App.me = null; render(); }
    throw e;
  }
  return data;
}

/* ---------------- modal & drawer ---------------- */
function openModal({ title, body, foot = '', wide = false, onMount }) {
  const d = $('#dlg'); d.style.width = wide ? 'min(780px,calc(100vw - 32px))' : '';
  d.innerHTML = `<div class="dlg-head"><h2>${esc(title)}</h2><button class="x" data-act="closeModal" aria-label="Close">×</button></div><div class="dlg-body">${body}</div>${foot ? `<div class="dlg-foot">${foot}</div>` : ''}`;
  if (!d.open) d.showModal(); onMount && onMount(d);
}
function closeModal() { const d = $('#dlg'); if (d.open) d.close(); }
let drawerFn = null;
async function openDrawer(fn) {
  drawerFn = fn;
  $('#drawerHost').innerHTML = `<div class="scrim" data-act="closeDrawer"></div><aside class="drawer" role="dialog" aria-modal="true"><div class="dlg-head"><h2 id="drTitle">Loading…</h2><button class="x" data-act="closeDrawer" aria-label="Close">×</button></div><div class="dlg-body" id="drBody"><div class="loading">Loading…</div></div><div class="dlg-foot" id="drFoot" hidden></div></aside>`;
  requestAnimationFrame(() => $('#drawerHost .drawer')?.classList.add('open'));
  await refreshDrawer();
}
async function refreshDrawer() {
  if (!drawerFn || !$('#drawerHost .drawer')) return;
  try { const { title, body, foot = '' } = await drawerFn(); $('#drTitle').textContent = title; $('#drBody').innerHTML = body; $('#drFoot').innerHTML = foot; $('#drFoot').hidden = !foot; }
  catch (e) { $('#drBody').innerHTML = note('danger', 'Error', esc(e.message)); }
}
function closeDrawer() { drawerFn = null; $('#drawerHost').innerHTML = ''; }

/* ---------------- app state, actions, forms ---------------- */
const App = { me: null, mode: lsGet('dh.mode') === 'live' ? 'live' : 'test', tabs: {}, filters: {}, cache: {} };
const VIEWS = {}, MOUNT = {}, ACT = {}, FORM = {}, NAV = {};
const can = p => App.me?.perms?.includes(p);

/** Run an action with toast on error; refreshes page/drawer on success unless noRefresh. */
async function run(fn, { ok, noRefresh } = {}) {
  try { const r = await fn(); if (ok) toast(ok); if (!noRefresh) { await render(); await refreshDrawer(); } return r ?? true; }
  catch (e) { toast(e.message, 'err'); return false; }
}
function confirmBox(title, text, label, fn, danger = true) {
  App.pending = fn;
  openModal({ title, body: `<p>${text}</p>`, foot: `<button class="btn ghost" data-act="closeModal">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-act="confirmDo">${esc(label)}</button>` });
}
/** Modal with a form. fields are HTML; submit calls FORM[name]. */
function formModal(title, name, fields, submitLabel, { wide, data = {} } = {}) {
  openModal({ title, wide, body: `<form class="stack" data-form="${name}" id="mf" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')}>${fields}<div class="err" id="formErr"></div></form>`,
    foot: `<button class="btn ghost" data-act="closeModal">Cancel</button><button class="btn primary" type="submit" form="mf">${esc(submitLabel)}</button>` });
}
function secretModal(title, intro, secret, extra = '') {
  openModal({ title, body: `<p>${intro}</p><div class="secret">${esc(secret)}</div>${extra}<p class="faint">Copy it now — for security it is not shown again in full.</p>`, foot: `<button class="btn primary" data-act="copy" data-text="${esc(secret)}">Copy</button><button class="btn" data-act="closeModal">Done</button>` });
}
const field = (label, input, hint = '') => `<label class="field"><span>${esc(label)}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
const input = (name, { type = 'text', value = '', ph = '', req = false, extra = '' } = {}) => `<input type="${type}" name="${name}" value="${esc(value)}" placeholder="${esc(ph)}" ${req ? 'required' : ''} ${extra}>`;
const select = (name, opts, cur) => `<select name="${name}">${opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') { if (el.dataset.multi !== undefined) { (o[el.name] ||= []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; }
    else o[el.name] = el.value;
  }
  return o;
}

ACT.closeModal = closeModal; ACT.closeDrawer = closeDrawer;
ACT.confirmDo = async () => { const fn = App.pending; App.pending = null; closeModal(); if (fn) await run(fn); };
ACT.copy = d => copyText(d.text);
ACT.tab = d => { App.tabs[d.group] = d.tab; render(); refreshDrawer(); };
ACT.go = d => go(d.route);
ACT.logout = () => run(async () => { await api('POST', '/auth/logout'); App.me = null; location.hash = ''; }, { ok: 'Signed out' });
ACT.toggleMode = () => { App.mode = App.mode === 'test' ? 'live' : 'test'; lsSet('dh.mode', App.mode); closeDrawer(); render(); };
ACT.theme = () => { const root = document.documentElement, cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'), next = cur === 'dark' ? 'light' : 'dark'; root.setAttribute('data-theme', next); lsSet('dh.theme', next); };
ACT.menu = () => $('#rail')?.classList.toggle('open');
ACT.authView = d => { App.authView = d.view; render(); };

/* ---------------- auth screens ---------------- */
function authScreen() {
  const v = App.authView || 'login';
  const brand = `<div class="brand"><span class="brand-mark"></span><div>DIGITAL HUB<small>Wallet · Cash App Pay</small></div></div>`;
  const body = v === 'mfa'
    ? `<h1>Two-factor verification</h1><p class="muted">Enter the 6-digit code from your authenticator app.</p>
    <form class="stack" data-form="mfaLogin">${field('Code', input('code', { req: true, extra: 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"' }))}<div class="err" id="formErr"></div><button class="btn primary" type="submit">Verify</button></form>`
    : `<h1>Sign in</h1><p class="muted">Your Digital Hub Wallet and Cash App Pay portal.</p>
    <form class="stack" data-form="login">${field('Email', input('email', { type: 'email', req: true, extra: 'autocomplete="username"' }))}${field('Password', input('password', { type: 'password', req: true, extra: 'autocomplete="current-password"' }))}
    <div class="err" id="formErr"></div><button class="btn primary" type="submit">Sign in</button></form>
    <p class="auth-switch">Team members get their sign-in from the account owner.</p>`;
  return `<div class="auth-wrap"><div class="auth-card">${brand}${body}<span class="faint" style="font-size:.75rem;text-align:center">Protected by 2FA, session cookies and audit logging.</span></div></div>`;
}
FORM.login = async f => { const r = await api('POST', '/auth/login', f); if (r.mfa_required) { App.authView = 'mfa'; return render(); } await loadMe(); };
FORM.mfaLogin = async f => { await api('POST', '/auth/mfa', f); App.authView = 'login'; await loadMe(); };

/* 2FA enrollment + password */
ACT.setupMfa = () => run(async () => {
  const r = await api('POST', '/auth/mfa/setup');
  openModal({ title: 'Enable two-factor authentication', body: `<p class="muted">Scan with Google Authenticator, Microsoft Authenticator, 1Password or Authy, then enter the 6-digit code.</p>
    <div class="row" style="align-items:flex-start"><div class="qr" id="mfaQr"></div><div class="stack" style="flex:1;min-width:200px"><span class="faint">Or enter this key manually</span><div class="secret">${esc(r.secret.replace(/(.{4})/g, '$1 '))}</div></div></div>
    <form class="stack" data-form="mfaEnable" id="mf">${field('Code', input('code', { req: true, extra: 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"' }))}<div class="err" id="formErr"></div></form>`,
    foot: `<button class="btn primary" type="submit" form="mf">Verify and enable</button>`, onMount: () => qrInto($('#mfaQr'), r.otpauth) });
}, { noRefresh: true });
FORM.mfaEnable = async f => { await api('POST', '/auth/mfa/enable', f); closeModal(); toast('Two-factor authentication enabled'); await loadMe(); };
FORM.password = async (f, form) => { if (f.password !== f.confirm) throw new Error('New passwords do not match.'); await api('POST', '/auth/password', f); form.reset(); toast('Password changed. Other sessions were signed out.'); };
VIEWS.account = async () => {
  const u = App.me.user;
  return head('Account', 'Your security', esc(u.email))
    + `<div class="grid g2"><div class="card stack"><div class="card-head" style="margin:0"><h2>Two-factor authentication</h2>${badge(u.mfa_enabled ? 'enabled' : 'pending', u.mfa_enabled ? 'on' : 'off')}</div>
      <p class="muted">Required for live API keys and production Cash App changes.</p>${u.mfa_enabled ? '<p class="faint">To reset 2FA, ask the account owner.</p>' : '<button class="btn primary" data-act="setupMfa">Set up 2FA</button>'}</div>
     <form class="card stack" data-form="password"><h2>Change password</h2>${field('Current password', input('current', { type: 'password', req: true, extra: 'autocomplete="current-password"' }))}
      ${field('New password', input('password', { type: 'password', req: true, extra: 'autocomplete="new-password" minlength="10"' }))}${field('Confirm new password', input('confirm', { type: 'password', req: true, extra: 'autocomplete="new-password"' }))}
      <div class="err" id="formErr"></div><button class="btn primary" type="submit">Change password</button></form></div>`;
};

/* ---------------- shell & router ---------------- */
function route() { const h = (location.hash || '').replace(/^#\/?/, ''); const [r, ...args] = h.split('/'); return { r: r || 'home', args }; }
function go(r) { closeDrawer(); location.hash = '#/' + r; }
function shell() {
  const u = App.me.user, ws = esc(App.me.merchant?.name || 'Store');
  return `${App.mode === 'test' ? '<div class="test-banner">Test mode · Cash App sandbox · no real money moves</div>' : ''}
  <header class="topbar"><button class="btn sm menu-btn" data-act="menu" aria-label="Open navigation">☰</button>
    <div class="brand"><span class="brand-mark"></span><div>DIGITAL HUB<small>Wallet · Cash App Pay</small></div></div>
    <span class="ws-label">${ws}</span><span class="spacer"></span>
    <button class="mode-switch" role="switch" aria-checked="${App.mode === 'test'}" data-act="toggleMode" title="Switch between test and live data"><span class="knob"></span>Test mode</button>
    <a class="user-chip" href="#/account" title="Your security">${badge(u.mfa_enabled ? 'enabled' : 'pending', u.mfa_enabled ? '2FA' : 'no 2FA')}<span>${esc(u.email)}</span></a>
    <button class="btn sm ghost" data-act="theme" aria-label="Toggle theme">Theme</button><button class="btn sm" data-act="logout">Sign out</button></header>
  <div class="shell"><nav class="rail" id="rail" aria-label="Modules"></nav><main id="main"></main></div>`;
}
function rail(cur) {
  const groups = NAV.merchant, counts = App.counts || {};
  return groups.map(([g, items]) => `<div class="navgroup">${esc(g)}</div><div class="nav">${items.map(([r, l]) => `<a href="#/${r}" ${cur === r ? 'aria-current="page"' : ''}>${esc(l)}${counts[r] ? `<span class="count">${counts[r]}</span>` : ''}</a>`).join('')}</div>`).join('')
    + `<div class="navgroup">Account</div><div class="nav"><a href="#/account" ${cur === 'account' ? 'aria-current="page"' : ''}>Your security</a></div>`;
}
let renderSeq = 0;
async function render() {
  const root = $('#root');
  if (!App.me) { root.innerHTML = authScreen(); return; }
  if (!$('#main') || root.dataset.mode !== App.mode || root.dataset.user !== App.me.user.id) { root.innerHTML = shell(); root.dataset.mode = App.mode; root.dataset.user = App.me.user.id; }
  const { r, args } = route(), seq = ++renderSeq;
  const valid = NAV.merchant.some(([, items]) => items.some(([k]) => k === r)) || r === 'account';
  const name = valid ? r : 'home';
  $('#rail').innerHTML = rail(name); $('#rail').classList.remove('open');
  const main = $('#main'); if (!main.firstChild) main.innerHTML = '<div class="loading">Loading…</div>';
  try { const html = await VIEWS[name](...args); if (seq !== renderSeq) return; main.innerHTML = `<div class="page">${html}</div>`; MOUNT[name]?.(); }
  catch (e) { if (seq !== renderSeq) return; main.innerHTML = `<div class="page">${note('danger', 'Could not load this page', esc(e.message))}</div>`; }
}
async function loadMe() { const r = await api('GET', '/auth/me'); App.me = r.user ? r : null; if (r.mfa_pending) App.authView = 'mfa'; await render(); }

/* ---------------- global wiring ---------------- */
document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]'); if (!a || a.matches('input, select, textarea')) return;
  const fn = ACT[a.dataset.act]; if (!fn) return; e.preventDefault(); fn(a.dataset, a);
});
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault();
  const fn = FORM[f.dataset.form]; if (!fn) return;
  const err = $('#formErr', f), btns = $$('button[type=submit]', f).concat($$(`button[form="${f.id}"]`)); if (err) err.textContent = '';
  btns.forEach(b => b.disabled = true);
  try { await fn(formData(f), f); } catch (ex) { if (err) err.textContent = ex.message; else toast(ex.message, 'err'); }
  finally { btns.forEach(b => b.disabled = false); }
});
document.addEventListener('change', e => { const t = e.target; if (t.dataset.filter) { const [bag, key] = t.dataset.filter.split('.'); (App.filters[bag] ||= {})[key] = t.value; App.filters[bag].offset = 0; render(); } if (t.dataset.change && ACT[t.dataset.change]) ACT[t.dataset.change](t.dataset, t); });
let filterTimer;
document.addEventListener('input', e => { const t = e.target; if (t.dataset.filter && t.tagName === 'INPUT') { clearTimeout(filterTimer); filterTimer = setTimeout(async () => { const [bag, key] = t.dataset.filter.split('.'); (App.filters[bag] ||= {})[key] = t.value; App.filters[bag].offset = 0; const id = t.id; await render(); const el = document.getElementById(id); if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); } }, 300); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#drawerHost .drawer')) closeDrawer(); if (e.key === 'Enter' && e.target.matches('tr.click')) e.target.click(); });
window.addEventListener('hashchange', () => { closeDrawer(); render(); });
const fInput = (bag, key, label, ph) => field(label, `<input type="text" id="f-${bag}-${key}" data-filter="${bag}.${key}" value="${esc(App.filters[bag]?.[key] || '')}" placeholder="${esc(ph || '')}">`);
const fSelect = (bag, key, label, opts) => field(label, `<select data-filter="${bag}.${key}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(App.filters[bag]?.[key] || '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`);
const qs = o => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

App.boot = () => { const t = lsGet('dh.theme'); if (t) document.documentElement.setAttribute('data-theme', t); loadMe().catch(e => { $('#root').innerHTML = `<div class="auth-wrap">${note('danger', 'Cannot reach the server', esc(e.message))}</div>`; }); };
