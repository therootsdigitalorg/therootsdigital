'use strict';
/* Authorize.Net API client (official JSON API — https://developer.authorize.net/api/reference/).

   - Card data never touches Digital Hub: customers pay on Authorize.Net's Accept Hosted page (token from
     getHostedPaymentPageRequest, form POST to the hosted URL).
   - Payment results are trusted only from server-side API lookups (getTransactionDetailsRequest) or webhooks whose
     X-ANET-Signature (HMAC-SHA512 of the raw body with the Signature Key) verifies — never from a browser redirect.
   - Authorize.Net's JSON API is converted to XML server-side, so ELEMENT ORDER MATTERS: every request below builds its
     objects in the schema order.
   - Credentials: environment variables (ANET_SANDBOX_* / ANET_PRODUCTION_*) or Super Admin settings, sealed with
     AES-256-GCM. They are never returned to a browser; the UI only sees masked values. */
const config = require('./config');
const store = require('./db');
const U = require('./util');
const { HttpError, bad } = U;

const ENVS = ['sandbox', 'production'];
const unseal = v => { try { return v ? U.unseal(v) : ''; } catch { return ''; } };
const env = k => String(process.env[k] || '').trim();
const settings = () => store.getMeta('anet', { flow: 'authCapture', sandbox: {}, production: {} });
const saveSettings = s => store.setMeta('anet', s);

function creds(e) {
  const p = e === 'production' ? 'ANET_PRODUCTION_' : 'ANET_SANDBOX_', s = settings()[e] || {};
  if (env(p + 'LOGIN_ID')) return { loginId: env(p + 'LOGIN_ID'), transactionKey: env(p + 'TRANSACTION_KEY'), signatureKey: env(p + 'SIGNATURE_KEY'), clientKey: env(p + 'CLIENT_KEY') || s.clientKey || '', source: 'environment' };
  return { loginId: s.loginId || '', transactionKey: unseal(s.transactionKey), signatureKey: unseal(s.signatureKey), clientKey: s.clientKey || '', source: s.loginId ? 'admin settings' : null };
}
const configured = e => { const c = creds(e); return !!(c.loginId && c.transactionKey); };
const envForMode = mode => mode === 'live' ? 'production' : 'sandbox';
const flow = () => settings().flow === 'authOnly' ? 'authOnly' : 'authCapture';
const mask = v => v ? `${'•'.repeat(Math.max(0, Math.min(8, v.length - 4)))}${v.slice(-4)}` : '';
function publicConfig() {
  const s = settings(), out = { flow: flow(), environments: {} };
  for (const e of ENVS) { const c = creds(e); out.environments[e] = { configured: configured(e), source: c.source, login_id: c.loginId ? mask(c.loginId) : null, transaction_key: c.transactionKey ? mask(c.transactionKey) : null, signature_key: !!c.signatureKey, client_key: c.clientKey ? mask(c.clientKey) : null, last_test: s[e]?.lastTest || null, webhook: s[e]?.webhook || null, api: config.anet[e].api, hosted: config.anet[e].hosted }; }
  return out;
}
/** Save credentials for one environment (sealed). Values left empty keep the stored value. */
function save(e, input, actor) {
  if (!ENVS.includes(e)) throw bad('Environment must be sandbox or production.');
  if (env((e === 'production' ? 'ANET_PRODUCTION_' : 'ANET_SANDBOX_') + 'LOGIN_ID')) throw bad('This environment is configured by environment variables in Vercel.');
  const s = settings(), cur = s[e] || {};
  const loginId = String(input.login_id ?? '').trim(), key = String(input.transaction_key ?? '').trim(), sig = String(input.signature_key ?? '').trim(), ck = String(input.client_key ?? '').trim();
  if (ck && !/^[A-Za-z0-9]{40,100}$/.test(ck)) throw bad('Public Client Key: letters and digits (Authorize.Net → Account → Settings → Security Settings → Manage Public Client Key).');
  if (loginId && !/^[A-Za-z0-9]{6,25}$/.test(loginId)) throw bad('API Login ID: letters and digits only (Authorize.Net → Account → API Credentials & Keys).');
  if (key && !/^[A-Za-z0-9]{16}$/.test(key)) throw bad('Transaction Key is 16 letters/digits.');
  if (sig && !/^[0-9a-fA-F]{128}$/.test(sig)) throw bad('Signature Key is 128 hexadecimal characters.');
  s[e] = { ...cur, ...(loginId ? { loginId } : {}), ...(key ? { transactionKey: U.seal(key) } : {}), ...(sig ? { signatureKey: U.seal(sig) } : {}), ...(ck ? { clientKey: ck } : {}), lastTest: loginId || key ? null : cur.lastTest || null };
  if (input.flow) s.flow = input.flow === 'authOnly' ? 'authOnly' : 'authCapture';
  saveSettings(s);
  require('./core').audit(actor, 'authorize_net.credentials_saved', e, [loginId && 'login id', key && 'transaction key', sig && 'signature key', ck && 'public client key'].filter(Boolean).join(', ') || 'settings');
}
function clear(e, actor) { const s = settings(); s[e] = {}; saveSettings(s); require('./core').audit(actor, 'authorize_net.credentials_removed', e, ''); }

