'use strict';
/* Payment provider adapters. All provider calls happen server-side; credentials come
   from environment variables only and are never sent to browsers or stored in the DB.

   - sandbox card acquirer: test cards only (real card numbers are refused, so no PAN is ever processed)
   - sandbox crypto: simulated addresses / confirmations for test mode
   - binance: Binance Pay Merchant API (live mode, priority crypto rail)
   - coinbase: Coinbase Commerce-style charges API (live mode, alternative rail)

   The live adapters follow the providers' published request-signing schemes. Field names and
   endpoints must be re-verified against current provider documentation before go-live. */
const crypto = require('node:crypto');
const config = require('./config');
const { rid } = require('./util');

const NETWORKS = {
  TRON: { label: 'TRON (TRC-20)', confirmations: 19, payoutFeeUSD: 1.0, assets: ['USDT'], addr: 'tron' },
  ETH: { label: 'Ethereum (ERC-20)', confirmations: 12, payoutFeeUSD: 4.5, assets: ['USDT', 'USDC'], addr: 'evm' },
  BSC: { label: 'BNB Smart Chain (BEP-20)', confirmations: 15, payoutFeeUSD: 0.3, assets: ['USDT', 'USDC'], addr: 'evm' },
  POLYGON: { label: 'Polygon PoS', confirmations: 30, payoutFeeUSD: 0.1, assets: ['USDT', 'USDC'], addr: 'evm' },
  SOLANA: { label: 'Solana (SPL)', confirmations: 32, payoutFeeUSD: 0.05, assets: ['USDT', 'USDC'], addr: 'sol' },
  BASE: { label: 'Base', confirmations: 10, payoutFeeUSD: 0.1, assets: ['USDC'], addr: 'evm' },
  BINANCE_PAY: { label: 'Binance Pay (account transfer)', confirmations: 1, payoutFeeUSD: 0, assets: ['USDT', 'USDC'], addr: 'binance', internal: true },
};
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function genAddress(network) {
  const k = NETWORKS[network].addr;
  if (k === 'tron') return 'T' + rid(33, B58);
  if (k === 'evm') return '0x' + rid(40, '0123456789abcdef');
  if (k === 'sol') return rid(44, B58);
  return rid(9, '123456789');
}
function validAddress(network, a) {
  const k = NETWORKS[network]?.addr; a = String(a || '');
  if (k === 'tron') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
  if (k === 'evm') return /^0x[0-9a-fA-F]{40}$/.test(a);
  if (k === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  if (k === 'binance') return /^\d{6,12}$/.test(a);
  return false;
}

const TEST_CARDS = {
  '4242424242424242': { brand: 'Visa', country: 'US', outcome: 'success', threeDS: 'frictionless', exemption: true, label: 'Success' },
  '5555555555554444': { brand: 'Mastercard', country: 'US', outcome: 'success', threeDS: 'frictionless', exemption: true, label: 'Success · eligible for non-3DS' },
  '4000000000003220': { brand: 'Visa', country: 'GB', outcome: 'success', threeDS: 'challenge', exemption: false, label: '3DS challenge (UK issuer)' },
  '5200828282828210': { brand: 'Mastercard', country: 'DE', outcome: 'success', threeDS: 'frictionless', exemption: true, label: 'EU issuer · low-value exemption' },
  '4000008400001629': { brand: 'Visa', country: 'US', outcome: 'decline_after_3ds', threeDS: 'challenge', exemption: false, label: '3DS challenge, then declined' },
  '4000000000000002': { brand: 'Visa', country: 'US', outcome: 'card_declined', threeDS: 'frictionless', exemption: true, label: 'Declined · generic' },
  '4000000000009995': { brand: 'Visa', country: 'US', outcome: 'insufficient_funds', threeDS: 'frictionless', exemption: true, label: 'Declined · insufficient funds' },
};
const SCA = new Set(['GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'IE', 'BE', 'AT', 'PT', 'SE', 'FI', 'DK', 'PL', 'NO']);

const CardSandbox = {
  authorize({ number, threeDSResult }) {
    const tc = TEST_CARDS[number];
    if (threeDSResult === 'failed') return { ok: false, code: 'authentication_failed', message: '3DS authentication failed' };
    if (tc?.outcome === 'card_declined') return { ok: false, code: 'card_declined', message: 'Issuer declined (05 · do not honor)' };
    if (tc?.outcome === 'insufficient_funds') return { ok: false, code: 'insufficient_funds', message: 'Insufficient funds (51)' };
    if (tc?.outcome === 'decline_after_3ds') return { ok: false, code: 'card_declined', message: 'Issuer declined after authentication' };
    return { ok: true, authCode: rid(6, '0123456789') };
  },
};

async function httpJson(url, { method = 'POST', headers = {}, body }) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body, signal: ctrl.signal });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, json };
  } finally { clearTimeout(t); }
}

