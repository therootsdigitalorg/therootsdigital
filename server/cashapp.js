'use strict';
/* Cash App Pay Partner API adapter: Network API, Customer Request API and Management API.
   Paths, fields and request signing follow the official reference at developers.cash.app
   (OpenAPI 1.0.0, /network/v1, /customer-request/v1, /management/v1). Credentials come only from
   the server environment; nothing secret is sent to browsers.

   Test mode talks to the Cash App sandbox when sandbox credentials are set. Without them it uses a
   local simulator that mirrors the sandbox's documented magic amounts, so the full flow can be
   exercised before Cash App issues credentials. Simulated objects use "_sim_" IDs and are labelled. */
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./db');
const U = require('./util');

const BASES = { test: 'https://sandbox.api.cash.app', live: 'https://api.cash.app' };
const SKIP_SIGNATURE = 'sandbox:skip-signature-check';

class CashAppError extends Error {
  constructor(status, code, message, category, retryable = false) { super(message); this.status = status; this.code = code; this.category = category; this.retryable = retryable; }
}

const creds = mode => (mode === 'live' ? config.cashapp.live : config.cashapp.sandbox);
/** Real Cash App credentials present for this mode (Network API needs client ID + API key ID; live also needs the signing secret). */
const configured = mode => { const c = creds(mode); return !!(c.clientId && c.keyId && (mode === 'test' || c.keySecret)); };
const simulated = mode => mode === 'test' && !configured('test');
const environmentLabel = mode => mode === 'live' ? 'Cash App production' : simulated(mode) ? 'Local simulator (no Cash App sandbox credentials)' : 'Cash App sandbox';

/* ---------- request signing (Signing Requests guide) ----------
   canonical = METHOD \n path(+query) \n headers \n sha256hex(body)
   headers   = "name:value\n" for Accept, Authorization, Content-Type, Host (when present)
   X-Signature: "V1 " + hex(HMAC-SHA256(api key secret, canonical)) */
function canonical(method, pathWithQuery, headers, body) {
  const pick = ['accept', 'authorization', 'content-type', 'host'];
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const lines = pick.filter(h => lower[h] != null && lower[h] !== '').map(h => `${h}:${String(lower[h]).trim()}\n`).join('');
  const digest = crypto.createHash('sha256').update(body || '').digest('hex');
  return `${method.toUpperCase()}\n${pathWithQuery}\n${lines}\n${digest}`;
}
const signature = (secret, method, path, headers, body) => 'V1 ' + crypto.createHmac('sha256', secret).update(canonical(method, path, headers, body)).digest('hex');