/* ---------------- transport ---------------- */
async function call(e, root, body) {
  const c = creds(e);
  if (!c.loginId || !c.transactionKey) throw new HttpError(503, 'authorize_net_not_configured', `Authorize.Net ${e} credentials are not configured (Super Admin → Authorize.Net).`);
  const payload = { [root]: { merchantAuthentication: { name: c.loginId, transactionKey: c.transactionKey }, ...body } };
  let res, text;
  try {
    res = await fetch(config.anet[e].api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    text = (await res.text()).replace(/^﻿/, ''); // Authorize.Net prefixes JSON with a UTF-8 BOM
  } catch (err) { throw new HttpError(503, 'authorize_net_unreachable', `Could not reach Authorize.Net (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`); }
  let data; try { data = JSON.parse(text); } catch { throw new HttpError(502, 'authorize_net_bad_response', `Authorize.Net returned HTTP ${res.status} without JSON.`); }
  const m = data.messages || {}, first = (m.message || [])[0] || {};
  return { ok: m.resultCode === 'Ok', data, code: first.code || null, text: first.text || null };
}
const fail = (r, what) => { const te = r.data?.transactionResponse?.errors?.[0]; throw new HttpError(r.code === 'E00007' ? 401 : 400, 'authorize_net_error', `${what}: ${te ? `${te.errorText} (${te.errorCode})` : `${r.text || 'request failed'}${r.code ? ` (${r.code})` : ''}`}`); };
const money = cents => (Number(cents) / 100).toFixed(2);
const cents = v => Math.round(Number(v || 0) * 100);

/* ---------------- operations ---------------- */
async function testConnection(e, actor) {
  const r = await call(e, 'authenticateTestRequest', {});
  const s = settings(); s[e] = { ...(s[e] || {}), lastTest: { ok: r.ok, at: Date.now(), code: r.code, text: r.text } }; saveSettings(s);
  require('./core').audit(actor || 'system', 'authorize_net.connection_test', e, r.ok ? 'ok' : `${r.code} ${r.text}`);
  return { ok: r.ok, code: r.code, message: r.ok ? 'Authorize.Net accepted the API Login ID and Transaction Key.' : r.text };
}
/** Accept Hosted token. Billing fields follow the processor's needs (AVS); the hosted page also asks for them. */
async function hostedToken(e, { amount, invoice, description, email, billTo = {}, returnUrl, cancelUrl, merchantName, refId }) {
  const s = v => String(v ?? '').trim();
  const tr = { transactionType: flow() === 'authOnly' ? 'authOnlyTransaction' : 'authCaptureTransaction', amount: money(amount),
    order: { invoiceNumber: s(invoice).slice(0, 20), description: s(description).slice(0, 255) } };
  if (email) tr.customer = { email: s(email).slice(0, 255) };
  const bt = {};
  for (const [k, max] of [['firstName', 50], ['lastName', 50], ['company', 50], ['address', 60], ['city', 40], ['state', 40], ['zip', 20], ['country', 60]]) if (s(billTo[k])) bt[k] = s(billTo[k]).slice(0, max);
  if (Object.keys(bt).length) tr.billTo = bt;
  const set = (name, v) => ({ settingName: name, settingValue: JSON.stringify(v) });
  const r = await call(e, 'getHostedPaymentPageRequest', { refId: s(refId).slice(0, 20), transactionRequest: tr, hostedPaymentSettings: { setting: [
    set('hostedPaymentReturnOptions', { showReceipt: false, url: returnUrl, urlText: 'Continue', cancelUrl, cancelUrlText: 'Cancel' }),
    set('hostedPaymentButtonOptions', { text: 'Pay' }),
    set('hostedPaymentOrderOptions', { show: true, merchantName: s(merchantName).slice(0, 255) }),
    set('hostedPaymentPaymentOptions', { cardCodeRequired: true, showCreditCard: true, showBankAccount: false }),
    set('hostedPaymentBillingAddressOptions', { show: true, required: false }),
    set('hostedPaymentCustomerOptions', { showEmail: true, requiredEmail: true, addPaymentProfile: false }),
  ] } });
  if (!r.ok || !r.data.token) fail(r, 'Could not open the secure payment page');
  return { token: r.data.token, url: config.anet[e].hosted };
}
async function details(e, transId) {
  const r = await call(e, 'getTransactionDetailsRequest', { transId: String(transId) });
  if (!r.ok) fail(r, 'Transaction lookup failed');
  return r.data.transaction;
}
/** Recent unsettled transactions (newest first) — used to find the transaction for an invoice after the customer returns. */
async function unsettled(e) {
  const r = await call(e, 'getUnsettledTransactionListRequest', { sorting: { orderBy: 'submitTimeUTC', orderDescending: true }, paging: { limit: 100, offset: 1 } });
  if (!r.ok && r.code !== 'I00004') fail(r, 'Unsettled transaction list failed'); // I00004 = no records
  return r.data.transactions || [];
}
async function settledBatches(e, from, to) {
  const r = await call(e, 'getSettledBatchListRequest', { includeStatistics: true, firstSettlementDate: new Date(from).toISOString().slice(0, 19) + 'Z', lastSettlementDate: new Date(to).toISOString().slice(0, 19) + 'Z' });
  if (!r.ok && r.code !== 'I00004') fail(r, 'Settled batch list failed');
  return r.data.batchList || [];
}
async function batchTransactions(e, batchId) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await call(e, 'getTransactionListRequest', { batchId: String(batchId), sorting: { orderBy: 'submitTimeUTC', orderDescending: false }, paging: { limit: 1000, offset: page } });
    if (!r.ok && r.code !== 'I00004') fail(r, 'Batch transaction list failed');
    const t = r.data.transactions || []; out.push(...t); if (t.length < 1000) break;
  }
  return out;
}
async function transaction(e, tr, what) {
  const r = await call(e, 'createTransactionRequest', { refId: U.rid(12), transactionRequest: tr });
  const t = r.data.transactionResponse || {};
  if (!r.ok || String(t.responseCode) !== '1') fail(r, what);
  return { transId: t.transId, authCode: t.authCode || null, responseCode: t.responseCode, message: t.messages?.[0]?.description || r.text };
}
/** Accept.js: the browser tokenises the card directly with Authorize.Net (opaqueData); Digital Hub only receives the
    one-time token and charges it here. Declines are returned (not thrown) so the caller can record them. */