/* ---- Binance Pay ---- */
const BinancePay = {
  id: 'binance', name: 'Binance Pay', networks: ['BINANCE_PAY'],
  configured: () => !!(config.binance.apiKey && config.binance.secretKey),
  webhookConfigured: () => !!config.binance.publicKey,
  sign(body) {
    const ts = String(Date.now()), nonce = rid(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
    const sig = crypto.createHmac('sha512', config.binance.secretKey).update(`${ts}\n${nonce}\n${body}\n`).digest('hex').toUpperCase();
    return { 'BinancePay-Timestamp': ts, 'BinancePay-Nonce': nonce, 'BinancePay-Certificate-SN': config.binance.apiKey, 'BinancePay-Signature': sig };
  },
  async call(path, payload) {
    if (!this.configured()) throw new Error('Binance Pay credentials are not configured on the server.');
    const body = JSON.stringify(payload);
    const { status, json } = await httpJson(config.binance.base + path, { headers: this.sign(body), body });
    if (status !== 200 || json.status !== 'SUCCESS') throw new Error(`Binance Pay error ${json.code || status}: ${json.errorMessage || 'request failed'}`);
    return json.data;
  },
  /** Create a hosted Binance Pay order. tradeNo must be alphanumeric (≤32). */
  async createOrder({ tradeNo, amount, asset, description, returnUrl, cancelUrl }) {
    const d = await this.call('/binancepay/openapi/v3/order', {
      env: { terminalType: 'WEB' }, merchantTradeNo: tradeNo, orderAmount: +(amount / 100).toFixed(2), currency: asset,
      description: description.slice(0, 256), goodsDetails: [{ goodsType: '02', goodsCategory: 'Z000', referenceGoodsId: tradeNo, goodsName: description.slice(0, 256) }],
      returnUrl, cancelUrl, webhookUrl: `${config.publicUrl}/hooks/binance-pay`,
    });
    return { providerRef: d.prepayId, checkoutUrl: d.checkoutUrl || d.universalUrl, qrContent: d.qrContent, expiresAt: d.expireTime };
  },
  /** Verify a notification: RSA-SHA256 over "timestamp\nnonce\nbody\n" with Binance's published public key. */
  verifyWebhook(headers, raw) {
    if (!this.webhookConfigured()) return false;
    const ts = headers['binancepay-timestamp'], nonce = headers['binancepay-nonce'], sig = headers['binancepay-signature'];
    if (!ts || !nonce || !sig) return false;
    if (Math.abs(Date.now() - Number(ts)) > 5 * 60000) return false;
    try { return crypto.createVerify('RSA-SHA256').update(`${ts}\n${nonce}\n${raw}\n`).verify(config.binance.publicKey, sig, 'base64'); } catch { return false; }
  },
  parseWebhook(json) {
    const data = typeof json.data === 'string' ? JSON.parse(json.data) : (json.data || {});
    return { eventId: `${json.bizId}:${json.bizStatus}`, tradeNo: data.merchantTradeNo, status: json.bizStatus === 'PAY_SUCCESS' ? 'paid' : json.bizStatus === 'PAY_CLOSED' ? 'expired' : 'other',
      amount: data.totalFee != null ? Math.round(Number(data.totalFee) * 100) : null, asset: data.currency, raw: json.bizStatus };
  },
  webhookAck: () => ({ returnCode: 'SUCCESS', returnMessage: null }),
};

/* ---- Coinbase (Commerce-style charges) ---- */
const Coinbase = {
  id: 'coinbase', name: 'Coinbase Business', networks: ['ETH', 'BASE', 'POLYGON', 'SOLANA'],
  configured: () => !!config.coinbase.apiKey,
  webhookConfigured: () => !!config.coinbase.webhookSecret,
  async createCharge({ paymentId, amount, currency, description, returnUrl, cancelUrl }) {
    if (!this.configured()) throw new Error('Coinbase credentials are not configured on the server.');
    const { status, json } = await httpJson(`${config.coinbase.base}/charges`, {
      headers: { 'X-CC-Api-Key': config.coinbase.apiKey, 'X-CC-Version': '2018-03-22' },
      body: JSON.stringify({ name: description.slice(0, 100), description: description.slice(0, 200), pricing_type: 'fixed_price', local_price: { amount: (amount / 100).toFixed(2), currency }, metadata: { dh_payment_id: paymentId }, redirect_url: returnUrl, cancel_url: cancelUrl }),
    });
    if (status >= 300 || !json.data) throw new Error(`Coinbase error ${status}: ${json.error?.message || 'request failed'}`);
    return { providerRef: json.data.code || json.data.id, checkoutUrl: json.data.hosted_url, expiresAt: json.data.expires_at };
  },
  verifyWebhook(headers, raw) {
    const sig = headers['x-cc-webhook-signature']; if (!sig || !this.webhookConfigured()) return false;
    const exp = crypto.createHmac('sha256', config.coinbase.webhookSecret).update(raw).digest('hex');
    return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
  },
  parseWebhook(json) {
    const e = json.event || {}, d = e.data || {};
    const paid = (d.payments || []).find(p => p.status === 'CONFIRMED');
    return { eventId: e.id, paymentId: d.metadata?.dh_payment_id, status: e.type === 'charge:confirmed' ? 'paid' : e.type === 'charge:failed' ? 'expired' : 'other',
      amount: paid ? Math.round(Number(paid.value?.local?.amount) * 100) : null, raw: e.type };
  },
};

const CRYPTO = {
  sandbox: { id: 'sandbox', name: 'Sandbox simulator', networks: ['TRON', 'ETH', 'BSC', 'POLYGON', 'SOLANA', 'BASE', 'BINANCE_PAY'] },
  binance: BinancePay, coinbase: Coinbase,
};
const PROVIDER_INFO = [
  { id: 'card_acquirer', kind: 'card', name: 'Card acquirer', note: 'Visa / Mastercard. Not connected: choose a non-Stripe acquirer or PSP (e.g. Checkout.com, Nuvei, Adyen, Worldpay) and add an adapter. Sandbox uses test cards only.' },
  { id: 'binance', kind: 'crypto', name: 'Binance Pay', note: 'Priority crypto rail. USDT / USDC from Binance accounts via QR or app. Needs a Binance Pay merchant account for Digital Hub and confirmation of the sub-merchant model.' },
  { id: 'coinbase', kind: 'crypto', name: 'Coinbase Business', note: 'Alternative crypto rail (USDC-led, on-chain). Confirm country eligibility and the current API before go-live.' },
  { id: 'soneri', kind: 'bank', name: 'Soneri Bank (Pakistan)', note: 'PKR payouts over Raast / IBFT. Payouts are executed by treasury and recorded here until a bank API is agreed.' },
];

module.exports = { NETWORKS, genAddress, validAddress, TEST_CARDS, SCA, CardSandbox, CRYPTO, BinancePay, Coinbase, PROVIDER_INFO };