/** Verify an inbound Cash App webhook (Webhook Signature Generation guide). raw = exact request body. */
function verifyWebhook(mode, { method, path, headers, raw }) {
  const secret = creds(mode).webhookSecret;
  const got = String(headers['x-signature'] || '');
  if (!secret || !got.startsWith('V1 ')) return false;
  const expected = signature(secret, method, path, headers, raw);
  return expected.length === got.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

/* ---------- API call log (no secrets, no request bodies) ---------- */
function logCall(entry) {
  try { store.put('api_logs', { id: U.id('log'), status: entry.ok ? 'ok' : 'error', ...entry }); } catch { /* logging must never break a payment */ }
}

async function http(mode, api, method, path, body, { mid, op } = {}) {
  const c = creds(mode);
  const url = new URL(`${c.base || BASES[mode]}/${api}/v1${path}`);
  const payload = body ? JSON.stringify(body) : '';
  const headers = { Accept: 'application/json', 'User-Agent': config.cashapp.userAgent };
  if (payload) headers['Content-Type'] = 'application/json';
  if (api === 'customer-request') headers.Authorization = `Client ${c.clientId}`;
  else {
    headers.Authorization = `Client ${c.clientId} ${c.keyId}`;
    headers['X-Region'] = config.cashapp.region;
    headers['X-Signature'] = c.keySecret ? signature(c.keySecret, method, url.pathname + url.search, { ...headers, Host: url.host }, payload) : SKIP_SIGNATURE;
  }
  const started = Date.now(), ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
  let res, text;
  try { res = await fetch(url, { method, headers, body: payload || undefined, signal: ctrl.signal }); text = await res.text(); }
  catch (e) {
    logCall({ merchant_id: mid || null, mode, op, method, path: `/${api}/v1${path}`, http: null, ms: Date.now() - started, ok: false, error: e.name === 'AbortError' ? 'timeout' : 'network_error' });
    throw new CashAppError(502, 'cashapp_unreachable', 'Could not reach Cash App. The request will be retried.', 'API_ERROR', true);
  } finally { clearTimeout(timer); }
  let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  const err = json.errors?.[0];
  logCall({ merchant_id: mid || null, mode, op, method, path: `/${api}/v1${path}`, http: res.status, ms: Date.now() - started, ok: res.ok, error: err ? `${err.category}/${err.code}` : null });
  if (!res.ok) throw new CashAppError(res.status, err?.code || 'cashapp_error', err?.detail || `Cash App returned HTTP ${res.status}.`, err?.category, res.status >= 500 || res.status === 429);
  return json;
}

/* ---------- real API ---------- */
const real = mode => ({
  listMerchants: (o) => http(mode, 'network', 'GET', '/merchants?limit=1', null, o),
  createBrand: (b, o) => http(mode, 'network', 'POST', '/brands', b, o).then(r => r.brand),
  createMerchant: (b, o) => http(mode, 'network', 'POST', '/merchants', b, o).then(r => r.merchant),
  retrieveMerchant: (id, o) => http(mode, 'network', 'GET', `/merchants/${encodeURIComponent(id)}`, null, o).then(r => r.merchant),
  createCustomerRequest: (b, o) => http(mode, 'customer-request', 'POST', '/requests', b, o).then(r => r.request),
  retrieveCustomerRequest: (id, o) => http(mode, 'customer-request', 'GET', `/requests/${encodeURIComponent(id)}`, null, o).then(r => r.request),
  createPayment: (b, o) => http(mode, 'network', 'POST', '/payments', b, o).then(r => r.payment),
  retrievePayment: (id, o) => http(mode, 'network', 'GET', `/payments/${encodeURIComponent(id)}`, null, o).then(r => r.payment),
  capturePayment: (id, b, o) => http(mode, 'network', 'POST', `/payments/${encodeURIComponent(id)}/capture`, b, o).then(r => r.payment),
  voidPayment: (id, o) => http(mode, 'network', 'POST', `/payments/${encodeURIComponent(id)}/void`, null, o).then(r => r.payment),
  createRefund: (b, o) => http(mode, 'network', 'POST', '/refunds', b, o).then(r => r.refund),
  retrieveRefund: (id, o) => http(mode, 'network', 'GET', `/refunds/${encodeURIComponent(id)}`, null, o).then(r => r.refund),
  acceptDispute: (id, o) => http(mode, 'network', 'POST', `/disputes/${encodeURIComponent(id)}/accept`, null, o).then(r => r.dispute),
  challengeDispute: (id, o) => http(mode, 'network', 'POST', `/disputes/${encodeURIComponent(id)}/challenge`, null, o).then(r => r.dispute),
  createDisputeEvidenceText: (id, b, o) => http(mode, 'network', 'POST', `/disputes/${encodeURIComponent(id)}/evidence-text`, b, o),
  createWebhookEndpoint: (b, o) => http(mode, 'management', 'POST', '/webhook-endpoints', b, o).then(r => r.webhook_endpoint),
});

/* ---------- local simulator (test mode without sandbox credentials) ----------
   Mirrors the Developer Sandbox guide: payment amounts 7770–7776 decline, 6670 creates the payment
   but returns a connection error; refunds 7770/7772–7775 decline; payment amounts 8801–8823 open a dispute. */
const PAYMENT_DECLINES = { 7770: 'compliance', 7771: 'insufficient_funds', 7772: 'other', 7773: 'risk', 7774: 'too_large', 7775: 'too_small', 7776: 'limit_reached' };
const REFUND_DECLINES = { 7770: 'compliance', 7772: 'other', 7773: 'risk', 7774: 'too_large', 7775: 'too_small' };
const DISPUTE_REASONS = { 8801: 'CD10', 8802: 'CD11', 8803: 'CD13', 8804: 'CD13', 8811: 'FR10', 8812: 'FR11', 8821: 'PE10', 8822: 'PE11', 8823: 'PE12' };
const iso = (t = Date.now()) => new Date(t).toISOString();
const simGet = k => { const r = store.byKey('cashapp_sim', k); return r ? r.obj : null; };
const simPut = (k, obj, kind) => { const ex = store.byKey('cashapp_sim', k); store.put('cashapp_sim', { id: ex?.id || U.id('sim'), k, status: kind, obj }); return obj; };
let simEventSink = null;
const simEvent = (type, object) => { if (simEventSink) simEventSink({ type, event_id: U.id('SIMEVT'), created_at: iso(), data: { id: Object.values(object)[0].id, type: Object.keys(object)[0], object } }); };
function simIdem(key, make) { const hit = simGet('idem:' + key); if (hit) return simGet(hit.ref); const o = make(); simPut('idem:' + key, { ref: o.id }, 'idem'); return o; }
const simErr = (status, code, detail, category = 'INVALID_REQUEST_ERROR') => new CashAppError(status, code, detail, category);

const sim = {
  listMerchants: async () => ({ merchants: [] }),
  createBrand: async b => simIdem(b.idempotency_key, () => { const id = `BRAND_sim_${U.rid(16)}`; return simPut(id, { id, ...b.brand, created_at: iso(), updated_at: iso() }, 'brand'); }),
  async createMerchant(b) {
    return simIdem(b.idempotency_key, () => { const id = `MMI_sim_${U.rid(16)}`; return simPut(id, { id, ...b.merchant, status: 'ACTIVE', created_at: iso(), updated_at: iso() }, 'merchant'); });
  },
  async retrieveMerchant(id) { const m = simGet(id); if (!m) throw simErr(404, 'NOT_FOUND', 'Merchant not found'); return m; },
  async createCustomerRequest(b) {
    return simIdem(b.idempotency_key, () => {
      const id = `GRR_sim_${U.rid(20)}`, a = b.request.actions[0];
      return simPut(id, { id, status: 'PENDING', actions: b.request.actions, channel: b.request.channel, reference_id: b.request.reference_id, redirect_url: b.request.redirect_url || '',
        auth_flow_triggers: { qr_code_image_url: null, qr_code_svg_url: null, mobile_url: `${config.publicUrl}/cashapp-sim/${id}`, desktop_url: `${config.publicUrl}/cashapp-sim/${id}`, refreshes_at: iso(Date.now() + 30000) },
        origin: { type: 'DIRECT' }, created_at: iso(), updated_at: iso(), expires_at: iso(Date.now() + 10 * 60000), grants: [], _amount: a.amount }, 'request');
    });
  },
  async retrieveCustomerRequest(id) {
    const r = simGet(id); if (!r) throw simErr(404, 'NOT_FOUND', 'Customer request not found');
    if (r.status === 'PENDING' && Date.now() > Date.parse(r.expires_at)) { r.status = 'DECLINED'; r.updated_at = iso(); simPut(id, r, 'request'); simEvent('customer_request.state.updated', { request: r }); }
    if (r.status === 'PENDING') { r.auth_flow_triggers.refreshes_at = iso(Date.now() + 30000); simPut(id, r, 'request'); }
    return r;
  },
  /** Simulated customer decision in the "Cash App" approval screen. */
  decide(id, approve) {
    const r = simGet(id); if (!r || r.status !== 'PENDING') throw simErr(409, 'REQUEST_NOT_PENDING', 'This request is no longer pending.');
    r.status = approve ? 'APPROVED' : 'DECLINED'; r.updated_at = iso();
    if (approve) r.grants = r.actions.map(a => ({ id: `GRG_sim_${U.rid(20)}`, customer_id: 'C_sim_customer', request_id: id, action: a, status: 'ACTIVE', type: 'ONE_TIME', created_at: iso(), updated_at: iso() }));
    simPut(id, r, 'request'); simEvent('customer_request.state.updated', { request: r }); return r;
  },
  async createPayment(b) {
    const existing = simGet('idem:' + b.idempotency_key);
    const p = simIdem(b.idempotency_key, () => {
      const q = b.payment, id = `PWC_sim_${U.rid(20)}`;
      const grant = Object.values(store.list('cashapp_sim', { status: 'request' }, { limit: 5000 })).map(x => x.obj).flatMap(r => r.grants || []).find(g => g.id === q.grant_id);
      if (q.grant_id !== 'GRG_sandbox:active' && (!grant || grant.status !== 'ACTIVE')) throw simErr(400, 'GRANT_INVALID', 'Grant is missing, consumed or expired.', 'GRANT_ERROR');
      if (grant) { grant.status = 'CONSUMED'; const r = simGet(grant.request_id); r.grants = r.grants.map(g => g.id === grant.id ? grant : g); simPut(r.id, r, 'request'); }
      const decline = PAYMENT_DECLINES[q.amount];
      const fee = Math.round(q.amount * 0.0275);
      const pay = { id, amount: q.amount, currency: q.currency, merchant_id: q.merchant_id, grant_id: q.grant_id, reference_id: q.reference_id, customer_id: 'C_sim_customer', metadata: q.metadata,
        status: decline ? 'DECLINED' : q.capture === false ? 'AUTHORIZED' : 'CAPTURED', captured_amount: !decline && q.capture !== false ? q.amount : 0, voided_amount: 0, refunded_amount: 0,
        net_amount: decline ? 0 : q.amount - fee, fee_amount: decline ? 0 : fee, refund_ids: [], decline_errors: decline ? [{ category: 'PAYMENT_PROCESSING_ERROR', code: `SANDBOX_${decline.toUpperCase()}`, detail: `Sandbox decline: ${decline.replace(/_/g, ' ')}` }] : [],
        capture_before: iso(Date.now() + 7 * 86400000), created_at: iso(), updated_at: iso() };
      simPut(id, pay, 'payment');
      if (DISPUTE_REASONS[q.amount] && !decline) simPut(`DSP_sim_${U.rid(16)}`, { pending_for: id }, 'pending_dispute');
      return pay;
    });
    if (!existing && b.payment.amount === 6670) throw new CashAppError(502, 'cashapp_unreachable', 'Simulated connection error (sandbox amount 6670).', 'API_ERROR', true);
    return p;
  },
  async retrievePayment(id) { const p = simGet(id); if (!p) throw simErr(404, 'NOT_FOUND', 'Payment not found'); return p; },
  async capturePayment(id, b) {
    const p = await sim.retrievePayment(id);
    if (p.status !== 'AUTHORIZED') throw simErr(409, 'PAYMENT_NOT_AUTHORIZED', 'Only authorized payments can be captured.');
    if (b.amount > p.amount) throw simErr(400, 'AMOUNT_TOO_LARGE', 'Capture amount exceeds the authorized amount.');
    Object.assign(p, { status: 'CAPTURED', captured_amount: b.amount, updated_at: iso() }); simPut(id, p, 'payment'); simEvent('payment.status.updated', { payment: p }); return p;
  },
  async voidPayment(id) {
    const p = await sim.retrievePayment(id);
    if (p.status !== 'AUTHORIZED') throw simErr(409, 'PAYMENT_NOT_AUTHORIZED', 'Only authorized payments can be voided.');
    Object.assign(p, { status: 'VOIDED', voided_amount: p.amount, updated_at: iso() }); simPut(id, p, 'payment'); simEvent('payment.status.updated', { payment: p }); return p;
  },
  async createRefund(b) {
    const existing = simGet('idem:' + b.idempotency_key);
    const r = simIdem(b.idempotency_key, () => {
      const q = b.refund, p = simGet(q.payment_id), id = `PWCR_sim_${U.rid(20)}`;
      if (!p || p.status !== 'CAPTURED') throw simErr(400, 'PAYMENT_NOT_CAPTURED', 'Refunds need a captured payment.');
      if (q.amount > p.captured_amount - p.refunded_amount) throw simErr(400, 'AMOUNT_TOO_LARGE', 'Refund exceeds the refundable amount.');
      const decline = REFUND_DECLINES[q.amount];
      const refund = { id, amount: q.amount, currency: q.currency, merchant_id: q.merchant_id, payment_id: q.payment_id, customer_id: p.customer_id, reference_id: q.reference_id,
        status: decline ? 'DECLINED' : q.capture === false ? 'AUTHORIZED' : 'CAPTURED', created_at: iso(), updated_at: iso() };
      if (refund.status === 'CAPTURED') { p.refunded_amount += q.amount; p.refund_ids.push(id); simPut(p.id, p, 'payment'); }
      return simPut(id, refund, 'refund');
    });
    if (!existing && b.refund.amount === 6670) throw new CashAppError(502, 'cashapp_unreachable', 'Simulated connection error (sandbox amount 6670).', 'API_ERROR', true);
    return r;
  },
  async retrieveRefund(id) { const r = simGet(id); if (!r) throw simErr(404, 'NOT_FOUND', 'Refund not found'); return r; },
  async acceptDispute(id) { const d = simGet(id); if (!d) throw simErr(404, 'NOT_FOUND', 'Dispute not found'); Object.assign(d, { state: 'ACCEPTED', updated_at: iso() }); simPut(id, d, 'dispute'); simEvent('dispute.state.updated', { dispute: d }); return d; },
  async challengeDispute(id) { const d = simGet(id); if (!d) throw simErr(404, 'NOT_FOUND', 'Dispute not found'); Object.assign(d, { state: 'PROCESSING', updated_at: iso() }); simPut(id, d, 'dispute'); simEvent('dispute.state.updated', { dispute: d }); return d; },
  async createDisputeEvidenceText(id, b) { if (!simGet(id)) throw simErr(404, 'NOT_FOUND', 'Dispute not found'); return { evidence: { id: `DEV_sim_${U.rid(12)}`, dispute_id: id, ...b.evidence } }; },
  async createWebhookEndpoint() { throw simErr(400, 'SIMULATOR', 'Webhook endpoints are registered with Cash App, not the local simulator.'); },
  /** Opens disputes for payments made with the documented dispute amounts (2 s after the payment, like the sandbox). */
  runDisputes() {
    for (const row of store.list('cashapp_sim', { status: 'pending_dispute' }, { limit: 200 })) {
      const p = simGet(row.obj.pending_for); if (!p || Date.now() - Date.parse(p.created_at) < 2000) continue;
      const d = { id: row.k, payment_id: p.id, amount: p.captured_amount, customer_credited_amount: null, reason: DISPUTE_REASONS[p.amount], settlement_withholding: 'NOT_WITHHELD', state: 'RESPONSE_REQUIRED',
        created_at: iso(), updated_at: iso(), response_due_at: iso(Date.now() + 7 * 86400000), merchant_id: p.merchant_id };
      store.put('cashapp_sim', { ...row, status: 'dispute', obj: d }); simEvent('dispute.created', { dispute: d });
    }
  },
  /** Test helper: settle a simulated dispute (sandbox uses evidence metadata sandbox:set_dispute_state). */
  setDisputeState(id, state) { const d = simGet(id); if (!d) throw simErr(404, 'NOT_FOUND', 'Dispute not found'); Object.assign(d, { state, updated_at: iso() }); simPut(id, d, 'dispute'); simEvent('dispute.state.updated', { dispute: d }); return d; },
};
const client = mode => (simulated(mode) ? sim : real(mode));

module.exports = { CashAppError, client, configured, simulated, environmentLabel, verifyWebhook, signature, canonical, sim, setSimEventSink: fn => { simEventSink = fn; }, PAYMENT_DECLINES, REFUND_DECLINES };