async function chargeOpaque(e, { amount, invoice, description, email, billTo = {}, opaque, customerIP, refId }) {
  const s = v => String(v ?? '').trim();
  const tr = { transactionType: flow() === 'authOnly' ? 'authOnlyTransaction' : 'authCaptureTransaction', amount: money(amount),
    payment: { opaqueData: { dataDescriptor: s(opaque.descriptor), dataValue: s(opaque.value) } },
    order: { invoiceNumber: s(invoice).slice(0, 20), description: s(description).slice(0, 255) } };
  if (email) tr.customer = { email: s(email).slice(0, 255) };
  const bt = {};
  for (const [k, max] of [['firstName', 50], ['lastName', 50], ['company', 50], ['address', 60], ['city', 40], ['state', 40], ['zip', 20], ['country', 60]]) if (s(billTo[k])) bt[k] = s(billTo[k]).slice(0, max);
  if (Object.keys(bt).length) tr.billTo = bt;
  if (customerIP && /^[0-9a-fA-F:.]{3,45}$/.test(customerIP)) tr.customerIP = customerIP;
  const r = await call(e, 'createTransactionRequest', { refId: s(refId).slice(0, 20), transactionRequest: tr });
  const t = r.data.transactionResponse || {};
  return { ok: r.ok && String(t.responseCode) === '1', responseCode: String(t.responseCode || ''), transId: t.transId && t.transId !== '0' ? String(t.transId) : null,
    message: t.errors?.[0]?.errorText || t.messages?.[0]?.description || r.text || 'Card payment failed', errorCode: t.errors?.[0]?.errorCode || r.code || null };
}
/** What the WooCommerce plugin needs to render Accept.js card fields (public values only). */
function acceptConfig(e) {
  const c = creds(e);
  return { environment: e, available: configured(e) && !!c.clientKey, api_login_id: c.clientKey ? c.loginId : null, client_key: c.clientKey || null, accept_js: config.anet[e].acceptJs, flow: flow() };
}
const capture = (e, transId, amount) => transaction(e, { transactionType: 'priorAuthCaptureTransaction', amount: money(amount), refTransId: String(transId) }, 'Capture failed');
const voidTx = (e, transId) => transaction(e, { transactionType: 'voidTransaction', refTransId: String(transId) }, 'Void failed');
/** Refund a settled transaction: Authorize.Net requires the card's last four digits and "XXXX" as expiry. */
const refund = (e, transId, amount, last4) => transaction(e, { transactionType: 'refundTransaction', amount: money(amount), payment: { creditCard: { cardNumber: String(last4).slice(-4), expirationDate: 'XXXX' } }, refTransId: String(transId) }, 'Refund failed');

