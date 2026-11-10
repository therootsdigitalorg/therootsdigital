'use strict';
/* Digital Hub Node.js SDK — zero dependencies (Node 18+ for global fetch).
   const DigitalHub = require('./digitalhub');
   const dh = new DigitalHub(process.env.DH_SECRET_KEY, { baseUrl: 'https://pay.example.com' }); */
const crypto = require('node:crypto');

class DigitalHubError extends Error {
  constructor(status, err) { super(err?.message || `HTTP ${status}`); this.status = status; this.code = err?.code; this.type = err?.type; }
}

class DigitalHub {
  constructor(secretKey, { baseUrl, timeoutMs = 20000 } = {}) {
    if (!/^dh_(test|live)_sk_/.test(secretKey || '')) throw new Error('Pass a Digital Hub secret key (dh_test_sk_… or dh_live_sk_…).');
    if (!baseUrl) throw new Error('Pass { baseUrl } — your Digital Hub URL.');
    this.key = secretKey; this.base = baseUrl.replace(/\/$/, '') + '/v1'; this.timeoutMs = timeoutMs;
    const r = (m, p, b, o) => this.request(m, p, b, o);
    this.checkout = { create: (b, o) => r('POST', '/checkout/sessions', b, o), retrieve: id => r('GET', `/checkout/sessions/${id}`), list: q => r('GET', '/checkout/sessions', null, { query: q }) };
    this.payments = { retrieve: id => r('GET', `/payments/${id}`), list: q => r('GET', '/payments', null, { query: q }), capture: (id, o) => r('POST', `/payments/${id}/capture`, {}, o), cancel: (id, o) => r('POST', `/payments/${id}/cancel`, {}, o) };
    this.refunds = { create: (b, o) => r('POST', '/refunds', b, o), retrieve: id => r('GET', `/refunds/${id}`), list: q => r('GET', '/refunds', null, { query: q }) };
    this.paymentLinks = { create: (b, o) => r('POST', '/payment_links', b, o), list: q => r('GET', '/payment_links', null, { query: q }), deactivate: id => r('POST', `/payment_links/${id}/deactivate`, {}) };
    this.balance = { retrieve: () => r('GET', '/balance') };
    this.payouts = { create: (b, o) => r('POST', '/payouts', b, o), list: q => r('GET', '/payouts', null, { query: q }) };
    this.events = { retrieve: id => r('GET', `/events/${id}`), list: q => r('GET', '/events', null, { query: q }) };
    this.webhookEndpoints = { create: b => r('POST', '/webhook_endpoints', b), list: () => r('GET', '/webhook_endpoints'), del: id => r('DELETE', `/webhook_endpoints/${id}`) };
  }
  async request(method, path, body, { idempotencyKey, query } = {}) {
    const url = this.base + path + (query ? '?' + new URLSearchParams(query) : '');
    const headers = { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', 'User-Agent': 'digitalhub-node/1.0' };
    if (method === 'POST') headers['Idempotency-Key'] = idempotencyKey || crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, { method, headers, body: body && method !== 'GET' ? JSON.stringify(body) : undefined, signal: ctrl.signal });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return data;
        if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; } // safe: same Idempotency-Key
        throw new DigitalHubError(res.status, data.error);
      } catch (e) {
        if (e instanceof DigitalHubError) throw e;
        if (attempt < 2) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
        throw e;
      } finally { clearTimeout(t); }
    }
  }
  /** Verify a webhook. rawBody must be the exact request body string/Buffer. Returns the parsed event or throws. */
  static constructEvent(rawBody, signatureHeader, secret, toleranceSec = 300) {
    const parts = Object.fromEntries(String(signatureHeader || '').split(',').map(p => p.split('=')));
    if (!parts.t || !parts.v1) throw new Error('Missing DigitalHub-Signature');
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(parts.v1);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Signature mismatch');
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) throw new Error('Signature timestamp outside tolerance');
    return JSON.parse(String(rawBody));
  }
}
module.exports = DigitalHub;
module.exports.DigitalHubError = DigitalHubError;