/* ---------------- webhooks ---------------- */
/** X-ANET-Signature: sha512=<HEX> where HEX = HMAC-SHA512(signatureKey, rawBody), compared case-insensitively. */
function verifyWebhook(headers, raw) {
  const header = String(headers['x-anet-signature'] || '');
  const m = header.match(/^sha512=([0-9a-fA-F]{128})$/); if (!m) return null;
  for (const e of ENVS) {
    const key = creds(e).signatureKey; if (!key) continue;
    const expected = require('node:crypto').createHmac('sha512', key).update(raw, 'utf8').digest('hex').toUpperCase();
    if (U.safeEqual(expected, m[1].toUpperCase())) return e;
  }
  return null;
}
const WEBHOOK_EVENTS = ['net.authorize.payment.authcapture.created', 'net.authorize.payment.authorization.created', 'net.authorize.payment.capture.created', 'net.authorize.payment.priorAuthCapture.created',
  'net.authorize.payment.refund.created', 'net.authorize.payment.void.created', 'net.authorize.payment.fraud.held', 'net.authorize.payment.fraud.approved', 'net.authorize.payment.fraud.declined'];
/** Register the Digital Hub webhook through Authorize.Net's REST Webhooks API (HTTP Basic = Login ID : Transaction Key). */
async function registerWebhook(e, url, actor) {
  const c = creds(e); if (!c.loginId || !c.transactionKey) throw bad(`Configure ${e} credentials first.`);
  if (!c.signatureKey) throw bad('Add the Signature Key first: without it Digital Hub cannot verify webhook signatures.');
  const auth = 'Basic ' + Buffer.from(`${c.loginId}:${c.transactionKey}`).toString('base64'), base = config.anet[e].rest;
  const hdr = { authorization: auth, 'content-type': 'application/json' };
  const list = await fetch(`${base}/webhooks`, { headers: hdr, signal: AbortSignal.timeout(15000) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) })).catch(err => ({ status: 0, error: err.message }));
  if (list.status === 401) throw new HttpError(401, 'authorize_net_error', 'Authorize.Net rejected the credentials for the Webhooks API.');
  if (list.status !== 200) throw new HttpError(503, 'authorize_net_unreachable', `Webhooks API unavailable (${list.error || 'HTTP ' + list.status}).`);
  const existing = (Array.isArray(list.body) ? list.body : []).find(w => w.url === url);
  let hook = existing;
  if (!existing) {
    const r = await fetch(`${base}/webhooks`, { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'Digital Hub', url, eventTypes: WEBHOOK_EVENTS, status: 'active' }), signal: AbortSignal.timeout(15000) });
    hook = await r.json().catch(() => null);
    if (r.status >= 300) throw new HttpError(400, 'authorize_net_error', `Webhook registration failed (HTTP ${r.status}: ${hook?.message || hook?.reason || 'error'}).`);
  }
  const s = settings(); s[e] = { ...(s[e] || {}), webhook: { id: hook?.webhookId || hook?.id || null, url, status: hook?.status || 'active', at: Date.now(), existed: !!existing } }; saveSettings(s);
  require('./core').audit(actor, 'authorize_net.webhook_registered', e, url);
  return s[e].webhook;
}

/* ---------------- status mapping ---------------- */
/** Authorize.Net transactionStatus → Digital Hub card status and USD settlement status (kept separate on purpose). */
function mapStatus(tx) {
  const st = String(tx.transactionStatus || ''), rc = String(tx.responseCode || '');
  const card = { authorizedPendingCapture: 'authorized', capturedPendingSettlement: 'captured', settledSuccessfully: 'captured', declined: 'declined', voided: 'voided', expired: 'voided',
    FDSPendingReview: 'pending', FDSAuthorizedPendingReview: 'pending', underReview: 'pending', approvedReview: 'authorized', communicationError: 'pending', generalError: 'declined', failedReview: 'declined',
    settlementError: 'captured', refundSettledSuccessfully: 'refunded', refundPendingSettlement: 'refunded', couldNotVoid: 'captured', returnedItem: 'disputed', chargeback: 'disputed' }[st] || (rc === '1' ? 'captured' : rc === '2' ? 'declined' : 'pending');
  const settlement = st === 'settledSuccessfully' ? 'settled' : st === 'settlementError' ? 'failed' : ['capturedPendingSettlement', 'authorizedPendingCapture'].includes(st) ? 'pending' : null;
  return { card, settlement, raw: st, held: /Review/.test(st) };
}

module.exports = { chargeOpaque, acceptConfig, ENVS, creds, configured, envForMode, flow, publicConfig, save, clear, call, testConnection, hostedToken, details, unsettled, settledBatches, batchTransactions, capture, voidTx, refund,
  verifyWebhook, registerWebhook, WEBHOOK_EVENTS, mapStatus, money, cents };
